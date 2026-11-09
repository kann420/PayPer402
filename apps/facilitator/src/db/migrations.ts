import type { Db } from './connection';

export interface Migration {
  version: number;
  sql: string;
}

/** Numbered migrations (design spec §5). Append only; never edit an applied migration. */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE operators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        cap_per_call INTEGER NOT NULL,
        cap_daily INTEGER NOT NULL,
        cap_unsettled INTEGER NOT NULL,
        cap_total INTEGER,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE sellers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('operator', 'seller')),
        owner_id TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        label TEXT,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at INTEGER
      );

      CREATE TABLE wallets (
        operator_id TEXT PRIMARY KEY REFERENCES operators(id),
        status TEXT NOT NULL CHECK (status IN
          ('not_linked', 'waiting_for_approval', 'active', 'unlinking', 'stopped_by_payer', 'link_failed')),
        link_state TEXT UNIQUE,
        setup_token_id TEXT,
        link_started_at INTEGER,
        link_error TEXT,
        vault_id_sealed TEXT,
        vault_id_hash TEXT UNIQUE,
        paypal_customer_id TEXT,
        payer_email_masked TEXT,
        linked_at INTEGER,
        stopped_at INTEGER,
        last_checked_at INTEGER,
        charge_retry_after INTEGER,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE agents (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        name TEXT NOT NULL,
        kid TEXT NOT NULL UNIQUE,
        public_key_x TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'paused')),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE settlements (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        trigger TEXT NOT NULL CHECK (trigger IN ('threshold', 'daily', 'manual', 'unlink', 'relink')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed', 'needs_review')),
        amount INTEGER NOT NULL,
        calls_count INTEGER NOT NULL,
        paypal_request_id TEXT NOT NULL UNIQUE,
        vault_id_hash TEXT,
        paypal_order_id TEXT,
        paypal_capture_id TEXT,
        capture_status TEXT,
        fee INTEGER,
        net INTEGER,
        failure_code TEXT,
        failure_reason TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE commitments (
        id TEXT PRIMARY KEY,
        kid TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        operator_id TEXT NOT NULL REFERENCES operators(id),
        pay_to TEXT NOT NULL,
        resource_url TEXT NOT NULL,
        max_amount INTEGER NOT NULL,
        amount INTEGER NOT NULL,
        iat INTEGER NOT NULL,
        recorded_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('unsettled', 'settling', 'settled', 'uncollectable')),
        payload_hash TEXT NOT NULL,
        settlement_id TEXT REFERENCES settlements(id)
      );

      CREATE TABLE settlement_items (
        settlement_id TEXT NOT NULL REFERENCES settlements(id),
        commitment_id TEXT NOT NULL REFERENCES commitments(id),
        pay_to TEXT NOT NULL,
        amount INTEGER NOT NULL,
        PRIMARY KEY (settlement_id, commitment_id)
      );

      CREATE TABLE webhook_events (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        resource_id TEXT,
        received_at INTEGER NOT NULL,
        processed_at INTEGER,
        outcome TEXT
      );

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_type TEXT NOT NULL,
        actor_id TEXT,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        details TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX commitments_operator_state ON commitments(operator_id, state);
      CREATE INDEX commitments_operator_recorded ON commitments(operator_id, recorded_at);
      CREATE INDEX commitments_pay_to_recorded ON commitments(pay_to, recorded_at);
      CREATE INDEX commitments_settlement ON commitments(settlement_id);
      CREATE INDEX settlements_operator_status ON settlements(operator_id, status);
      CREATE INDEX settlements_order ON settlements(paypal_order_id);
      CREATE INDEX settlements_capture ON settlements(paypal_capture_id);
      CREATE UNIQUE INDEX settlements_one_pending ON settlements(operator_id) WHERE status = 'pending';
      CREATE INDEX settlement_items_commitment ON settlement_items(commitment_id);
      CREATE INDEX settlement_items_pay_to ON settlement_items(pay_to);
      CREATE INDEX agents_operator ON agents(operator_id);
      CREATE INDEX api_keys_owner ON api_keys(owner_type, owner_id);
    `,
  },
  {
    // Shared payment tokens (design spec §5, §5.1): several wallets may hold one token, so
    // `vault_id_hash` loses its UNIQUE. Everything else is exactly as in migration 1. No table
    // references `wallets`, so the rebuild needs no change to `foreign_keys`.
    version: 2,
    sql: `
      CREATE TABLE wallets_new (
        operator_id TEXT PRIMARY KEY REFERENCES operators(id),
        status TEXT NOT NULL CHECK (status IN
          ('not_linked', 'waiting_for_approval', 'active', 'unlinking', 'stopped_by_payer', 'link_failed')),
        link_state TEXT UNIQUE,
        setup_token_id TEXT,
        link_started_at INTEGER,
        link_error TEXT,
        vault_id_sealed TEXT,
        vault_id_hash TEXT,
        paypal_customer_id TEXT,
        payer_email_masked TEXT,
        linked_at INTEGER,
        stopped_at INTEGER,
        last_checked_at INTEGER,
        charge_retry_after INTEGER,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO wallets_new (operator_id, status, link_state, setup_token_id, link_started_at, link_error,
        vault_id_sealed, vault_id_hash, paypal_customer_id, payer_email_masked, linked_at, stopped_at,
        last_checked_at, charge_retry_after, updated_at)
      SELECT operator_id, status, link_state, setup_token_id, link_started_at, link_error,
        vault_id_sealed, vault_id_hash, paypal_customer_id, payer_email_masked, linked_at, stopped_at,
        last_checked_at, charge_retry_after, updated_at
      FROM wallets;

      DROP TABLE wallets;
      ALTER TABLE wallets_new RENAME TO wallets;
      CREATE INDEX wallets_vault_id_hash ON wallets(vault_id_hash);
    `,
  },
  {
    // Claim codes for the operator CLI (operator-cli.md §5). Additive; no table is rebuilt.
    version: 3,
    sql: `
      CREATE TABLE agent_claims (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        code_hash TEXT NOT NULL UNIQUE,
        agent_name TEXT NOT NULL,
        seller_url TEXT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        redeemed_at INTEGER NULL,
        agent_id TEXT NULL REFERENCES agents(id)
      );

      CREATE INDEX agent_claims_operator ON agent_claims(operator_id, expires_at);
    `,
  },
];

export class DatabaseTooNewError extends Error {
  override readonly name = 'DatabaseTooNewError';
}

/** Current schema version of `db` (0 when empty). */
export function schemaVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Applies pending migrations, each in its own transaction together with its
 * `schema_migrations` row. Refuses to run against a database newer than this code.
 */
export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS, now = () => Math.floor(Date.now() / 1000)): number {
  const current = schemaVersion(db);
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (current > latest) {
    throw new DatabaseTooNewError(
      `Database schema version ${current} is newer than this code supports (${latest}). Refusing to start.`,
    );
  }
  const insert = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, now());
    })();
  }
  return schemaVersion(db);
}
