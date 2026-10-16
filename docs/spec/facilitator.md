# PayPer402 facilitator: design spec

> Status: draft 3.2 (2026-10-16), for roadmap Phase 2, revised after the Phase 2 audit. Normative
> keywords follow RFC 2119.

The facilitator is the service behind the `batch-settlement` / `paypal:sandbox` binding
([scheme_batch_settlement_paypal.md](scheme_batch_settlement_paypal.md)). It:

- verifies and records commitments for sellers
- links operators' PayPal wallets
- enforces caps
- redeems recorded commitments by charging the linked wallets
- detects revocation

It is the merchant of record.

This document defines its behaviour, data model and HTTP API. Implementation details (files,
tests, milestones) are in [docs/phase-2/BUILD_SPEC.md](../phase-2/BUILD_SPEC.md).

## 1. Scope

In scope for Phase 2:

- **x402 endpoints:** the x402 facilitator HTTP endpoints (`/x402/verify`, `/x402/settle`,
  `/x402/supported`), authenticated per seller.
- **Persistence:** SQLite implementations of the scheme's `AgentRegistry` and
  `CommitmentLedger`.
- **Operators:** wallet linking (PayPal Vault v3), caps, agents, and read APIs for commitments
  and settlements.
- **Sellers:** read APIs for revenue and settlements.
- **Redemption:** batched PayPal charges (Orders v2 with a vault id), with crash-safe idempotency.
- **Revocation detection:** through charge errors, the `VAULT.PAYMENT-TOKEN.DELETED` webhook, and
  a wallet health check.
- **PayPal webhooks:** signature-verified and de-duplicated.
- **Live events:** an in-process event bus and a server-sent events (SSE) stream for live
  dashboards.
- **Tooling:** a seed CLI for demo accounts, and a sandbox end-to-end script.

Out of scope: the web UI (Phase 4), the demo seller and the LLM agent (Phase 3), PayPal Payouts,
rate limiting, multi-process deployment, hosting and webhook registration (Phase 5), and
self-service sign-up.

## 2. Architecture

One Node.js process runs an Express app and a job scheduler over one SQLite database.

```
          seller API (Phase 3)                     web app (Phase 4)
   @x402/express + HTTPFacilitatorClient         operator / seller keys
                  │  /x402/*                           │  /v1/*
                  ▼                                    ▼
 ┌──────────────────────────── facilitator ─────────────────────────────┐
 │ auth (API keys) → routes ─┬─ x402Facilitator + PayPalBatchFacilitator │
 │                           ├─ wallet service ───────┐                  │
 │                           ├─ settlement service ───┤──► PayPal client ─┼──► PayPal sandbox
 │                           └─ read models           │   (paypal-client)│
 │ jobs: settlement tick, capture poll, wallet health ┘                   │
 │ event bus ──► SSE /v1/events                                          │
 │ SQLite (better-sqlite3, WAL)                                          │
 └──────────────────────────────────────────────────────────────────────┘
        ▲ /paypal/return, /paypal/cancel (browser)     ▲ /webhooks/paypal (PayPal)
```

- **Money:** always integer **cents**. It is converted to PayPal's `"D.CC"` strings only inside
  the PayPal client.
- **Time:** always unix **seconds** (integers). The clock is injectable everywhere.
- **IDs:** a prefix plus 16 random bytes in base64url without padding: `op_…`, `sel_…`, `agt_…`,
  `stl_…`, `key_…`.
  - Commitment ids are the commitments' own `id`.
  - A seller's id is its `payTo`.

## 3. Configuration

Environment variables, validated with zod at startup. The process refuses to start if any is
invalid.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PORT` | no | `4020` | HTTP port |
| `DATABASE_PATH` | no | `./data/facilitator.db` | SQLite file; `:memory:` allowed in tests |
| `PUBLIC_BASE_URL` | yes | — | External base URL of this service, used for PayPal return/cancel URLs |
| `WEB_APP_URL` | no | — | Where the browser is sent after linking |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | — | Sandbox REST app |
| `PAYPAL_API_BASE` | no | sandbox | Must pass the sandbox guard |
| `PAYPAL_WEBHOOK_ID` | no | — | Required to accept webhooks; without it `/webhooks/paypal` answers 503 |
| `DATA_ENCRYPTION_KEY` | yes | — | 64 hex chars (32 bytes), AES-256-GCM key for sealed columns |
| `API_KEY_PEPPER` | yes | — | At least 32 chars, HMAC key for API key hashes |
| `SETTLEMENT_TICK_SECONDS` | no | `15` | Job tick |
| `WALLET_CHECK_INTERVAL_SECONDS` | no | `30` | Health check period per wallet in `active` or `unlinking` |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error` |

Secrets MUST NOT appear in logs, error messages or API responses.

## 4. Authentication

- **API keys:**
  - Format: `pp402_op_<43 chars>` for operators, `pp402_sel_<43 chars>` for sellers. The suffix
    is 32 random bytes in base64url.
  - Stored only as `HMAC-SHA256(API_KEY_PEPPER, key)` in hex, with a unique index. Lookup is by
    hash.
  - Sent as `Authorization: Bearer <key>`.
  - Keys are created by the seed CLI and shown once. There is no key-creation endpoint in
    Phase 2.
- **Roles:**
  - `/v1/operator/*`, `/v1/agents*`, `/v1/commitments*` and `/v1/settlements*` require an
    operator key.
  - `/v1/seller/*` and `/x402/*` require a seller key.
  - `/v1/events` accepts either.
  - A missing or unknown key gets 401. A key of the wrong role gets 403.
- **PayPal browser return:** `/paypal/return` and `/paypal/cancel` are unauthenticated and keyed
  by a single-use random `state` (see §8).
