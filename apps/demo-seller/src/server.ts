import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import { HTTPFacilitatorClient } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import { PAYPAL_NETWORK_FAMILY, PayPalBatchServerScheme } from '@payper402/scheme-paypal';
import { z } from 'zod';
import { createClaudeSellerAi, type SellerAi } from './ai';
import { createSellerApp } from './app';
import { ConfigError, loadSellerConfig } from './config';

export interface StartSellerOptions {
  port: number;
  /** External base URL. Defaults to `http://localhost:<bound port>`. */
  publicUrl?: string;
  /** The facilitator's base URL, without a trailing slash. */
  facilitatorUrl: string;
  sellerApiKey: string;
  ai: SellerAi;
  /** Used for the `/v1/seller` lookup. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface RunningSeller {
  server: Server;
  port: number;
  /** Equals `publicUrl`: agents use it as their seller URL. */
  url: string;
  payTo: string;
  close(): Promise<void>;
}

/** Thrown when start-up cannot complete; the message is safe to print. */
export class SellerStartError extends Error {
  override readonly name = 'SellerStartError';
}

const sellerResponse = z.object({ seller: z.object({ id: z.string().min(1), name: z.string().min(1) }) });

async function lookupSeller(facilitatorUrl: string, key: string, fetchFn: typeof fetch): Promise<{ id: string; name: string }> {
  let res: Response;
  try {
    res = await fetchFn(`${facilitatorUrl}/v1/seller`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SellerStartError(`Could not reach the facilitator at ${facilitatorUrl}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new SellerStartError(`The facilitator rejected the seller API key (HTTP ${res.status})`);
  }
  if (res.status !== 200) {
    throw new SellerStartError(`The facilitator's /v1/seller answered HTTP ${res.status}`);
  }
  const parsed = sellerResponse.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new SellerStartError("The facilitator's /v1/seller answer is not a seller");
  return parsed.data.seller;
}

/**
 * Starts the seller (design spec §3.1): resolves `payTo` from `/v1/seller`, initializes the
 * resource server against the facilitator, then listens.
 */
export async function startSeller(options: StartSellerOptions): Promise<RunningSeller> {
  const seller = await lookupSeller(options.facilitatorUrl, options.sellerApiKey, options.fetch ?? fetch);
  const headers = { Authorization: `Bearer ${options.sellerApiKey}` };
  const resourceServer = new x402ResourceServer(
    new HTTPFacilitatorClient({
      url: `${options.facilitatorUrl}/x402`,
      createAuthHeaders: async () => ({ verify: headers, settle: headers, supported: headers }),
    }),
  ).register(PAYPAL_NETWORK_FAMILY, new PayPalBatchServerScheme());
  try {
    await resourceServer.initialize();
  } catch {
    throw new SellerStartError('The facilitator did not list the PayPal payment kind (GET /x402/supported failed)');
  }

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = (options.publicUrl ?? `http://localhost:${port}`).replace(/\/+$/, '');
  server.on(
    'request',
    createSellerApp({ payTo: seller.id, sellerName: seller.name, publicUrl: url, resourceServer, ai: options.ai }),
  );
  return {
    server,
    port,
    url,
    payTo: seller.id,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The seller's model timeout: below the agent's 20 s paid-request timeout, so a slow model answers 503. */
export const SELLER_AI_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  let config;
  try {
    config = loadSellerConfig(process.env);
  } catch (err) {
    process.stderr.write(`${err instanceof ConfigError ? err.message : 'Invalid configuration'}\n`);
    process.exitCode = 1;
    return;
  }
  const ai = createClaudeSellerAi(new Anthropic({ timeout: SELLER_AI_TIMEOUT_MS, maxRetries: 0 }), config.anthropicModel);
  const running = await startSeller({
    port: config.port,
    publicUrl: config.publicUrl,
    facilitatorUrl: config.facilitatorUrl,
    sellerApiKey: config.sellerApiKey,
    ai,
  });
  process.stdout.write(`Demo seller listening on ${running.url} (payTo ${running.payTo})\n`);
  const shutdown = () => {
    void running.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (entry.endsWith('/src/server.ts')) {
  main().catch((err: unknown) => {
    process.stderr.write(`Demo seller failed to start: ${err instanceof SellerStartError ? err.message : 'unexpected error'}\n`);
    process.exitCode = 1;
  });
}
