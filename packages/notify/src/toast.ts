import notifier from 'node-notifier';
import type { Transfer } from '@filedrop/core';

const APP_NAME = 'FileDrop';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function toastCompleted(transfer: Transfer): void {
  const verb = transfer.direction === 'upload' ? 'Uploaded' : 'Downloaded';
  notifier.notify({
    title: `${APP_NAME} — ${verb}`,
    message: `${transfer.filename} (${formatBytes(transfer.size_bytes)})`,
    // sound and icon are no-ops on non-Windows but harmless
    sound: false,
  });
}

export function toastFailed(transfer: Transfer): void {
  const verb = transfer.direction === 'upload' ? 'Upload' : 'Download';
  notifier.notify({
    title: `${APP_NAME} — ${verb} Failed`,
    message: `${transfer.filename}: ${transfer.error ?? 'Unknown error'}`,
    sound: false,
  });
}