- **PayPal webhooks:** `/webhooks/paypal` is unauthenticated and protected by signature
  verification (see §11).

## 5. Data model (SQLite)

Pragmas: `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`.

- Migrations are numbered and recorded in `schema_migrations(version INTEGER PRIMARY KEY,
  applied_at INTEGER)`. Each runs in its own transaction.
- The service refuses to start when the database is at a newer version than the code knows.

| Table | Columns (types, constraints) |
|---|---|
| `operators` | `id TEXT PK`, `name TEXT NOT NULL`, `email TEXT`, `cap_per_call INTEGER NOT NULL`, `cap_daily INTEGER NOT NULL`, `cap_unsettled INTEGER NOT NULL`, `cap_total INTEGER NULL`, `created_at INTEGER NOT NULL` |
| `sellers` | `id TEXT PK` (= `payTo`), `name TEXT NOT NULL`, `created_at INTEGER NOT NULL` |
| `api_keys` | `id TEXT PK`, `owner_type TEXT CHECK IN ('operator','seller')`, `owner_id TEXT NOT NULL`, `key_hash TEXT UNIQUE NOT NULL`, `label TEXT`, `created_at`, `last_used_at NULL`, `revoked_at NULL` |
| `wallets` | `operator_id TEXT PK FK`, `status TEXT CHECK IN ('not_linked','waiting_for_approval','active','unlinking','stopped_by_payer','link_failed')`, `link_state TEXT UNIQUE NULL`, `setup_token_id TEXT NULL`, `link_started_at NULL`, `link_error TEXT NULL`, `vault_id_sealed TEXT NULL`, `vault_id_hash TEXT UNIQUE NULL`, `paypal_customer_id TEXT NULL`, `payer_email_masked TEXT NULL`, `linked_at NULL`, `stopped_at NULL`, `last_checked_at NULL`, `charge_retry_after NULL`, `updated_at INTEGER NOT NULL` |
| `agents` | `id TEXT PK`, `operator_id TEXT FK NOT NULL`, `name TEXT NOT NULL`, `kid TEXT UNIQUE NOT NULL`, `public_key_x TEXT NOT NULL`, `status TEXT CHECK IN ('active','paused')`, `created_at` |
| `commitments` | `id TEXT PK`, `kid`, `agent_id FK`, `operator_id FK`, `pay_to`, `resource_url`, `max_amount INTEGER`, `amount INTEGER`, `iat`, `recorded_at`, `state TEXT CHECK IN ('unsettled','settling','settled','uncollectable')`, `payload_hash TEXT NOT NULL`, `settlement_id TEXT NULL FK` |
| `settlements` | `id TEXT PK`, `operator_id FK`, `trigger TEXT CHECK IN ('threshold','daily','manual','unlink','relink')`, `status TEXT CHECK IN ('pending','completed','failed','needs_review')`, `amount INTEGER NOT NULL`, `calls_count INTEGER NOT NULL`, `paypal_request_id TEXT UNIQUE NOT NULL`, `vault_id_hash TEXT NULL` (the wallet's `vault_id_hash` at charge time), `paypal_order_id TEXT NULL`, `paypal_capture_id TEXT NULL`, `capture_status TEXT NULL`, `fee INTEGER NULL`, `net INTEGER NULL`, `failure_code TEXT NULL`, `failure_reason TEXT NULL`, `attempts INTEGER NOT NULL DEFAULT 0`, `next_attempt_at INTEGER NULL`, `created_at`, `updated_at`, `completed_at NULL` |
| `settlement_items` | `settlement_id TEXT FK NOT NULL`, `commitment_id TEXT FK NOT NULL`, `pay_to TEXT NOT NULL`, `amount INTEGER NOT NULL`, `PRIMARY KEY (settlement_id, commitment_id)`. Written in the claim transaction and never updated or deleted. It is the permanent record of what each settlement covered. |
| `webhook_events` | `id TEXT PK` (the PayPal event id, **verified events only**), `event_type`, `resource_id TEXT NULL`, `received_at`, `processed_at NULL`, `outcome TEXT NULL` |
| `audit_log` | `id INTEGER PK AUTOINCREMENT`, `actor_type`, `actor_id`, `action`, `resource_type`, `resource_id`, `details TEXT` (JSON, ≤ 16 KB), `created_at` |

Indexes:

- `commitments(operator_id, state)`, `commitments(operator_id, recorded_at)`,
  `commitments(pay_to, recorded_at)`, `commitments(settlement_id)`
- `settlements(operator_id, status)`, `settlements(paypal_order_id)`,
  `settlements(paypal_capture_id)`
- a partial unique index `settlements(operator_id) WHERE status = 'pending'`, so the database
  itself enforces at most one pending settlement per operator
- `settlement_items(commitment_id)`, `settlement_items(pay_to)`
- `agents(operator_id)`

**Sealed values** (`vault_id_sealed`):

- Encrypted with AES-256-GCM under `DATA_ENCRYPTION_KEY`.
- Stored as `v1.<iv>.<tag>.<ciphertext>`, each part base64url, with a 12-byte IV and a 16-byte
  tag.
- `vault_id_hash` is `HMAC-SHA256(K_lookup, vault_id)` in hex, where
  `K_lookup = HKDF-SHA256(DATA_ENCRYPTION_KEY, salt = "", info = "payper402 vault lookup", 32
  bytes)`. It is used only to find a wallet from a webhook's `resource.id`.

**Invariants** (tests MUST check them):

- **Settlement sums**, for every settlement in any status: `settlements.amount = SUM(amount)` and
  `calls_count = COUNT(*)` over its `settlement_items` rows.
- **Batch link:** `commitments.settlement_id` is the commitment's *current* batch. It is set while
  the state is `settling` or `settled`. It is cleared when a declined settlement returns the
  commitment to `unsettled`. It keeps the failed batch's id whenever a commitment ends up
  `uncollectable`, whether through a revocation or a failed `relink` settlement.
- **One pending settlement:** an operator has at most one `pending` settlement (the partial
  unique index enforces it).

**Transactions:** better-sqlite3 transaction functions are synchronous. There MUST be no `await`
inside them. Every multi-row change listed in this spec is one transaction.

**Compare-and-set after PayPal calls.** A path that reads state, awaits PayPal, and then writes
can overlap with another path doing the same. Every such write is therefore a compare-and-set in
one transaction. Zero affected rows means another path won: make no other change, and return the
current state.

- **Settlements:** `WHERE id = ? AND status = 'pending'` (§9.3).
- **(a) Finishing a link:**
  `WHERE operator_id = ? AND status = 'waiting_for_approval' AND link_state = <state read before
  the await> AND setup_token_id = <setup token id read before the await>`. The loser returns the
  wallet as it now is. For `/refresh` that is a normal 200; for `/paypal/return`, the normal
  redirect.
  - If the write affects zero rows **and** the wallet's current `vault_id_hash` differs from the
    hash of the payment token just created (for example, the link was restarted meanwhile),
    delete that token at PayPal, best effort.
  - A loser that lost to its concurrent return/refresh twin received the same token (same
    `PayPal-Request-Id`), so it deletes nothing.
- **(b) Relink outcomes:** `WHERE operator_id = ? AND status = 'waiting_for_approval' AND
  vault_id_hash = <hash of the vault id the relink settlement charged>`.
  - If no row matches, because the link was restarted, expired or revoked meanwhile, the
    settlement outcome still applies to the settlement and its commitments.
  - The wallet is left alone, and nothing is deleted at PayPal.
- **(c) Unlink follow-ups**, meaning `active` again after a decline, or `not_linked` after
  completion: `WHERE operator_id = ? AND status = 'unlinking'`.
  - If the wallet was revoked meanwhile, it stays `stopped_by_payer`.
  - On completion, whether the wallet is still `unlinking` or has become `stopped_by_payer`, the
    vault columns are cleared and the payment token is deleted at PayPal. Only the status change
    depends on the compare-and-set.
- **(d) Revocation:** `WHERE operator_id = ? AND status IN ('active', 'unlinking')`.

To make (b) possible, the settlement row records which vault id it charged, in a new column:
`settlements.vault_id_hash TEXT NULL`, set at charge time.

## 6. Binding the scheme to the database

The facilitator uses `PayPalBatchFacilitatorScheme` from `@payper402/scheme-paypal` unchanged,
registered on `paypal:sandbox` in an `x402Facilitator`, with these store implementations.

**`SqliteAgentRegistry`:**

- `getAgentByKid(kid)` returns `{ agentId, kid, publicKeyX, operatorId, status }`. Agent status
  `paused` maps to `disabled`.
- `getOperator(id)` returns `{ operatorId, walletStatus, caps }`.
  - Wallet status `active` maps to `active`.
  - `stopped_by_payer` maps to `revoked`.
  - Every other status maps to `unlinked`, including `unlinking` and `waiting_for_approval`.
  - Caps map as `cap_per_call` → `perCall`, `cap_daily` → `daily`, `cap_unsettled` →
    `unsettled`, and `cap_total` → `total` (omitted when null).

**`SqliteCommitmentLedger`:**

- `has`, `get` and `snapshot` read the `commitments` table. `snapshot` follows the scheme's
  definitions: `spentToday` is any state recorded since `utcDayStart(now)`, `unsettled` is states
  `unsettled` and `settling`, and `spentTotal` is any state.
- `record` runs in one `db.transaction(...).immediate()` and does three things:
  1. Looks up `id`. The same `payload_hash` returns `duplicate: true` with the stored record; a
     different hash returns `replay`.
  2. Otherwise computes the snapshot and calls the scheme's `exceededCap`.
  3. Inserts with state `unsettled`.
  
  better-sqlite3 is synchronous, so the transaction is atomic within the process.
- **New-commitment hook:** the ledger takes an `onRecorded(record)` callback in its constructor.
  - It is called only on the insert path (`duplicate: false`), after the transaction commits,
    and its errors are caught and logged.
  - The facilitator uses it to emit `commitment.recorded` and to schedule the threshold check
    (§9.1), without awaiting either.
  - This is the only place either is triggered. The scheme returns the original
    `SettleResponse` for an identical retry, so the HTTP route cannot tell a retry from a new
    commitment.

## 7. HTTP API

**General rules:**

- JSON in and out. Bodies are limited to 64 KB.
- Every response carries `X-Request-Id`: the client's value if it matches
  `^[A-Za-z0-9._:-]{1,64}$`, otherwise a fresh one.
- Errors use `{ "error": "<snake_code>", "message": "<text>" }`, with HTTP 400
  `validation_failed` (plus `issues`), 401 `unauthorized`, 403 `forbidden`, 404 `not_found`, 409
  as listed per endpoint, and 500 `internal_error`.
- Amounts are integer cents; times are unix seconds.

### 7.1 x402 facilitator (seller key)

These follow the request and response shapes of the x402 `HTTPFacilitatorClient`.

| Method and path | Body | Response |
|---|---|---|
| `POST /x402/verify` | `{ x402Version, paymentPayload, paymentRequirements }` | 200 with an x402 `VerifyResponse` |
| `POST /x402/settle` | the same | 200 with an x402 `SettleResponse` |
| `GET /x402/supported` | — | 200 with an x402 `SupportedResponse` |

- **Body validation:** a body that fails the outer shape check (`x402Version` a number,
  `paymentPayload` and `paymentRequirements` objects) gets 400. Payment-level failures are 200
  with `isValid: false` or `success: false`, carrying the binding's error codes. This is what
  `HTTPFacilitatorClient` expects.
- **Seller ownership** (binding spec, Trust model), checked before calling the scheme:
  - `paymentRequirements.payTo` MUST equal the authenticated seller's id.
  - For `/x402/settle`, if `paymentPayload.payload.commitment.payTo` is present, it MUST also
    equal that id. This guards the scheme's idempotent-retry short-circuit.
  - A mismatch returns `isValid: false` or `success: false` with
    `invalid_batch_settlement_paypal_requirements_mismatch`.
- **Events and threshold checks** come from the ledger's `onRecorded` hook (§6), not from this
  route.
- **Errors reaching sellers:** a non-2xx answer from these endpoints makes the seller's
  middleware fail the request. Reserve non-2xx for auth (401/403), a malformed outer body (400)
  and internal errors (500).

### 7.2 Operator (operator key)

| Method and path | Purpose | Notes |
|---|---|---|
| `GET /v1/operator` | Overview | `{ operator, wallet, caps, usage: { spentToday, notYetCharged, spentTotal }, activeAgents, lastSettlement }` |
| `PUT /v1/operator/caps` | Set caps | Body `{ perCall, daily, unsettled, total? }`; rules below |
| `POST /v1/operator/wallet/link` | Start linking | 200 `{ approveUrl, expiresAt }`; 409 `wallet_already_active` (status `active` or `unlinking`); 409 `settlement_in_progress` while a `relink` settlement is pending, or while the wallet is `waiting_for_approval` with a stored payment token and any settlement is pending (§8 step 1); 502 `paypal_unavailable` when PayPal fails |
| `POST /v1/operator/wallet/refresh` | Re-check a pending link | Same processing as `/paypal/return`; returns the `wallet`; 409 `settlement_in_progress` while a `relink` settlement is pending; 502 `paypal_unavailable` when PayPal fails |
| `POST /v1/operator/wallet/unlink` | Unlink | §10; 409 `wallet_not_active` (not `active`), 409 `settlement_failed`, 409 `settlement_in_progress` (also when the first attempt ends in `needs_review`); 409 bodies carry the `wallet` |
| `POST /v1/agents` | Create an agent | Body `{ name, publicKeyX? }`; §7.4 |
| `GET /v1/agents` | List agents | Each with `spentToday`, `spentTotal`, `callsToday`, `lastCallAt`, and a derived `blocked` flag |
| `GET /v1/agents/:id` | One agent | The same fields |
| `PATCH /v1/agents/:id` | Update an agent | Body `{ name?, status?: 'active' \| 'paused' }` |
| `GET /v1/commitments` | Paid calls | Query `agentId?`, `state?`, `since?`, `until?` (unix seconds over `recordedAt`), `limit` (1–500, default 50), `before?` (a `recordedAt` cursor); newest first |
| `GET /v1/settlements` | Charges | Query `limit`, `before?`; newest first |
| `GET /v1/settlements/:id` | One charge | Includes the commitments it covered, read from `settlement_items`, for every status including `failed` |
| `POST /v1/settlements` | Manual charge | 201 with the settlement once its first attempt finishes; 409 `nothing_to_settle`, 409 `settlement_in_progress`, 409 `wallet_not_active` |

**Caps validation:**

- Every value passes the scheme's `assertValidCaps`.
- Also `1 ≤ perCall ≤ unsettled`, `perCall ≤ daily`, and if set, `total ≥ perCall`.

**The `wallet` object:** `{ status, payerEmailMasked, linkedAt, stoppedAt, lastChargeAt,
lastChargeAmount, lastChargeStatus, linkError }`.

- `status` includes `unlinking`; the UI shows it as "Unlinking…".
- `lastChargeStatus` comes from the most recent settlement, so the UI can show "Last charge
  failed".

**A paid call (commitment) in API responses:** `{ id, recordedAt, agentId, agentName, payTo,
resourceUrl, path, amount, maxAmount, state, settlementId }`.

- `path` is the path and query of `resourceUrl`. The UI derives the service and endpoint labels
  from it.
- The UI brief's per-call `httpStatus` is not stored. A commitment is only recorded after the
  seller's handler succeeded, so it would always be a success.
- The brief's per-agent `budget` is not a facilitator cap. Enforcing it would change the audited
  scheme. The budget for an agent run lives in the agent app (Phase 3), and caps stay per
  operator.

**An agent is `blocked`** when the wallet is not `active`, or when `exceededCap(caps.perCall, …)`
would fail for the operator right now.

### 7.3 Seller (seller key)

| Method and path | Purpose |
|---|---|
| `GET /v1/seller` | `{ seller, usage: { revenueToday, revenueTotal, pending, callsToday, uniqueAgentsToday } }`. `pending` is the seller's commitments in state `unsettled` or `settling`. |
| `GET /v1/seller/commitments` | The seller's paid calls, with the same query parameters as the operator's (including `since`/`until`). Same shape, but `agentId` and `agentName` are replaced by an opaque `agentRef` (the first 8 chars of `HMAC(API_KEY_PEPPER, agentId)`), and there is no operator data. |
| `GET /v1/seller/settlements` | Charges that cover the seller's commitments, from `settlement_items` (`pay_to` = seller): `{ id, createdAt, status, sellerAmount, sellerCalls, feeShare, netShare }`. `feeShare = round(fee × sellerAmount / amount)` and `netShare = sellerAmount − feeShare`; both are null until the fee is known. |

### 7.4 Agents

- **Creating an agent:**
  - With `publicKeyX`, the facilitator validates it and derives `kid` with `kidFromPublicKeyX`.
  - Without it, the facilitator generates an Ed25519 key with `generateAgentKey` and returns the
    private key **once** as a JWK.
- **Response:** `{ agent: { id, name, kid, keyFingerprint, status, createdAt }, privateKeyJwk? }`.
  - `keyFingerprint` is `ed25519:` plus the first 6 and last 4 characters of `kid`.
  - The private key is never stored.
- **Duplicate `kid`:** 409 `agent_key_exists`.

### 7.5 Browser and PayPal endpoints (unauthenticated)

| Method and path | Purpose |
|---|---|
| `GET /paypal/return?state=…` | Finishes linking (§8), then answers 302 to `${WEB_APP_URL}/link/complete?status=<wallet status>`, or a minimal HTML page if `WEB_APP_URL` is unset. An unknown or used `state` uses `status=unknown`. |
| `GET /paypal/cancel?state=…` | Marks the link `link_failed` (`link_error: 'cancelled'`), then redirects the same way |
| `POST /webhooks/paypal` | PayPal webhooks (§11) |
| `GET /healthz` | `{ ok: true }` when the database answers |

### 7.6 Events (either key)

`GET /v1/events` is a `text/event-stream` with `event: <type>` / `data: <json>` frames and a
`: keepalive` comment every 15 s. A key may hold at most 5 open streams; a 6th gets 429
`too_many_streams`.

Events are filtered to the caller, and each event has a separate operator variant and seller
variant:

| Event | Operator payload | Seller payload |
|---|---|---|
| `commitment.recorded` | `{ id, agentId, payTo, path, amount, recordedAt }` | `{ id, agentRef, path, amount, recordedAt }`, only for the seller's own `payTo` |
| `settlement.updated` | `{ id, status, trigger, amount, callsCount }` | `{ id, status, createdAt, sellerAmount, sellerCalls }`, only for settlements whose `settlement_items` include the seller, computed from those rows |
| `wallet.updated` | `{ status }` | not sent |
| `agent.updated` | `{ id, status }` | not sent |

- `settlement.updated` is emitted when a settlement is claimed (`pending`) and on every later
  status change.
- Operators only receive events about their own operator id.
- Seller payloads never include operator ids, agent ids or batch totals.
- The browser does not hold API keys (§13). The Phase 4 web app opens this stream from its own
  server, with the `Authorization` header, and relays it.


## 8. Linking a wallet

Wallet states and transitions:

| From | To | How |
|---|---|---|
| `not_linked`, `link_failed`, `stopped_by_payer` | `waiting_for_approval` | Linking starts |
| `waiting_for_approval` | `waiting_for_approval` | Linking restarts (a new `state` and setup token) |
| `waiting_for_approval` | `active` | Linking finishes (no uncollectable debt, or after the relink settlement completes) |
| `waiting_for_approval` | `link_failed` | Cancel, expiry, or a failed relink settlement |
| `active` | `unlinking` | The operator unlinks (§10) |
| `unlinking` | `not_linked` or `active` | §10 |
| `active`, `unlinking` | `stopped_by_payer` | Revocation (§12) |

Every transition that follows a PayPal call uses the compare-and-set rules in §5.

1. **`POST /v1/operator/wallet/link`:**
   - Allowed from `not_linked`, `link_failed`, `stopped_by_payer` and `waiting_for_approval`
     (restarting a link). Not allowed while a `relink` settlement is `pending`, nor while the
     wallet is `waiting_for_approval` with a stored payment token and any settlement is `pending`
     (a finished link waiting to claim its `relink`; restarting would delete that token). Both
     answer 409 `settlement_in_progress`.
   - Deletes any payment token stored from an earlier link at PayPal (ignoring "not found") and
     clears the vault columns.
   - Creates a Vault v3 setup token with:
     - `payment_source.paypal`: `usage_type: MERCHANT`, `usage_pattern: UNSCHEDULED_POSTPAID`,
       `customer_type: CONSUMER`
     - `experience_context`: `brand_name: "PayPer402"`, `shipping_preference: NO_SHIPPING`,
       `return_url = ${PUBLIC_BASE_URL}/paypal/return?state=<state>`, and the matching
       `cancel_url`
     - the description "PayPer402: your AI agents pay per API call; charges are batched to this
       PayPal account."
   - `state` is 16 random bytes. It is single use and stored in `link_state`.
   - Status becomes `waiting_for_approval`, with `link_started_at = now`. Clear `link_error`.
   - Returns the setup token's `approve` link and `expiresAt = link_started_at + 3 days`.
   - PayPal accepts `http://localhost` return URLs, as the vault spike used one. The
     `/refresh` endpoint covers the case where the browser cannot reach `PUBLIC_BASE_URL`.
2. **Finishing (`/paypal/return` or `/refresh`)**, only while `setup_token_id` is set:
   - Read the wallet's `link_state` and `setup_token_id`, then read the setup token from PayPal.
   - Not `APPROVED` yet: leave the wallet unchanged.
   - `APPROVED`: create a payment token with `PayPal-Request-Id = state`. This is idempotent, so
     a concurrent return and refresh receive the same token.
   - Store the result with compare-and-set rule (a) in §5: `vault_id_sealed`, `vault_id_hash`,
     `paypal_customer_id`, and `payer_email_masked` (the first 2 chars of the local part, then
     `***@domain`). Clear `link_state` and `setup_token_id`. Only the caller whose write
     succeeded continues below; the other returns the current wallet.
   - Then, in the same transaction as that write:
     - **No uncollectable commitments:** status becomes `active`, with `linked_at = now`.
     - **Uncollectable commitments exist:** status stays `waiting_for_approval` and a `relink`
       settlement is claimed and charged (§9). The binding spec requires outstanding
       uncollectable usage to be settled before the wallet is usable again.
3. **Relink outcomes:** applied when the `relink` settlement leaves `pending`, whether through
   the first attempt, a retry, a poll or a webhook. The wallet part uses compare-and-set rule (b)
   in §5. If the wallet no longer matches, only the settlement part applies.

   | Settlement outcome | Wallet |
   |---|---|
   | `completed` | `active`, `linked_at = now`; its commitments are `settled` |
   | `failed` (decline **or** revocation class) | `link_failed` with `link_error: 'relink_settlement_failed'`; the new payment token is deleted at PayPal and the vault columns cleared; the commitments go back to `uncollectable` and keep `settlement_id`. The wallet does **not** become `stopped_by_payer`; nothing new was ever usable. |
   | `needs_review` | Stays `waiting_for_approval`; nothing is deleted; agents stay blocked |
   | still `pending` (transient, `PENDING` capture) | No change until it resolves |

4. **Expiry:** a wallet in `waiting_for_approval` whose `setup_token_id` is set,
   `vault_id_sealed` is null and `link_started_at` is more than 3 days old (PayPal's setup-token
   expiry) becomes `link_failed` with `link_error: 'expired'`. Expiry never applies once a
   payment token exists.
5. **Unknown or used `state`:** answer with the redirect anyway. Reveal nothing and change
   nothing.

## 9. Redemption (settlements)

### 9.1 Triggers

- **threshold:** from the ledger's `onRecorded` hook and on every tick, for an operator whose
  wallet is `active` and has no `pending` settlement. It fires when
  `sum(amount of state 'unsettled') ≥ max(1, cap_unsettled − cap_per_call)`, so the charge starts
  before the next maximum-priced call could hit the unsettled cap.
- **daily:** on every tick, for an operator with an `active` wallet, no `pending` settlement, and
  at least one `unsettled` commitment recorded before `utcDayStart(now)`.
- **manual:** `POST /v1/settlements`, which requires an `active` wallet.
- **unlink:** §10.
- **relink:** §8.

Threshold and daily triggers are skipped while `wallets.charge_retry_after > now`.

The claim is the only gate. Two triggers that race (a hook and a tick, or a manual call and a
tick) both try to claim; the second finds a pending settlement, or no unsettled commitments, and
does nothing.

### 9.2 Claim

In one IMMEDIATE transaction:

- Abort if the operator already has a `pending` settlement.
- Select the commitments to include:
  - every `unsettled` commitment for the operator
  - for `relink`, also every `uncollectable` commitment
- Abort if there are none.
- Insert the settlement with `status: 'pending'`, `amount = sum`, `calls_count = count`,
  `paypal_request_id = id`, and `attempts = 0`.
- Insert one `settlement_items` row per commitment.
- Set the selected commitments to `state: 'settling'` and `settlement_id = id`.
- For `unlink`, the same transaction sets the wallet to `unlinking` (§10).

After the commit, emit `settlement.updated` (`pending`).

### 9.3 Charge and outcomes

- Call `chargeVaultedWallet` with `{ vaultId, amountCents: amount, requestId: paypal_request_id,
  invoiceId: settlement id, description: "PayPer402 usage: <calls_count> paid calls" }`.
- This creates an Orders v2 order with `intent: CAPTURE` and
  `payment_source.paypal.vault_id`, sending `Prefer: return=representation`.
- Decide the outcome from `purchase_units[0].payments.captures[0].status`, not the order
  status. If the order comes back `CREATED` or `APPROVED`, capture it with request id
  `<paypal_request_id>:capture`.

**How outcomes are written:**

- Every outcome is one transaction that starts with
  `UPDATE settlements SET … WHERE id = ? AND status = 'pending'`.
- If no row was affected, another path (first attempt, retry, poll or webhook) already resolved
  the settlement. Make no other change.
- Each of those paths reads a row, awaits PayPal, then writes, so their windows overlap; this
  compare-and-set is what keeps them consistent.
- After a successful write, emit `settlement.updated`. If the trigger is `unlink` or `relink`,
  also apply §10 or §8.

| Outcome | Settlement | Commitments | Wallet and other |
|---|---|---|---|
| Capture `COMPLETED` | `completed`, with order id, capture id, `fee`/`net` from `seller_receivable_breakdown`, and `completed_at` | `settled` | `charge_retry_after = NULL` |
| Capture `PENDING` | Stays `pending` with order id, capture id and `capture_status: 'PENDING'` | Unchanged | Resolved later by webhook (§11) or by polling `GET /v2/checkout/orders/{id}` each tick |
| Capture `DECLINED` / `FAILED`, or a **decline** error | `failed`, `failure_code: 'declined'`, `failure_reason` | Back to `unsettled`; `settlement_id` cleared (`settlement_items` keeps the record). If the wallet is no longer `active` or `unlinking` (for example revoked meanwhile), the batch becomes `uncollectable` instead and keeps `settlement_id`, so a later `relink` collects it. | `charge_retry_after = now + 900` (not for `relink`) |
| **Revocation** error | `failed`, `failure_code: 'payer_stopped'` | This batch and every other `unsettled` commitment of the operator become `uncollectable` | Wallet revoked (§12), except for `relink` (§8) |
| **Transient** error | Stays `pending`; `attempts += 1`; `next_attempt_at = now + [30, 120, 600][min(attempts−1, 2)]` | Unchanged | Retried with the **same** `paypal_request_id` |
| **Duplicate** error (`DUPLICATE_INVOICE_ID`, `ORDER_ALREADY_CAPTURED`) | If an order id is known, call `getOrder` and apply its capture outcome; otherwise `needs_review`. The order id comes from the stored `paypal_order_id` or from `PayPalApiError.orderId`, which the client fills in when the failing call was the capture leg `/v2/checkout/orders/{id}/capture`. | Unchanged until resolved | — |
| **Other** error | `needs_review`, with the error recorded | Stay `settling` | Not retried automatically; the operator's unsettled cap keeps blocking new usage |

**PayPal error classes,** taken from `details[].issue` (not the top-level `name`):

- **Revocation:** `AGREEMENT_ALREADY_CANCELLED`, `TOKEN_ID_NOT_FOUND`, `TOKEN_NOT_FOUND`,
  `BILLING_AGREEMENT_NOT_FOUND`.
- **Decline:** `INSTRUMENT_DECLINED`, `PAYER_CANNOT_PAY`, `TRANSACTION_REFUSED`,
  `PAYER_ACCOUNT_RESTRICTED`, `PAYMENT_SOURCE_DECLINED_BY_PROCESSOR`, `PAYER_ACTION_REQUIRED`.
- **Duplicate:** `DUPLICATE_INVOICE_ID`, `ORDER_ALREADY_CAPTURED`.
- **Transient:** network errors, timeouts, HTTP 5xx and HTTP 429.
- **Other:** everything else.

**Deviation from CLAUDE.md, noted deliberately.** CLAUDE.md says "if settlement fails, stop
serving". Here, after a decline, the agents keep working until the unsettled cap blocks them.
Because the threshold fires at `cap_unsettled − cap_per_call`, that is at most about one more
`cap_per_call` of usage. The loss bound is the same `cap_unsettled`, and a transient decline does
not take the operator offline.

### 9.4 Crash safety and double-charge prevention

- The settlement row, its items and the commitment claim are committed **before** PayPal is
  called. The PayPal request id is the settlement id, so a retry after a crash reuses it.
- **PayPal request ids:**
  - PayPal's Orders reference documents `PayPal-Request-Id` retention as 6 hours (extendable to
    72), and requires it for single-step orders with `vault_id`. The Vault docs say 3 hours.
  - So a `pending` settlement with no order id that is older than **2 hours** becomes
    `needs_review` instead of being retried. This stays inside both windows.
