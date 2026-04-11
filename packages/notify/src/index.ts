import type { TransferQueue, FileDropConfig, Transfer } from '@filedrop/core';
import { toastCompleted, toastFailed } from './toast.js';
import { mailCompleted, mailFailed } from './mailer.js';

/**
 * NotifyService wires into TransferQueue events and dispatches
 * desktop toasts and/or emails based on config.
 *
 * Call attach() once after creating the queue.
 */
export class NotifyService {
  constructor(
    private readonly queue: TransferQueue,
    private readonly config: FileDropConfig
  ) {}

  attach(): void {
    this.queue.on('completed', (transfer) => {
      void this.onCompleted(transfer);
    });

    this.queue.on('failed', (transfer) => {
      void this.onFailed(transfer);
    });
  }

  private async onCompleted(transfer: Transfer): Promise<void> {
    const { desktop, email } = this.config.notify;

    if (desktop) {
      toastCompleted(transfer);
    }

    if (email.enabled) {
      try {
        await mailCompleted(transfer, email);
      } catch (err) {
        console.error('[notify] Email send failed (completed):', err);
      }
    }
  }

  private async onFailed(transfer: Transfer): Promise<void> {
    const { desktop, email } = this.config.notify;

    if (desktop) {
      toastFailed(transfer);
    }

    if (email.enabled) {
      try {
        await mailFailed(transfer, email);
      } catch (err) {
        console.error('[notify] Email send failed (failed):', err);
      }
    }
  }
}

export { toastCompleted, toastFailed } from './toast.js';
export { mailCompleted, mailFailed } from './mailer.js';
