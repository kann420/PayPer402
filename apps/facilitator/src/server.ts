import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, createServices, type Services } from './app';
import { ConfigError, loadConfig, type Config } from './config';
import { openDatabase, type Db } from './db/connection';
import { runMigrations } from './db/migrations';
import { EventBus } from './events';
import { createLogger, errorMessage, type Logger } from './logger';
import { createPayPalGateway, type PayPalGateway } from './paypal';

export interface RunningFacilitator {
  server: Server;
  port: number;
  services: Services;
  db: Db;
  close(): Promise<void>;
}

export interface StartOptions {
  config: Config;
  logger?: Logger;
  paypal?: PayPalGateway;
  clock?: () => number;
  /** Start the tick scheduler (default true). */
  jobs?: boolean;
}

/** Opens the database, migrates, listens and starts the jobs. Used by `main` and the sandbox script. */
export async function startFacilitator(options: StartOptions): Promise<RunningFacilitator> {
  const { config } = options;
  const logger = options.logger ?? createLogger(config.logLevel);
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
  const db = openDatabase(config.databasePath);
  runMigrations(db);
  const events = new EventBus(logger);
  const deps = { config, db, paypal: options.paypal ?? createPayPalGateway(config), clock, events, logger };
  const services = createServices(deps);
  const app = createApp(deps, services);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(config.port, () => resolve(s));
    s.once('error', reject);
  });
  if (options.jobs !== false) services.jobs.start();
  const port = (server.address() as AddressInfo).port;
  logger.info('Facilitator listening', { port, webhooks: config.paypalWebhookId !== undefined });
  return {
    server,
    port,
    services,
    db,
    async close() {
      await services.jobs.stop();
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      await services.settlements.background.idle();
      events.dispose();
      db.close();
    },
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : errorMessage(err)}\n`);
    process.exitCode = 1;
    return;
  }
  const running = await startFacilitator({ config });
  const shutdown = () => {
    void running.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('/src/server.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`Facilitator failed to start: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  });
}
