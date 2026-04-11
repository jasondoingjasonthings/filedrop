import nodemailer from 'nodemailer';
import type { Transfer, EmailConfig } from '@filedrop/core';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function createTransport(cfg: EmailConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: {
      user: cfg.smtp.user,
      pass: cfg.smtp.pass,
    },
  });
}

export async function mailCompleted(
  transfer: Transfer,
  emailCfg: EmailConfig
): Promise<void> {
  if (!emailCfg.enabled) return;

  const verb = transfer.direction === 'upload' ? 'uploaded' : 'downloaded';
  const transport = createTransport(emailCfg);

  await transport.sendMail({
    from: emailCfg.from,
    to: emailCfg.to,
    subject: `[FileDrop] ${transfer.filename} ${verb}`,
    text: [
      `File: ${transfer.filename}`,
      `Size: ${formatBytes(transfer.size_bytes)}`,
      `Direction: ${transfer.direction}`,
      `Project: ${transfer.project ?? '—'}`,
      `Completed: ${transfer.finished_at ?? new Date().toISOString()}`,
    ].join('\n'),
  });
}

export async function mailFailed(
  transfer: Transfer,
  emailCfg: EmailConfig
): Promise<void> {
  if (!emailCfg.enabled) return;

  const verb = transfer.direction === 'upload' ? 'upload' : 'download';
  const transport = createTransport(emailCfg);

  await transport.sendMail({
    from: emailCfg.from,
    to: emailCfg.to,
    subject: `[FileDrop] FAILED — ${transfer.filename}`,
    text: [
      `File: ${transfer.filename}`,
      `Direction: ${transfer.direction}`,
      `Error: ${transfer.error ?? 'Unknown error'}`,
      `Attempts: ${transfer.retry_count}`,
      `The ${verb} failed permanently and will not be retried.`,
    ].join('\n'),
  });
}
