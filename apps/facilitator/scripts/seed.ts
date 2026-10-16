/**
 * Seeds the demo accounts (design spec §14):
 *
 *   npm run seed -w apps/facilitator            create them unless they exist
 *   npm run seed -w apps/facilitator -- --reset delete and recreate them (issues new keys)
 *
 * Needs only DATABASE_PATH (optional) and API_KEY_PEPPER. Prints keys once, to stdout.
 */
import { z } from 'zod';
import { openDatabase } from '../src/db/connection';
import { runMigrations } from '../src/db/migrations';
import { errorMessage } from '../src/logger';
import { seed } from '../src/seed';

const env = z
  .object({
    DATABASE_PATH: z.string().trim().min(1).optional(),
    API_KEY_PEPPER: z.string().min(32, 'must be at least 32 characters'),
  })
  .safeParse(process.env);

function main(): void {
  if (!env.success) {
    process.stderr.write(
      `Invalid configuration:\n  ${env.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ')}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const db = openDatabase(env.data.DATABASE_PATH ?? './data/facilitator.db');
  try {
    runMigrations(db);
    const result = seed(db, {
      reset: process.argv.includes('--reset'),
      now: Math.floor(Date.now() / 1000),
      pepper: env.data.API_KEY_PEPPER,
    });
    const out = (line = '') => process.stdout.write(`${line}\n`);
    out(`Operator "Northwind Research": ${result.operatorId}${result.created.operator ? ' (created)' : ' (exists)'}`);
    out(`Seller "Acme Data" (payTo): ${result.sellerId}${result.created.seller ? ' (created)' : ' (exists)'}`);
    if (result.operatorKey) out(`Operator API key (shown once): ${result.operatorKey}`);
    if (result.sellerKey) out(`Seller API key (shown once): ${result.sellerKey}`);
    if (result.agentId && result.agentPrivateKeyJwk) {
      out(`Agent: ${result.agentId}`);
      out(`Agent private key JWK (shown once, keep it secret): ${JSON.stringify(result.agentPrivateKeyJwk)}`);
    }
    if (!result.created.operator && !result.created.seller) {
      out('Nothing created. Keys are stored only as hashes; run with --reset to issue new ones.');
    }
  } catch (err) {
    process.stderr.write(`Seeding failed: ${errorMessage(err)}\n`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