- **Second guard:** `invoice_id = settlement id`. PayPal requires an `invoice_id` to be unique
  within a merchant account by default, so a duplicate charge under the same invoice is refused
  with `DUPLICATE_INVOICE_ID`.
- **On a thrown charge error nothing is stored.** The retry repeats the create with the same
  request id, and PayPal returns the earlier result if it already processed it.
- **Recovery work,** on start-up and on every tick:
  - retry due `pending` settlements that have no order id (`next_attempt_at ≤ now`)
  - poll those that have an order id and a `PENDING` capture
- **Bound:** the facilitator MUST NOT charge an operator more than the sum of the commitments in
  the settlement. Each of those is at most its signed `maxAmount`.

## 10. Unlinking

`POST /v1/operator/wallet/unlink`, allowed only from `active`:

1. **Check, set and claim in one transaction.** Check that the wallet is `active` and that the
   operator has no `pending` settlement. If a pending settlement exists, abort the transaction
   and answer 409 `settlement_in_progress`. There is no `await` between the check and the writes
   of step 2, because they are the same transaction.
2. In that transaction, set the wallet to `unlinking`, and claim an `unlink` settlement if there
   are `unsettled` commitments.
   - `unlinking` maps to `unlinked` in the registry, so from this moment verification fails with
     `wallet_not_linked`. No new commitment can be recorded while unlinking.
