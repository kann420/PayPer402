# PayPer402 facilitator

The service behind the `batch-settlement` / `paypal:sandbox` x402 binding. It:

- verifies and records signed commitments for sellers (`/x402/verify`, `/x402/settle`, `/x402/supported`)
- links an operator's PayPal wallet once (Vault v3 setup token, then payment token)
- enforces the operator's caps
- charges the linked wallet in batches (Orders v2 with the vault id), never more than the sum of
  the recorded commitments
- notices revocation through charge errors, the `VAULT.PAYMENT-TOKEN.DELETED` webhook and a
  wallet health check, for every operator that holds the revoked payment token
- serves operator and seller read APIs and a live event stream (SSE)

It runs on the **PayPal sandbox only**; the PayPal client refuses the live host. Behaviour, data
model and HTTP API are defined in [docs/spec/facilitator.md](../../docs/spec/facilitator.md); the
protocol rules in [docs/spec/scheme_batch_settlement_paypal.md](../../docs/spec/scheme_batch_settlement_paypal.md).

## Configuration

Environment variables, validated at start-up (the process refuses to start if one is invalid).
The npm scripts load the root `.env` with Node's `--env-file-if-exists`; see the root
`.env.example`.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `PORT` | no | `4020` | HTTP port |
| `DATABASE_PATH` | no | `./data/facilitator.db` | SQLite file |
| `PUBLIC_BASE_URL` | yes | — | External base URL, used for the PayPal return and cancel URLs |
| `WEB_APP_URL` | no | — | Where the browser goes after linking; without it a minimal page is shown |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | yes | — | Sandbox REST app |
| `PAYPAL_API_BASE` | no | sandbox | Must be the sandbox host |
| `PAYPAL_WEBHOOK_ID` | no | — | Without it `/webhooks/paypal` answers 503 |
| `DATA_ENCRYPTION_KEY` | yes | — | 64 hex chars; AES-256-GCM key for the stored vault ids |
| `API_KEY_PEPPER` | yes | — | At least 32 chars; HMAC key for API key hashes |
| `SETTLEMENT_TICK_SECONDS` | no | `15` | Job tick |
| `WALLET_CHECK_INTERVAL_SECONDS` | no | `30` | Health check period per linked wallet |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error` |

## Running

```bash
npm run seed -w apps/facilitator          # demo operator, seller, agent and API keys (printed once)
npm run seed -w apps/facilitator -- --reset   # delete and recreate them; issues new keys
npm run dev -w apps/facilitator           # watch mode
npm run start -w apps/facilitator
```

The seed creates the operator "Northwind Research" (caps: per call 10, daily 1000, unsettled
500, total 5000 cents) with a `not_linked` wallet, the seller "Acme Data" (its id is its `payTo`),
one active agent with a generated Ed25519 key, and one operator and one seller API key. Keys are
stored only as HMAC hashes, so a later run cannot print them again.

Callers authenticate with `Authorization: Bearer <key>`: operator keys for `/v1/operator`,
`/v1/agents`, `/v1/commitments` and `/v1/settlements`; seller keys for `/v1/seller` and `/x402`;
either for `/v1/events`. A seller's `@x402/express` app points an `HTTPFacilitatorClient` at
`<facilitator>/x402` with `createAuthHeaders` returning the seller key for `verify`, `settle` and
`supported`.

Jobs (one tick every `SETTLEMENT_TICK_SECONDS`, and once at start-up for crash recovery): link
expiry, settlement retries and capture polling, threshold and daily triggers, and wallet health
checks (at most 10 per tick).

## Shared payment tokens

PayPal keeps one agreement per payer and merchant. A payer who links the same PayPal account to
a second operator gets the **same** payment token back, so several wallets can hold one token
(`wallets.vault_id_hash` is not unique since migration 2). See design spec §5.1.

- Each operator keeps its own caps, ledger, settlements and wallet status; every settlement is
  its own PayPal order against the shared token.
- **Revocation stops every holder.** A `VAULT.PAYMENT-TOKEN.DELETED` webhook, a health check that
  finds the token gone, or a revocation-class charge error sets every holder in `active` or
  `unlinking` to `stopped_by_payer`. A holder in `waiting_for_approval` is decided by its relink
  settlement instead.
- **Releasing instead of deleting.** Unlink, a link restart, a failed relink and a lost race
  delete the token at PayPal only when no other wallet in `active`, `unlinking` or
  `waiting_for_approval` holds it. Otherwise the token stays at PayPal, only this operator's
  columns are cleared, and the audit log records `wallet.token_kept_shared`.
- Finishing a link also works when the setup token is already `VAULTED` (an earlier attempt's
  result was lost). A non-transient failure of the payment-token step ends the link as
  `link_failed` with `link_error: 'payment_token_failed'`, so "Try again" restarts it.

## Sandbox end-to-end script

`npm run sandbox-e2e -w apps/facilitator` runs against the **real** PayPal sandbox and needs a
person twice. It needs only `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` and fails fast, listing
what is missing. It uses a temporary database and generates `DATA_ENCRYPTION_KEY` and
`API_KEY_PEPPER` for it when they are unset. It never prints secrets, API keys or vault ids.

1. Starts the facilitator on `PORT` (default 4020; `PUBLIC_BASE_URL` defaults to
   `http://localhost:<PORT>`) with a 10 s health check and a 5 s tick, and seeds an operator
   (caps: per call 5, daily 1000, unsettled 20), a seller and an agent.
