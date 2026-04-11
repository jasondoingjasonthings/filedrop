import { EventEmitter } from 'events';
import type Database from 'better-sqlite3';
import type {
  Transfer,
  NewTransfer,
  TransferStatus,
  TransferFilters,
  TransferStats,
  QueueEventMap,
} from './types.js';

export declare interface TransferQueue {
  on<K extends keyof QueueEventMap>(
    event: K,
    listener: (...args: QueueEventMap[K]) => void
  ): this;
  emit<K extends keyof QueueEventMap>(
    event: K,
    ...args: QueueEventMap[K]
  ): boolean;
}

export class TransferQueue extends EventEmitter {
  private readonly concurrency: number;

  constructor(private readonly db: Database.Database, opts: { concurrency: number }) {
    super();
    this.concurrency = opts.concurrency;
  }

  // ─── Write operations ──────────────────────────────────────────────────────

  enqueue(transfer: NewTransfer): Transfer {
    const stmt = this.db.prepare<
      [string, string, string, number, string, string, number, string | null, string | null],
      Transfer
    >(`
      INSERT INTO transfers
        (filename, local_path, source_path, size_bytes, md5, direction, priority, progress, project, peer_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      RETURNING *
    `);

    const row = stmt.get(
      transfer.filename,
      transfer.local_path,
      transfer.source_path,
      transfer.size_bytes,
      transfer.md5,
      transfer.direction,
      transfer.priority,
      transfer.project ?? null,
      transfer.peer_name ?? null
    );

    if (!row) throw new Error('Failed to enqueue transfer');
    const t = this.rowToTransfer(row);
    this.emit('enqueued', t);
    return t;
  }

  dequeue(): Transfer | null {
    const active = this.countByStatus('active');
    if (active >= this.concurrency) return null;

    const stmt = this.db.prepare<[], Transfer>(`
      UPDATE transfers
      SET status = 'active', started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = (
        SELECT id FROM transfers
        WHERE status = 'queued'
        ORDER BY priority ASC, id ASC
        LIMIT 1
      )
      RETURNING *
    `);

    const row = stmt.get();
    if (!row) return null;

    const t = this.rowToTransfer(row);
    this.emit('started', t);
    return t;
  }

  pause(id: number): void {
    this.db
      .prepare(`UPDATE transfers SET status = 'paused' WHERE id = ? AND status = 'active'`)
      .run(id);
    this.emit('paused', id);
  }

  resume(id: number): void {
    this.db
      .prepare(`UPDATE transfers SET status = 'queued' WHERE id = ? AND status = 'paused'`)
      .run(id);
    this.emit('resumed', id);
  }

  cancel(id: number): void {
    this.db
      .prepare(
        `UPDATE transfers SET status = 'error', error = 'Cancelled by user'
         WHERE id = ? AND status NOT IN ('done', 'error')`
      )
      .run(id);
    this.emit('cancelled', id);
  }

  updateProgress(id: number, progress: number): void {
    this.db
      .prepare(`UPDATE transfers SET progress = ? WHERE id = ?`)
      .run(Math.min(100, Math.max(0, progress)), id);
    this.emit('progress', id, progress);
  }

  complete(id: number): void {
    const stmt = this.db.prepare<[number], Transfer>(`
      UPDATE transfers
      SET status = 'done',
          progress = 100,
          finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(id);
    if (row) this.emit('completed', this.rowToTransfer(row));
  }

  fail(id: number, error: string): void {
    const stmt = this.db.prepare<[string, number], Transfer>(`
      UPDATE transfers
      SET status = 'error',
          error = ?,
          retry_count = retry_count + 1,
          finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
      RETURNING *
    `);
    const row = stmt.get(error, id);
    if (row) this.emit('failed', this.rowToTransfer(row));
  }

  retry(id: number): void {
    this.db.prepare(`
      UPDATE transfers
      SET status = 'queued', error = NULL, progress = 0
      WHERE id = ? AND status = 'error'
    `).run(id);
  }

  updatePriority(id: number, priority: number): void {
    this.db
      .prepare(`UPDATE transfers SET priority = ? WHERE id = ?`)
      .run(priority, id);
  }

  // ─── Read operations ───────────────────────────────────────────────────────

  getById(id: number): Transfer | null {
    const row = this.db
      .prepare<[number], Transfer>(`SELECT * FROM transfers WHERE id = ?`)
      .get(id);
    return row ? this.rowToTransfer(row) : null;
  }

  getAll(filters: TransferFilters = {}): Transfer[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.status) {
      conditions.push('status = ?');
      params.push(filters.status);
    }
    if (filters.direction) {
      conditions.push('direction = ?');
      params.push(filters.direction);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filters.limit ?? 500;
    const offset = filters.offset ?? 0;

    const rows = this.db
      .prepare<(string | number)[], Transfer>(
        `SELECT * FROM transfers ${where} ORDER BY priority ASC, id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);

    return rows.map((r) => this.rowToTransfer(r));
  }

  getActive(): Transfer[] {
    return this.getAll({ status: 'active' });
  }

  getStats(): TransferStats {
    const row = this.db
      .prepare<[], {
        total: number; active: number; done: number;
        errors: number; pending: number; bytes_transferred: number;
      }>(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'active'  THEN 1 ELSE 0 END) AS active,
          SUM(CASE WHEN status = 'done'    THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'error'   THEN 1 ELSE 0 END) AS errors,
          SUM(CASE WHEN status IN ('pending','queued') THEN 1 ELSE 0 END) AS pending,
          SUM(CASE WHEN status = 'done' THEN size_bytes ELSE 0 END) AS bytes_transferred
        FROM transfers
      `)
      .get();

    return row ?? { total: 0, active: 0, done: 0, errors: 0, pending: 0, bytes_transferred: 0 };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private countByStatus(status: TransferStatus): number {
    const row = this.db
      .prepare<[string], { n: number }>(
        `SELECT COUNT(*) AS n FROM transfers WHERE status = ?`
      )
      .get(status);
    return row?.n ?? 0;
  }

  private rowToTransfer(row: Transfer): Transfer {
    return {
      ...row,
      project:     row.project     ?? null,
      peer_name:   row.peer_name   ?? null,
      started_at:  row.started_at  ?? null,
      finished_at: row.finished_at ?? null,
      error:       row.error       ?? null,
    };
  }
}