3. If a settlement was claimed, charge it and wait for its first attempt:
   - `completed`: continue to step 4.
   - `failed` with `declined`: set the wallet back to `active` and answer 409
     `settlement_failed`.
   - Still `pending` (transient error, or `PENDING` capture): leave the wallet `unlinking` and
     answer 409 `settlement_in_progress`. When the settlement resolves later:
     - `completed`: finish step 4
     - `failed` with `declined`: back to `active`
     - `needs_review`: the wallet stays `unlinking` (see the README for how a human resolves
       `needs_review`)
   - Revocation: the wallet becomes `stopped_by_payer` (§12). Answer 200 with the wallet.
   
   Every follow-up write in this step and in step 4 uses compare-and-set rule (c) in §5. If the
   wallet was revoked meanwhile (by webhook or health check), it stays `stopped_by_payer` and is
   never set back to `active`.
4. Delete the payment token at PayPal, ignoring "not found", and clear the vault columns. Then,
   with rule (c), set the status to `not_linked`. A wallet that was revoked meanwhile keeps
   `stopped_by_payer`. Emit `wallet.updated`.

## 11. PayPal webhooks

`POST /webhooks/paypal` takes the raw body, which must be captured as a string before any JSON
parsing. In Express 5, register `express.raw({ type: () => true, limit: '64kb' })` on this route
before the global JSON parser, so the JSON parser never touches it.