2. Starts linking and prints the approval URL. Open it in a private window and sign in with the
   **US Personal sandbox** account. The script polls `/v1/operator/wallet/refresh` for up to 10
   minutes until the wallet is `active`.
3. Starts a seller route priced $0.05 and makes paid calls until a threshold settlement (at 15
   cents) completes. It checks that the settlement is `completed`, that its amount equals the sum
   of its commitments and that the PayPal capture is `COMPLETED`, and prints the order and capture
   ids to look up in the sandbox Business account's Activity.
4. Asks you to revoke: sign in to the Personal sandbox account, open the automatic payments
   settings and stop the agreement with "PayPer402", then press Enter.
5. Waits up to 90 s for the wallet to become `stopped_by_payer`, then checks that the next paid
   call gets `402` with `invalid_batch_settlement_paypal_wallet_revoked`.
6. Prints `RESULT: PASS` or `RESULT: FAIL` with the reason, and exits non-zero on failure.

`--skip-revoke` stops after step 3. Ctrl+C stops the script and removes the temporary database.

## Resolving a `needs_review` settlement

A settlement goes to `needs_review` when the facilitator cannot tell what happened at PayPal: an
unexpected PayPal error, a duplicate error without an order id, a capture amount that differs from
the settlement, an order without a capture, no order recorded within the 2-hour request-id window,
or a payment token that is no longer stored. Its commitments stay `settling`, so they keep counting
against the operator's unsettled cap, and nothing is retried automatically.

1. Find it: `SELECT * FROM settlements WHERE status = 'needs_review';`. Note `id`, `operator_id`,
   `trigger`, `paypal_order_id`, `failure_code` and `failure_reason`.
2. Check PayPal: sign in to the sandbox Business account and search Activity for the invoice id
   (it equals the settlement `id`), or look up `paypal_order_id`. Decide whether the money was
   captured.
3. Apply the outcome with `sqlite3 "$DATABASE_PATH"`, in one transaction. Replace `:id`, `:op`,
   `:order`, `:capture`, `:fee`, `:net` (cents) and `:now` (unix seconds).

**Captured (`COMPLETED` at PayPal):**

