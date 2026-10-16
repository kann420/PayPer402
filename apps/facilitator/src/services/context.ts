import type { Config } from '../config';
import type { SecretBox } from '../crypto';
import type { Db } from '../db/connection';
import type { WalletRow } from '../db/rows';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { PayPalGateway } from '../paypal';

/** Shared dependencies of the services. */
export interface ServiceContext {
  config: Config;
  db: Db;
  paypal: PayPalGateway;
  clock: () => number;
  events: EventBus;
  logger: Logger;
  box: SecretBox;
}

/** Tracks fire-and-forget work so tests (and shutdown) can wait for it instead of sleeping. */
export class BackgroundWork {
  private readonly pending = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    const remove = () => {
      this.pending.delete(promise);
    };
    promise.then(remove, remove);
    return promise;
  }

  /** Resolves once nothing tracked is still running (including work started meanwhile). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}

export function readWallet(db: Db, operatorId: string): WalletRow | undefined {
  return db.prepare('SELECT * FROM wallets WHERE operator_id = ?').get(operatorId) as WalletRow | undefined;
}

/** Makes sure an operator has a wallet row (`not_linked`). */
export function ensureWallet(db: Db, operatorId: string, now: number): void {
  db.prepare(`INSERT OR IGNORE INTO wallets (operator_id, status, updated_at) VALUES (?, 'not_linked', ?)`).run(
    operatorId,
    now,
  );
}

/** First 2 characters of the local part, then `***@domain` (design spec §8). */
export function maskEmail(email: string | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  return `${email.slice(0, Math.min(2, at))}***@${email.slice(at + 1)}`;
}
