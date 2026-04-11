// ─── Transfer ────────────────────────────────────────────────────────────────

export type TransferDirection = 'upload' | 'download';

export type TransferStatus =
  | 'pending'
  | 'queued'
  | 'active'
  | 'paused'
  | 'done'
  | 'error';

export interface Transfer {
  id: number;
  filename: string;
  local_path: string;
  /** Relative path on the source peer (e.g. "Ep13/GradeEdit.mov") */
  source_path: string;
  size_bytes: number;
  md5: string;
  direction: TransferDirection;
  status: TransferStatus;
  priority: number;
  progress: number;
  project: string | null;
  /** Name of the peer this transfer involves */
  peer_name: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  retry_count: number;
}

/** Fields required to enqueue a new transfer. */
export type NewTransfer = Omit<
  Transfer,
  'id' | 'status' | 'progress' | 'started_at' | 'finished_at' | 'error' | 'retry_count'
>;

// ─── User ────────────────────────────────────────────────────────────────────

export type UserRole = 'owner' | 'viewer';

export interface User {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  email: string | null;
  notify_email: boolean;
  notify_desktop: boolean;
  created_at: string;
}

export type NewUser = Omit<User, 'id' | 'created_at'>;

// ─── Peer ─────────────────────────────────────────────────────────────────────

export interface Peer {
  name: string;
  host: string;
  port: number;
}

export type PeerOnlineStatus = 'online' | 'offline' | 'drive_missing';

export interface PeerStatus {
  name: string;
  host: string;
  port: number;
  status: PeerOnlineStatus;
  watch_folder_ok: boolean;
  drive_free_bytes: number | null;
  file_count: number;
  last_seen: string | null;
}

// ─── Folder tree ──────────────────────────────────────────────────────────────

export interface FolderEntry {
  type: 'file' | 'folder';
  name: string;
  /** Path relative to watchFolder, forward-slash separated */
  relative_path: string;
  size_bytes: number;
  modified_at: string;
  children: FolderEntry[];
}

// ─── Subscription ─────────────────────────────────────────────────────────────

export interface Subscription {
  id: number;
  peer_name: string;
  /** Folder path relative to peer's watchFolder */
  remote_path: string;
  /** Absolute local path where files are saved */
  local_path: string;
  subscribed_at: string;
  status: 'active' | 'paused';
}

// ─── Library entry ────────────────────────────────────────────────────────────

export interface PeerFileRecord {
  peer_name: string;
  relative_path: string;
  size_bytes: number;
  modified_at: string | null;
  downloaded_at: string | null;
}

// ─── Queue events ─────────────────────────────────────────────────────────────

export interface QueueEventMap {
  enqueued:  [transfer: Transfer];
  started:   [transfer: Transfer];
  progress:  [id: number, progress: number];
  completed: [transfer: Transfer];
  failed:    [transfer: Transfer];
  paused:    [id: number];
  resumed:   [id: number];
  cancelled: [id: number];
}

// ─── Transfer query filters ───────────────────────────────────────────────────

export interface TransferFilters {
  status?: TransferStatus;
  direction?: TransferDirection;
  limit?: number;
  offset?: number;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface TransferStats {
  total: number;
  active: number;
  done: number;
  errors: number;
  pending: number;
  bytes_transferred: number;
}