```sql
BEGIN IMMEDIATE;
UPDATE settlements SET status = 'completed', paypal_order_id = :order, paypal_capture_id = :capture,
  capture_status = 'COMPLETED', fee = :fee, net = :net, completed_at = :now, updated_at = :now
  WHERE id = :id AND status = 'needs_review';
UPDATE commitments SET state = 'settled' WHERE settlement_id = :id AND state = 'settling';
-- trigger = 'relink' only:
UPDATE wallets SET status = 'active', linked_at = :now, updated_at = :now
  WHERE operator_id = :op AND status = 'waiting_for_approval'
    AND vault_id_hash = (SELECT vault_id_hash FROM settlements WHERE id = :id);
-- trigger = 'unlink' only (also delete the payment token in PayPal, or let the payer remove it,
-- unless another wallet in active, unlinking or waiting_for_approval has the same vault_id_hash).
-- Clear the charged token whether the wallet is still unlinking or was revoked meanwhile...
UPDATE wallets SET vault_id_sealed = NULL, vault_id_hash = NULL, paypal_customer_id = NULL,
  payer_email_masked = NULL, updated_at = :now
  WHERE operator_id = :op AND status IN ('unlinking', 'stopped_by_payer')
    AND vault_id_hash IS (SELECT vault_id_hash FROM settlements WHERE id = :id);
-- ...but only an unlinking wallet becomes not_linked; a revoked one stays stopped_by_payer.
UPDATE wallets SET status = 'not_linked', linked_at = NULL, updated_at = :now
  WHERE operator_id = :op AND status = 'unlinking';
INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, details, created_at)
  VALUES ('system', 'admin', 'settlement.resolved', 'settlement', :id, '{"outcome":"completed"}', :now);
COMMIT;
```

**Not captured (no order, or declined):**

```sql
BEGIN IMMEDIATE;
UPDATE settlements SET status = 'failed', failure_code = 'declined',
  failure_reason = 'Resolved manually: not captured at PayPal', updated_at = :now
  WHERE id = :id AND status = 'needs_review';
-- trigger other than 'relink', wallet still active or unlinking: the commitments go back to
-- unsettled and are charged again later.
UPDATE commitments SET state = 'unsettled', settlement_id = NULL WHERE settlement_id = :id AND state = 'settling';
-- If the wallet is no longer active or unlinking (for example stopped_by_payer), use this instead,
-- so a later relink collects them:
-- UPDATE commitments SET state = 'uncollectable' WHERE settlement_id = :id AND state = 'settling';
-- trigger = 'relink' instead: the debt stays uncollectable and the new link fails
-- (also delete the new payment token in PayPal, unless another live wallet holds the same hash).
-- UPDATE commitments SET state = 'uncollectable' WHERE settlement_id = :id AND state = 'settling';
-- UPDATE wallets SET status = 'link_failed', link_error = 'relink_settlement_failed', vault_id_sealed = NULL,
--   vault_id_hash = NULL, paypal_customer_id = NULL, payer_email_masked = NULL, updated_at = :now
--   WHERE operator_id = :op AND status = 'waiting_for_approval'
--     AND vault_id_hash = (SELECT vault_id_hash FROM settlements WHERE id = :id);
-- trigger = 'unlink' only: the wallet stays linked.
UPDATE wallets SET status = 'active', updated_at = :now WHERE operator_id = :op AND status = 'unlinking';
INSERT INTO audit_log (actor_type, actor_id, action, resource_type, resource_id, details, created_at)
  VALUES ('system', 'admin', 'settlement.resolved', 'settlement', :id, '{"outcome":"not_captured"}', :now);
COMMIT;
```

Never edit or delete `settlement_items`: they are the permanent record of what the settlement
covered. Manual changes emit no live events; dashboards pick them up on their next refresh.

## Known production gaps

- **No rate limiting** on any route (out of scope for Phase 2).
- **Single process.** The claim, the compare-and-set writes and the job scheduler assume one
  Node.js process over one SQLite file. Running several instances needs a shared database and a
  distributed lock for the jobs.
- Webhook registration with PayPal and public HTTPS hosting come in Phase 5.
- `needs_review` resolution is manual (above); there is no admin endpoint.
- If deleting a payment token at PayPal fails (other than "not found") during unlink or a failed
  relink, the facilitator still clears its own copy and writes `wallet.token_delete_failed` to the
  audit log; the token must then be removed at PayPal by hand or by the payer.
- **Accepted race on shared tokens:** the "another live holder?" check and the PayPal DELETE are
  one PayPal round trip apart. If the same payer finishes a link on another operator inside that
  window, that operator's next charge or health check finds the token gone and revokes it; it can
  link again.
