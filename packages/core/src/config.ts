import { z } from 'zod';
import fs from 'fs';
import path from 'path';

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const PeerSchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(5050),
});

const DashboardConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(5050),
  host: z.string().default('0.0.0.0'),
  jwtSecret: z.string().min(32),
});

const SmtpConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  user: z.string(),
  pass: z.string(),
});

const EmailConfigSchema = z.object({
  enabled: z.boolean().default(false),
  smtp: SmtpConfigSchema,
  from: z.string().email(),
  to: z.string().email(),
});

const NotifyConfigSchema = z.object({
  desktop: z.boolean().default(true),
  email: EmailConfigSchema,
});

export const FileDropConfigSchema = z.object({
  /** 'hub' = shares files, can see all peers. 'spoke' = pulls from hub only. */
  role: z.enum(['hub', 'spoke']),
  /** Human-readable name for this machine, shown to peers. */
  name: z.string().min(1),
  /** Folder whose contents are shared with peers. */
  watchFolder: z.string().min(1),
  /** Where incoming files from peers are saved. */
  downloadFolder: z.string().min(1),
  /** Shared secret — all machines in the group must use the same value. */
  secret: z.string().min(16),
  /** List of peers this machine can browse and pull from. */
  peers: z.array(PeerSchema).default([]),
  /** Max simultaneous downloads. */
  concurrency: z.number().int().positive().max(8).default(2),
  dashboard: DashboardConfigSchema,
  notify: NotifyConfigSchema,
});

// ─── Inferred types ──────────────────────────────────────────────────────────

export type FileDropConfig = z.infer<typeof FileDropConfigSchema>;
export type DashboardConfig = z.infer<typeof DashboardConfigSchema>;
export type NotifyConfig = z.infer<typeof NotifyConfigSchema>;
export type EmailConfig = z.infer<typeof EmailConfigSchema>;
export type PeerConfig = z.infer<typeof PeerSchema>;

// ─── Load & validate ─────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATHS = [
  path.resolve(path.dirname(process.execPath), 'config', 'filedrop.config.json'),
  path.resolve(path.dirname(process.execPath), 'filedrop.config.json'),
];

export function loadConfig(configPath?: string): FileDropConfig {
  const candidates = configPath ? [configPath] : DEFAULT_CONFIG_PATHS;

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as unknown;
      const result = FileDropConfigSchema.safeParse(raw);
      if (!result.success) {
        throw new Error(
          `Invalid config at ${candidate}:\n${result.error.toString()}`
        );
      }
      return result.data;
    }
  }

  throw new Error(
    `Config file not found. Searched:\n${candidates.join('\n')}`
  );
}

export function isConfigPresent(configPath?: string): boolean {
  const candidates = configPath ? [configPath] : DEFAULT_CONFIG_PATHS;
  return candidates.some((p) => fs.existsSync(p));
}

export function saveConfig(config: FileDropConfig, configPath?: string): void {
  const target = configPath ?? DEFAULT_CONFIG_PATHS[0]!;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf-8');
}
