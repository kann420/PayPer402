import { errorMessage, type Logger } from './logger';
import type { SettlementService } from './services/settlements';
import type { WalletService } from './services/wallets';

export interface JobsDeps {
  settlements: SettlementService;
  wallets: WalletService;
  clock: () => number;
  logger: Logger;
  tickSeconds: number;
}

export interface Jobs {
  /** One tick of every job. Concurrent calls share the running tick (re-entrancy guard). */
  runTick(now?: number): Promise<void>;
  /** Runs a tick now (start-up recovery), then every `tickSeconds`. */
  start(): void;
  /** Stops the timer and waits for a running tick. */
  stop(): Promise<void>;
}

/**
 * Tick scheduler: link expiry, due retries and crash recovery, capture
 * polling, relink resumption, threshold and daily triggers, and wallet health checks. Each step
 * is isolated: a failing step is logged and the rest still run.
 */
export function createJobs(deps: JobsDeps): Jobs {
  let running: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try {
      await fn();
    } catch (err) {
      deps.logger.error('Job step failed', { step: name, error: errorMessage(err) });
    }
  };

  const tick = async (now: number) => {
    await step('expire_links', () => deps.wallets.expireLinks(now));
    await step('settlement_recovery', () => deps.settlements.runDue(now));
    await step('resume_relinks', () => deps.wallets.resumeRelinks());
    await step('settlement_triggers', () => deps.settlements.runTriggers());
    await step('wallet_health', () => deps.wallets.healthCheck(now));
  };

  const runTick = (now = deps.clock()): Promise<void> => {
    if (running) return running;
    running = tick(now).finally(() => {
      running = undefined;
    });
    return running;
  };

  return {
    runTick,
    start() {
      if (timer) return;
      void runTick();
      timer = setInterval(() => {
        void runTick();
      }, deps.tickSeconds * 1000);
      timer.unref();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (running) await running;
    },
  };
}
