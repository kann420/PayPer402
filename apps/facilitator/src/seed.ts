import { exportPrivateKeyJwk, generateAgentKey, type Ed25519PrivateJwk } from '@payper402/scheme-paypal';
import { issueApiKey } from './auth';
import { randomId } from './crypto';
import type { Db } from './db/connection';

export const DEMO_OPERATOR = {
  name: 'Northwind Research',
  caps: { perCall: 10, daily: 1000, unsettled: 500, total: 5000 },
};
export const DEMO_SELLER = { name: 'Acme Data' };
export const DEMO_AGENT = { name: 'Research agent' };

export interface SeedResult {
  operatorId: string;
  sellerId: string;
  agentId?: string;
  /** Shown once; only set when the record was created in this run. */
  operatorKey?: string;
  sellerKey?: string;
  agentPrivateKeyJwk?: Ed25519PrivateJwk;
  created: { operator: boolean; seller: boolean };
}

export interface SeedOptions {
  reset?: boolean;
  now: number;
  pepper: string;
}

/** Deletes an operator and everything that belongs to it. */
export function deleteOperator(db: Db, operatorId: string): void {
  db.prepare(
    `DELETE FROM settlement_items WHERE settlement_id IN (SELECT id FROM settlements WHERE operator_id = ?)
       OR commitment_id IN (SELECT id FROM commitments WHERE operator_id = ?)`,
  ).run(operatorId, operatorId);
  db.prepare('DELETE FROM commitments WHERE operator_id = ?').run(operatorId);
  db.prepare('DELETE FROM settlements WHERE operator_id = ?').run(operatorId);
  db.prepare('DELETE FROM agents WHERE operator_id = ?').run(operatorId);
  db.prepare('DELETE FROM wallets WHERE operator_id = ?').run(operatorId);
  db.prepare(`DELETE FROM api_keys WHERE owner_type = 'operator' AND owner_id = ?`).run(operatorId);
  db.prepare('DELETE FROM operators WHERE id = ?').run(operatorId);
}

/**
 * Creates the demo accounts unless they exist (design spec §14). Keys are stored only as hashes,
 * so they are returned only for records created in this run. `reset` deletes and recreates them.
 */
export function seed(db: Db, options: SeedOptions): SeedResult {
  return db
    .transaction((): SeedResult => {
      const findOperator = () =>
        db.prepare('SELECT id FROM operators WHERE name = ?').get(DEMO_OPERATOR.name) as { id: string } | undefined;
      const findSeller = () =>
        db.prepare('SELECT id FROM sellers WHERE name = ?').get(DEMO_SELLER.name) as { id: string } | undefined;

      if (options.reset) {
        const operator = findOperator();
        if (operator) deleteOperator(db, operator.id);
        const seller = findSeller();
        if (seller) {
          db.prepare(`DELETE FROM api_keys WHERE owner_type = 'seller' AND owner_id = ?`).run(seller.id);
          db.prepare('DELETE FROM sellers WHERE id = ?').run(seller.id);
        }
      }

      const result: Partial<SeedResult> & { created: SeedResult['created'] } = {
        created: { operator: false, seller: false },
      };

      const existingOperator = findOperator();
      if (existingOperator) {
        result.operatorId = existingOperator.id;
      } else {
        const operatorId = randomId('op');
        const { caps } = DEMO_OPERATOR;
        db.prepare(
          `INSERT INTO operators (id, name, email, cap_per_call, cap_daily, cap_unsettled, cap_total, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        ).run(operatorId, DEMO_OPERATOR.name, caps.perCall, caps.daily, caps.unsettled, caps.total, options.now);
        db.prepare(`INSERT INTO wallets (operator_id, status, updated_at) VALUES (?, 'not_linked', ?)`).run(
          operatorId,
          options.now,
        );
        const key = generateAgentKey();
        const agentId = randomId('agt');
        db.prepare(
          `INSERT INTO agents (id, operator_id, name, kid, public_key_x, status, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        ).run(agentId, operatorId, DEMO_AGENT.name, key.kid, key.publicKeyX, options.now);
        result.operatorId = operatorId;
        result.agentId = agentId;
        result.agentPrivateKeyJwk = exportPrivateKeyJwk(key.privateKey);
        result.operatorKey = issueApiKey(db, options.pepper, 'operator', operatorId, 'seed', options.now);
        result.created.operator = true;
      }

      const existingSeller = findSeller();
      if (existingSeller) {
        result.sellerId = existingSeller.id;
      } else {
        const sellerId = randomId('sel');
        db.prepare('INSERT INTO sellers (id, name, created_at) VALUES (?, ?, ?)').run(sellerId, DEMO_SELLER.name, options.now);
        result.sellerId = sellerId;
        result.sellerKey = issueApiKey(db, options.pepper, 'seller', sellerId, 'seed', options.now);
        result.created.seller = true;
      }

      return result as SeedResult;
    })
    .immediate();
}