1. Without `PAYPAL_WEBHOOK_ID`, answer 503.
2. Verify with `POST /v1/notifications/verify-webhook-signature`:
   - Pass `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig` and `transmission_time`
     from the `PAYPAL-*` headers, plus `webhook_id`.
   - Pass `webhook_event` as the **raw body bytes**, spliced into the request JSON. PayPal
     requires the event exactly as received.
   - Anything except `verification_status: 'SUCCESS'` gets 400. The failure is logged (with the
     transmission id) and written to `audit_log`, **never** to `webhook_events`.
3. Deduplicate, only for verified events: insert into `webhook_events` keyed by event id. If it
   already exists, answer 200 and do nothing.
4. Handle the event:

| `event_type` | Handling |
|---|---|
| `VAULT.PAYMENT-TOKEN.DELETED` | Find the wallet by `vault_id_hash` of `resource.id`; if it is `active` or `unlinking`, revoke it (§12) |
| `PAYMENT.CAPTURE.COMPLETED` | Find the settlement by capture id (`resource.id`) or order id (`resource.supplementary_data.related_ids.order_id`); apply the `COMPLETED` outcome (fee and net from `resource.seller_receivable_breakdown`), with the compare-and-set of §9.3 |
| `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.DENIED` | The same lookup; apply the decline outcome |
| `PAYMENT.CAPTURE.PENDING` | Update `capture_status` |
| `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` | Audit log only (reversing the ledger is out of scope) |
| anything else | Store and ignore |

