import express, { type Express, type Request } from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import { PAYPAL_SANDBOX_NETWORK, PayPalBatchFacilitatorScheme } from '@payper402/scheme-paypal';
import { agentAuth } from './agent-auth';
import { authenticate } from './auth';
import type { Config } from './config';
import { SecretBox } from './crypto';
import type { Db } from './db/connection';
import type { EventBus } from './events';
import { errorHandler, notFoundHandler, requestId } from './http';
import { createJobs, type Jobs } from './jobs';
import type { Logger } from './logger';
import type { PayPalGateway } from './paypal';
import { clientKey, HOUR_MS, MINUTE_MS, rateLimit, SlidingWindow } from './rate-limit';
import { adminRoutes } from './routes/admin';
import { agentStatusRoutes } from './routes/agent-status';
import { agentRoutes } from './routes/agents';
import { claimRoutes } from './routes/claims';
import { DEFAULT_KEEPALIVE_MS, eventsHandler } from './routes/events';
import { operatorRoutes } from './routes/operator';
import { paypalRoutes } from './routes/paypal';
import { readRoutes } from './routes/reads';
import { sellerRoutes } from './routes/seller';
import { webhookHandler } from './routes/webhooks';
import { x402Routes } from './routes/x402';
import type { ServiceContext } from './services/context';
import { SettlementService } from './services/settlements';
import { WalletService } from './services/wallets';
import { SqliteAgentRegistry, SqliteCommitmentLedger } from './stores';
import { pathOf } from './views';

export interface AppDeps {
  config: Config;
  /** A migrated database. */
  db: Db;
  paypal: PayPalGateway;
  /** Unix seconds. */
  clock: () => number;
  events: EventBus;
  logger: Logger;
  /** SSE keepalive period; tests shorten it. */
  sseKeepaliveMs?: number;
  /** Milliseconds, for the rate limits. Defaults to `Date.now`; tests move it. */
  rateClock?: () => number;
}

export interface Services {
  ctx: ServiceContext;
  registry: SqliteAgentRegistry;
  ledger: SqliteCommitmentLedger;
  facilitator: x402Facilitator;
  settlements: SettlementService;
  wallets: WalletService;
  jobs: Jobs;
}

/** Wires the services. No I/O and no timers: jobs start only when `jobs.start()` is called. */
export function createServices(deps: AppDeps): Services {
  const ctx: ServiceContext = {
    config: deps.config,
    db: deps.db,
    paypal: deps.paypal,
    clock: deps.clock,
    events: deps.events,
    logger: deps.logger,
    box: new SecretBox(deps.config.dataEncryptionKey),
  };
  const settlements = new SettlementService(ctx);
  const wallets = new WalletService(ctx, settlements);
  const registry = new SqliteAgentRegistry(deps.db);
  const ledger = new SqliteCommitmentLedger(
    deps.db,
    (record) => {
      deps.events.emit({
        type: 'commitment.recorded',
        operatorId: record.operatorId,
        data: {
          id: record.id,
          agentId: record.agentId,
          payTo: record.payTo,
          path: pathOf(record.resourceUrl),
          amount: record.amount,
          recordedAt: record.recordedAt,
        },
      });
      settlements.scheduleThresholdCheck(record.operatorId);
    },
    deps.logger,
  );
  const facilitator = new x402Facilitator().register(
    PAYPAL_SANDBOX_NETWORK,
    new PayPalBatchFacilitatorScheme({ agents: registry, ledger, now: deps.clock }),
  );
  const jobs = createJobs({
    settlements,
    wallets,
    clock: deps.clock,
    logger: deps.logger,
    tickSeconds: deps.config.settlementTickSeconds,
  });
  return { ctx, registry, ledger, facilitator, settlements, wallets, jobs };
}

/** The Express app (design spec §7). Sends no CORS headers on any route. */
export function createApp(deps: AppDeps, services: Services = createServices(deps)): Express {
  const { ctx, settlements, wallets } = services;
  const { db, config, clock } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(requestId);

  // Raw body for signature verification, registered before the JSON parser.
  app.post(
    '/webhooks/paypal',
    express.raw({ type: () => true, limit: '64kb' }),
    webhookHandler(ctx, wallets, settlements),
  );
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });
  app.use('/paypal', paypalRoutes(ctx, wallets));

  const operator = authenticate(db, config.apiKeyPepper, clock, ['operator']);
  const seller = authenticate(db, config.apiKeyPepper, clock, ['seller']);
  const either = authenticate(db, config.apiKeyPepper, clock, ['operator', 'seller']);

  const rateNow = deps.rateClock ?? Date.now;
  const reads = readRoutes(ctx, settlements, rateNow);

  // In-process rate limits for the two unauthenticated-by-key endpoints (operator-cli.md §9.3).
  const client = (req: Request) => clientKey(req, config.trustProxy);
  const redeemLimit = rateLimit([
    [new SlidingWindow(10, MINUTE_MS, rateNow), client],
    [new SlidingWindow(300, HOUR_MS, rateNow), () => 'all'],
  ]);
  const statusLimit = rateLimit([[new SlidingWindow(60, MINUTE_MS, rateNow), client]]);

  app.use('/x402', seller, x402Routes(services.facilitator));
  app.use('/v1/operator', operator, operatorRoutes(ctx, wallets));
  app.use('/v1/agents', operator, agentRoutes(ctx, wallets));
  // Outside `/v1/agents`, which puts operator authentication on every path below it.
  app.use('/v1/claims', redeemLimit, claimRoutes(ctx));
  app.use('/v1/agent', statusLimit, agentAuth(db, clock, deps.logger), agentStatusRoutes(ctx, wallets));
  app.use('/v1/commitments', operator, reads.commitments);
  app.use('/v1/settlements', operator, reads.settlements);
  app.use('/v1/seller', seller, sellerRoutes(ctx));
  app.get('/v1/events', either, eventsHandler(ctx, deps.sseKeepaliveMs ?? DEFAULT_KEEPALIVE_MS));
  // Mounted only when the admin key is configured; otherwise the path is a plain 404.
  if (config.adminApiKey !== undefined) app.use('/v1/admin', adminRoutes(ctx, config.adminApiKey));

  app.use(notFoundHandler);
  app.use(errorHandler(deps.logger));
  return app;
}