5. Answer 200 after handling. Record handling errors in `webhook_events.outcome` and still answer
   200, so a bug does not cause 25 retries.

## 12. Revocation detection

A wallet becomes `stopped_by_payer` through any of three paths:

1. **Charge errors:** a revocation class error during a settlement (§9.3). For `relink`, §8
   applies instead.
2. **Webhook:** `VAULT.PAYMENT-TOKEN.DELETED` (§11). PayPal does not document whether a payer's
   "Stop paying with PayPal" emits this event, so it is not relied on.
3. **Health check:**
   - On each tick, check the wallets that are `active` or `unlinking` and whose `last_checked_at`
     is null or older than `WALLET_CHECK_INTERVAL_SECONDS`. Check at most 10 per tick, oldest
     first, which keeps well under the sandbox rate limit.
   - Each check is `GET /v3/vault/payment-tokens/{id}`; set `last_checked_at` either way.
   - A 404, or a revocation-class issue, revokes the wallet.
   - Any other error (transient, or another 4xx) is ignored until the next check.
   - The vault spike showed a revoked token returning `404 TOKEN_NOT_FOUND`. This path makes the
     demo scene reliable.

**Revoking a wallet**, in one transaction, using compare-and-set rule (d) in §5 (only wallets in
`active` or `unlinking`):

- Set `status = 'stopped_by_payer'` and `stopped_at = now`.
- Set every `unsettled` commitment of the operator to `uncollectable`.
- Emit `wallet.updated`.

From then on, verification fails with `wallet_revoked`, through the registry mapping in §6. A
`pending` settlement goes on, and its charge resolves through §9.3.

## 13. Security notes

- **Request validation:** validate every request body with zod, and reject unknown top-level
  fields on write endpoints.
- **API keys stay on servers.** The Phase 4 web app calls `/v1/*` and `/v1/events` from its own
  server routes, with the operator or seller key in the `Authorization` header. The facilitator
  therefore sends **no CORS headers** on any route.
- **Rate limiting** is out of scope for Phase 2. Note it in the README as a production gap.
- **Error leakage:** error responses never include stack traces or PayPal secrets. PayPal
  `debug_id`s may be logged.
- **Sandbox guard:** `resolveApiBase` is enforced by the PayPal client and cannot be configured
  around.

## 14. Seed and demo data

`npm run seed -w apps/facilitator` creates, unless they exist:

- an operator "Northwind Research" with caps perCall 10, daily 1000, unsettled 500, total 5000,
  and a `not_linked` wallet
- a seller "Acme Data"
- one active agent with a generated key
- an operator key and a seller key

It prints the API keys and the agent's private key JWK **once**, to stdout.

Keys are stored only as hashes, so a later run cannot print them again. `--reset` deletes the
demo accounts and recreates them, which issues new keys.

## Change notes

- **Draft 3.2, after the Phase 2 audit (2026-10-16):**
  - payment-token and setup-token ids never appear in PayPal error paths or messages (the client
    shows `/v3/vault/payment-tokens/*`); logs and audit records carry only status, name, issues
    and debug id; `webhook_events.resource_id` stores the lookup hash for `VAULT.*` events
  - §9.3: a decline after the wallet left `active`/`unlinking` makes the batch `uncollectable`
  - §7.2/§7.5/§7.6: 409 `wallet_not_active`, 502 `paypal_unavailable`, 429 `too_many_streams`,
    `status=unknown` redirects, and unlink `needs_review` answering 409 `settlement_in_progress`
  - §8 step 1: no link restart while a finished link waits to claim its `relink`
  - activation clears `charge_retry_after`
- **Implementation notes (Phase 2 build, 2026-10-16).** Where the spec was silent the build chose
  (details in BUILD_SPEC "Findings"):
  - `needs_review` codes: `paypal_error` (other PayPal errors), `duplicate_without_order`,
    `duplicate_lookup_failed`, `no_capture`, `unexpected_capture_status`, `amount_mismatch`,
    `vault_unavailable`, `request_id_expired`
  - `settlements.vault_id_hash` is written in the claim transaction; each attempt checks the
    wallet still holds that token
  - revocation (charge error, health check, webhook) and unlink step 4 also match the vault id
    that was charged or checked
  - for `relink`, a decline never sets `charge_retry_after`, and a completion clears it only
    when rule (b) matched
  - a tick step claims a `relink` for a wallet that finished linking while another settlement was
    pending
  - health checks take never-checked wallets first
  - a failed token deletion at PayPal does not block unlink or a failed relink; it is audited
- **Draft 3.1, after the third review (which passed):**
  - delete an orphaned payment token when a finish loses to a link restart
  - unlink's pending-settlement check runs inside the claim transaction
  - clarified wording of rule (c)
- **Draft 3, after the second review:**
  - compare-and-set rules (a)–(d) for every wallet write that follows a PayPal call
  - `settlements.vault_id_hash`
  - state-table additions (link restart, `unlinking → stopped_by_payer`)
  - the duplicate-error branch uses `PayPalApiError.orderId`
  - relink failures keep `settlement_id`
  - Express 5 raw-body registration
- **Draft 2, after the first review:**
  - relink state rules and expiry guard
  - `settlement_items`, and compare-and-set outcomes
  - events from the ledger's insert path
  - webhook de-duplication for verified events only
  - the `unlinking` status
  - seller event variants
  - no CORS, because API keys stay server-side
  - `since`/`until` filters and the `path` field
  - health-check pacing
  - the PayPal request-id retention facts
  - HKDF lookup key
