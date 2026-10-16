# Phase 2 build spec: facilitator and PayPal settlement

Implementation plan for Phase 2 of [docs/ROADMAP.md](../ROADMAP.md). Draft 3: revised together
with design spec draft 3 after the second review.

- The behaviour, data model and HTTP API are defined in
  [docs/spec/facilitator.md](../spec/facilitator.md) (the **design spec**). The protocol rules
  stay in [docs/spec/scheme_batch_settlement_paypal.md](../spec/scheme_batch_settlement_paypal.md)
  (the **binding spec**).
- If this file disagrees with either spec, the specs win. Report the conflict; do not silently
  pick one.
- Read `CLAUDE.md` (and `CLAUDE.local.md` if present) first. All conventions apply: English
  only, sandbox only, no secrets in code or logs, no unlisted dependencies, no commit or push.

## Goal and exit criteria

Phase 2 is done when all of the following hold:

1. **`packages/paypal-client` is a typed, sandbox-only PayPal REST client.** It covers OAuth,
   Vault v3, Orders v2 and webhook verification, and is unit-tested against a fake `fetch`.
2. **`apps/facilitator` implements the design spec** end to end against a fake PayPal gateway,
   with automated tests:
   - x402 endpoints and seller ownership
   - SQLite stores
   - wallet linking and unlinking
   - settlement triggers, outcomes, retries and crash recovery
   - revocation by charge error, webhook and health check
   - webhooks with signature check and de-duplication
   - SSE events
   - operator and seller APIs
3. **An x402 end-to-end test passes inside Vitest:**
   - a seller Express app using `@x402/express` with an `HTTPFacilitatorClient` pointed at the
     running facilitator (seller key)
   - an agent using `@x402/fetch` with the PayPal client scheme
   - paid calls are recorded, a threshold settlement charges the fake PayPal, and after revocation
     the next call gets `402` with `invalid_batch_settlement_paypal_wallet_revoked`
4. **`apps/facilitator/scripts/sandbox-e2e.ts` exists and is documented.** It is run by the user
   against the real sandbox, because it needs a human to approve the link and to revoke it. Its
   PASS is the roadmap's "Done when" for Phase 2. The builder cannot run the human steps, but
   must make sure everything up to the approval link runs.
5. **These all pass:** `npm run typecheck`, `npm test`, and the name check in `CLAUDE.local.md`.

## Dependencies

| Package | Where |
|---|---|
| `better-sqlite3@^13`, `@types/better-sqlite3` (dev) | `apps/facilitator` |
| `express@^5`, `@types/express` (dev) | `apps/facilitator` |
| `zod@^4` | `apps/facilitator` |
| `@x402/core@2.28.0` (exact) | `apps/facilitator` |
| `@payper402/scheme-paypal`, `@payper402/paypal-client` (workspace, `"*"`) | `apps/facilitator` |
| `@x402/express@2.28.0`, `@x402/fetch@2.28.0` (exact, dev) | `apps/facilitator` (tests and sandbox script) |
| none | `packages/paypal-client` (plain `fetch`) |

- `better-sqlite3@13` was verified to install and run on Node 24 on Windows on 2026-10-16.
- Use Node's built-in `node:crypto` for HMAC, AES-GCM and random values. Do not add `helmet`,
  `cors`, `supertest`, `dotenv`, `uuid` or rate-limit packages.
- Load `.env` with Node's `--env-file-if-exists` flag in the npm scripts, for example
  `tsx --env-file-if-exists=../../.env src/server.ts`.

## Milestone 1: `packages/paypal-client`

Extend the existing package (it already has `resolveApiBase`).

### Files

```
src/config.ts       (exists) sandbox guard
src/money.ts        centsToUsdString, usdStringToCents (strict "D.CC" with at most 2 decimals)
src/errors.ts       PayPalApiError, PayPalNetworkError, classifyPayPalError, issue-code sets
src/client.ts       PayPalClient
src/types.ts        public request and result types
src/index.ts        exports
```

### `PayPalClient`

```ts
interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  apiBase?: string;             // goes through resolveApiBase
  fetch?: typeof fetch;         // injectable for tests
  now?: () => number;           // unix seconds
  timeoutMs?: number;           // per request, default 20_000
}

class PayPalClient {
  getAccessToken(): Promise<string>;
  createSetupToken(input: { returnUrl: string; cancelUrl: string; description: string;
    brandName: string; requestId: string }): Promise<{ id: string; status: string; approveUrl: string }>;
  getSetupToken(id: string): Promise<{ id: string; status: string }>;
  createPaymentToken(setupTokenId: string, requestId: string):
    Promise<{ id: string; customerId?: string; payerEmail?: string }>;
  getPaymentToken(id: string): Promise<{ id: string; customerId?: string; payerEmail?: string }>;
  deletePaymentToken(id: string): Promise<void>;
  chargeVaultedWallet(input: { vaultId: string; amountCents: number; requestId: string;
    invoiceId: string; description: string }): Promise<ChargeResult>;
  getOrder(orderId: string): Promise<ChargeResult>;
  verifyWebhookSignature(input: { headers: Record<string, string | undefined>;
    rawBody: string; webhookId: string }): Promise<boolean>;
}

interface ChargeResult {
  orderId: string;
  orderStatus: string;
  capture?: {
    id: string;
    status: string;                       // COMPLETED | PENDING | DECLINED | FAILED | ...
    statusReason?: string;
    amountCents: number;
    feeCents?: number;                    // seller_receivable_breakdown.paypal_fee
    netCents?: number;                    // seller_receivable_breakdown.net_amount
  };
}
```

**Access tokens:**

- Cache the token until `expires_in − 60` seconds have passed.
- Only one token request may be in flight at a time; concurrent callers await the same request.
- On a 401 from any call, refresh the token once and retry that call once.

**Request rules:**

- Every POST sends `PayPal-Request-Id` set to the given request id.
- Orders calls send `Prefer: return=representation`.
- `chargeVaultedWallet` sends:
  - `intent: CAPTURE`
  - one purchase unit with `amount { currency_code: "USD", value: centsToUsdString(amountCents) }`,
    `invoice_id`, `description` (truncated to 127 chars) and `custom_id = invoiceId`
  - `payment_source.paypal.vault_id`
  - If the order comes back `CREATED` or `APPROVED`, call
    `POST /v2/checkout/orders/{id}/capture` with request id `<requestId>:capture`.
- `getOrder` maps the same way.
- `verifyWebhookSignature` posts to `/v1/notifications/verify-webhook-signature` with:
  - `auth_algo`, `cert_url`, `transmission_id`, `transmission_sig` and `transmission_time`, read
    case-insensitively from the `paypal-auth-algo`, `paypal-cert-url`, `paypal-transmission-id`,
    `paypal-transmission-sig` and `paypal-transmission-time` headers
  - `webhook_id`
  - `webhook_event`, set to the **raw body**, spliced verbatim into the request JSON: build the
    JSON for the other fields, then insert `,"webhook_event":<rawBody>` before the closing brace.
    PayPal requires the event exactly as received.
  
  It returns `verification_status === "SUCCESS"`. Missing headers, or a `rawBody` that is not
  valid JSON, return `false` without a network call.

**Errors:**

- **`PayPalApiError`** has
  `{ httpStatus, name, message, issues: string[], debugId?, method, path, orderId? }`.
  - `issues` comes from `details[].issue`.
  - `orderId` is filled in when the failing call was on an order path, such as the capture leg
    `/v2/checkout/orders/{id}/capture`. The design spec's duplicate-error branch uses it.
- **`PayPalNetworkError`** covers network errors, timeouts and unparseable responses.
- **`classifyPayPalError(err)`** returns `'revocation' | 'decline' | 'duplicate' | 'transient' |
  'other'`, using the issue sets in design spec §9.3:
  - HTTP 5xx, HTTP 429 and `PayPalNetworkError` are `transient`.
  - A 404 from `getPaymentToken` is a revocation for the health check, but **the client does not
    decide that**; it only exposes `httpStatus`.

**Logging:** never log or throw the client secret or the access token. Errors may include
`debugId`.

### Tests (fake `fetch`)

Assert the exact URLs, methods, headers and bodies:

- token caching, single-flight, and the refresh-on-401 retry
- setup token, payment token, get and delete
- a charge that returns `COMPLETED` directly
- a charge that needs a capture call
- a `PENDING` capture
- a 422 `AGREEMENT_ALREADY_CANCELLED` (classified `revocation`)
- `INSTRUMENT_DECLINED` (`decline`)
- `DUPLICATE_INVOICE_ID` (`duplicate`)
- a 500, a 429 and a network error (all `transient`)
- money conversion boundaries
- webhook verify: success, failure, and missing headers
- the sandbox guard still refuses the live host

## Milestone 2: facilitator foundation

### Layout

```
apps/facilitator/
  package.json            scripts: dev, start, seed, sandbox-e2e, typecheck
  src/config.ts           zod env schema (design spec §3) → typed Config
  src/db/connection.ts    open(path), pragmas
  src/db/migrations.ts    numbered migrations, schema_migrations, refuse newer DB
  src/crypto.ts           seal/open (AES-256-GCM, "v1.<iv>.<tag>.<ct>"), HKDF-derived lookup key
                          for vault_id_hash (design spec §5), hmacHex, randomId(prefix)
  src/auth.ts             API key format, hashing, Bearer middleware, role guards
  src/http.ts             request id, JSON body limits, raw-body capture for the webhook route,
                          error type + terminal error handler, zod validation helper. No CORS
                          (design spec §13).
  src/events.ts           typed in-process event bus (emit/subscribe/dispose; handler errors caught)
  src/audit.ts            recordAudit (best effort, details ≤ 16 KB)
  src/paypal.ts           PayPalGateway interface (the subset of PayPalClient that is used)
                          and an adapter from PayPalClient
  src/app.ts              createApp(deps): Express app; no I/O at import time
  src/server.ts           main: load config, open DB, build deps, listen, start jobs, SIGTERM
  scripts/seed.ts         design spec §14
```

- **`createApp(deps)`** takes
  `{ config, db, paypal: PayPalGateway, clock: () => number, events, logger }`. Tests build it
  with `:memory:` SQLite, a fake gateway and a fake clock.
- **Ported code:** you may port helpers from the earlier project listed in `CLAUDE.local.md`
  (event bus, secret box, audit, migration runner). Port them to TypeScript and follow its naming
  and licensing rules.

### Tests

- config validation
- migrations from empty (including the partial unique index on pending settlements), plus
  refusal of a newer database
- seal/open round trip, tamper detection, a wrong key, and the lookup key differing from the AES
  key
- API key hashing and auth middleware: 401, 403 and a good key
- request id handling
- the error handler shape
- no CORS headers on any route
- the seed script is idempotent, and `--reset` reissues keys

**better-sqlite3 transactions:** transaction functions must be synchronous. Never `await` inside
`db.transaction(...)`. Read, call PayPal, then write in a new transaction, as the design spec's
compare-and-set rules describe.

## Milestone 3: stores and x402 endpoints

```
src/stores.ts             SqliteAgentRegistry, SqliteCommitmentLedger (design spec §6)
src/routes/x402.ts        POST /x402/verify, POST /x402/settle, GET /x402/supported (§7.1)
```

- Build one `x402Facilitator` with `PayPalBatchFacilitatorScheme({ agents, ledger, now })`,
  registered on `paypal:sandbox`.
- Do the seller ownership checks (§7.1) before calling the facilitator.
- **`SqliteCommitmentLedger` takes an `onRecorded(record)` callback** (design spec §6).
  - It is called only on the insert path, after the transaction commits, with errors caught.
  - The app wires it to emit `commitment.recorded` and to schedule the threshold check. The
    route does neither.

### Tests

- **Store contract tests:** run the scheme package's own expectations against the SQLite stores:
  duplicate versus replay, cap order, snapshot definitions, the UTC day boundary, and atomicity
  under parallel `record` calls.
- **Endpoints:** body validation (400), auth (401/403), `payTo` mismatch for verify and settle,
  and a settle short-circuit retry by a different seller is refused.
- **Identical settle retry:** an identical retry returns the original result, emits **no**
  `commitment.recorded` event, and schedules no threshold check.
- **x402 end to end over real HTTP** (servers on port 0):
  - a seller Express app with `paymentMiddleware` and `HTTPFacilitatorClient({ url:
    <facilitator>/x402, createAuthHeaders })`
  - an agent using `wrapFetchWithPayment` with `PayPalBatchClientScheme`
  - assert a `402` then a `200`, the commitment row, and the `commitment.recorded` event

## Milestone 4: wallets and revocation

```
src/services/wallets.ts   link, finish (return/refresh), cancel, expire, unlink, revoke, health check
src/routes/operator.ts    /v1/operator, caps, wallet link/refresh/unlink (§7.2)
src/routes/paypal.ts      /paypal/return, /paypal/cancel (§7.5)
```

Follow design spec §8, §10 and §12 exactly, including:

- the state table
- **the compare-and-set rules (a)–(d) in design spec §5** for every wallet write that follows a
  PayPal call
- the `relink` outcome table
- the expiry guard (only before a payment token exists)
- the `unlinking` status
- masked email
- single-use `state`
- health-check pacing (at most 10 per tick)

### Tests (fake gateway, fake clock)

- the full link happy path
- not yet approved, then approved on refresh
- cancel
- an unknown `state`
- expiry before approval
- no expiry once a payment token exists
- link while `active` or `unlinking` (409)
- link or refresh while a relink settlement is pending (409)
- relink with uncollectable commitments:
  - completed → `active`
  - declined → `link_failed`, token deleted, commitments back to `uncollectable`, not
    `stopped_by_payer`
  - revocation error → the same as declined
  - `needs_review` → stays `waiting_for_approval`
  - `PENDING` capture resolved later by webhook → `active`
- unlink:
  - with no unsettled commitments
  - with a successful unlink settlement
  - with a declined one (409, back to `active`)
  - with a pending one (409, stays `unlinking`; it finishes when the settlement completes)
  - **a commitment presented while `unlinking` is refused with `wallet_not_linked`**
- **compare-and-set races,** made deterministic with a fake gateway whose calls resolve in an
  order the test controls:
  - a concurrent `/paypal/return` and `/refresh` with uncollectable debt produce exactly one
    `relink` settlement, and the wallet is not `active` until it completes
  - a concurrent return and refresh without debt both answer normally, and one write wins
  - a link restart during an in-flight finish of the old setup token leaves the new link intact,
    and the orphaned payment token from the old finish is deleted at PayPal
  - a webhook revocation during a pending `unlink` settlement, followed by a decline, leaves the
    wallet `stopped_by_payer`
  - unlink racing a threshold claim: if a pending settlement exists when unlink's transaction
    runs, unlink answers 409 and the wallet stays `active`
  - a relink outcome applied after a link restart leaves the new wallet alone and deletes
    nothing. This cannot happen through public paths, so the test calls the outcome routine
    directly. It guards the manual `needs_review` resolution.
- revocation by health check (404) and by webhook, both followed by verify returning
  `wallet_revoked`
- health-check errors other than 404 and revocation (transient, 403) are ignored
- vault ids are stored sealed (the raw id never appears in the `wallets` row)

## Milestone 5: settlements, webhooks, events, read APIs

Build in this order: settlements → webhooks → read APIs → SSE. Keep `audit_log` minimal. Build
the SSE per-key stream limit last.

```
src/services/settlements.ts  triggers, claim (with settlement_items), charge, compare-and-set
                             outcomes, retry, recovery (§9)
src/jobs.ts                  tick scheduler: due retries, capture polling, threshold and daily
                             triggers, health checks, link expiry; re-entrancy guard; stop();
                             export runTick(now) so tests drive jobs without timers
src/routes/webhooks.ts       §11
src/routes/agents.ts         §7.2 and §7.4
src/routes/reads.ts          /v1/commitments, /v1/settlements[/:id], POST /v1/settlements
src/routes/seller.ts         §7.3
src/routes/events.ts         SSE §7.6
```

### Tests (fake gateway, fake clock)

Settlement:

- the threshold trigger fires at `cap_unsettled − cap_per_call` and not before
- the daily trigger fires after a UTC midnight
- manual: 201, plus 409 `nothing_to_settle`, `settlement_in_progress` and `wallet_not_active`
- each outcome in design spec §9.3: COMPLETED, PENDING (resolved later by poll and by webhook),
  DECLINED, decline error, revocation error, transient (retried with the **same** request id,
  backoff, `needs_review` after 2 h), duplicate
- duplicate error with a stored order id → `getOrder`, then the capture outcome; without one →
  `needs_review`
- `charge_retry_after` suppresses automatic triggers
- crash recovery: a `pending` row with no order id at start-up is retried with the same request
  id
- **compare-and-set:** a poll result and a webhook for the same settlement applied in either
  order leave one consistent outcome; the second is a no-op
- invariants, via `settlement_items`, for every status including `failed`: the amount equals the
  sum, the count matches, and an operator has at most one `pending` settlement
- a failed settlement still lists its items in `GET /v1/settlements/:id`
- `needs_review` keeps the operator's agents blocked once the unsettled cap is reached
- an operator is never charged more than the sum of its commitments
- concurrent triggers produce only one settlement

Webhooks:

- missing webhook id (503)
- a bad signature (400), which does **not** create a `webhook_events` row; afterwards the genuine
  event with the same id is processed normally
- a duplicate verified event id (200, no effect)
- each handled event type
- an unknown event is stored

Other:

- **agents:** create with a generated key (private key returned once, never stored), create with
  a supplied key, a duplicate kid (409), pause and resume (verify then gives `agent_disabled`),
  and the derived `blocked` flag
- **read APIs:**
  - pagination with `before`
  - `since`/`until` filters
  - the `path` field
  - operator scoping (another operator's data is never visible)
  - seller scoping through `settlement_items`
  - the `agentRef` hiding the agent id
  - the fee share computation
- **SSE:**
  - events reach the right subscriber only
  - seller payloads carry no operator id, agent id or batch total
  - `settlement.updated` is sent on claim and on every resolution
  - keepalive is sent
  - the stream limit is enforced

## Milestone 6: sandbox script and docs

`scripts/sandbox-e2e.ts` (`npm run sandbox-e2e -w apps/facilitator`) runs against the real
sandbox, with credentials from the root `.env`:

1. Starts the facilitator on `PORT` with a temporary database file,
   `WALLET_CHECK_INTERVAL_SECONDS=10` and `SETTLEMENT_TICK_SECONDS=5`, and seeds an operator
   (caps: perCall 5, daily 1000, unsettled 20), a seller and an agent.
   `PUBLIC_BASE_URL` defaults to `http://localhost:<PORT>` for this script.
2. Starts linking and prints the approval URL with instructions: open it in a private window and
   sign in with the **US Personal sandbox** account.
   - It then polls `/v1/operator/wallet/refresh` for up to 10 minutes until the wallet is
     `active`.
   - An unchanged wallet or a 409 means "keep polling". The browser's return to `/paypal/return`
     may finish the link first, and that is expected.
3. Starts a seller route priced `$0.05` (`@x402/express` with `HTTPFacilitatorClient`) and makes
   paid calls with the agent until a threshold settlement completes. It asserts:
   - the settlement is `completed`
   - its amount equals the sum of its commitments
   - the PayPal capture is `COMPLETED`
   
   It prints the PayPal order and capture ids, so they can be checked in the sandbox Business
   account's Activity.
4. Prints revocation instructions and waits for Enter. The user signs in to the Personal sandbox
   account, opens the settings for automatic payments, and stops the agreement with the
   sandbox Business account (the setup token's brand name is "PayPer402").
5. Waits up to 90 s for the wallet to become `stopped_by_payer`, then asserts the next paid call
   gets `402` with `invalid_batch_settlement_paypal_wallet_revoked`.
6. Prints `RESULT: PASS` or `RESULT: FAIL` with the reason, and exits non-zero on failure.

`--skip-revoke` stops after step 3. The script never prints secrets, API keys or vault ids.

**Docs:**

- `apps/facilitator/README.md`, covering:
  - what it is
  - configuration
  - how to run it and how to seed
  - the sandbox script steps
  - **how a human resolves a `needs_review` settlement:** check the order in the PayPal sandbox,
    then apply the outcome through a small documented SQL procedure or admin script
  - known production gaps (rate limiting, single process)
- Add the new variables to the root `.env.example`, with placeholders only.
- Keep both specs in sync with what was built, with change notes.
- Tick the Phase 2 tasks in `docs/ROADMAP.md`, except the sandbox-script PASS, which the user
  confirms. Do not move the "Current phase" marker.

## Findings

Builder notes from the build (2026-10-16). Deviations are also listed in the design spec's change
notes.

**SDK, PayPal, SQLite, tooling:**

- `HTTPFacilitatorClient` validates every 2xx body with zod (`verifyResponseSchema`,
  `settleResponseSchema`): a settle failure built by the route must carry `transaction: ''` and
  `network`, or the seller's middleware throws `FacilitatorResponseError`.
- `x402Facilitator.verify/settle` throw (not `isValid: false`) for an unregistered x402 version,
  scheme or network. The route pre-checks these and answers 200 with the binding codes, so a
  seller never sees a 500 for a payment-level problem.
- Express 5: `express.raw({ type: () => true, limit: '64kb' })` on `/webhooks/paypal` before the
  global JSON parser works as specified; `req.body` is a `Buffer`.
- better-sqlite3 13.0.3 loaded on Node 24 / Windows without changes (SQLite 3.53.4).
  `@types/better-sqlite3` resolved to ^9.6.0 and types the v13 API used here.
- The root `node_modules/zod` is 3.25 (hoisted from the x402 SDK); `apps/facilitator` resolves
  its own zod 4.6.7. The facilitator never mixes in SDK zod schemas.
- `npm install -w apps/facilitator` on a brand-new workspace folder only linked the workspace the
  first time; a second identical run installed the dependencies. npm warns about allow-scripts for
  esbuild only.
- Real sandbox (scripts/sandbox-e2e.ts, run up to the approval link): OAuth and
  `POST /v3/vault/setup-tokens` succeeded; the approve link has the form
  `https://www.sandbox.paypal.com/agreements/approve?approval_session_id=…`. The human steps
  (approval, charge, revocation) are for the user's run.

**Choices where the specs were silent (all reported, none change the design):**

- Error codes not listed in the spec: unlink from a non-`active` wallet answers 409
  `wallet_not_active`; PayPal failures during link/refresh answer 502 `paypal_unavailable`; a 6th
  SSE stream answers 429 `too_many_streams`; an unknown `state` redirects with
  `status=unknown`.
- Unlink whose first attempt ends in `needs_review` answers 409 `settlement_in_progress` (wallet
  stays `unlinking`).
- `needs_review` codes: `paypal_error` (an "other" PayPal error), `duplicate_without_order`, and
  for outcomes not in the §9.3 table: an order without a capture
  (`no_capture`), an unknown capture status (`unexpected_capture_status`), a capture amount that
  differs from the settlement (`amount_mismatch`), a retry whose stored payment token is gone or
  changed (`vault_unavailable`), a duplicate whose order lookup fails with a non-transient error
  (`duplicate_lookup_failed`), and the 2-hour window (`request_id_expired`).
- `settlements.vault_id_hash` is written in the claim transaction (immediately before the first
  charge) rather than at the charge call; every attempt then checks that the wallet still holds
  that token.
- Revocation writes from a charge error, the health check and the webhook also require the
  wallet to still hold the vault id that was checked or charged, so a late result never revokes
  a newer link. Unlink step 4 likewise only clears the vault it charged.
- For `relink`, a decline never sets `charge_retry_after`, and a completion clears it only when
  rule (b) matched, so a restarted wallet is truly "left alone". Activation without debt also
  clears it.
- A finished link whose relink claim finds another settlement pending (possible after a
  revocation with a retrying threshold settlement) keeps the wallet `waiting_for_approval`; a new
  tick step (`resume_relinks`) claims the relink once nothing is pending.
- Health checks take never-checked wallets first, then the oldest check.
- If deleting a payment token at PayPal fails (not 404) during unlink or a failed relink, the
  facilitator still clears its copy and audits `wallet.token_delete_failed`.
- `verifyWebhookSignature` returns false on a 4xx from PayPal (route answers 400) and throws on
  5xx/network errors (route answers 500 so PayPal retries).
- `/x402/*` checks only the outer body shape; inner objects pass through (strict validation
  applies to `/v1` write endpoints).
- List envelopes: `{ commitments }`, `{ settlements }`, `{ agents }`; single objects:
  `{ settlement }`, `{ agent, privateKeyJwk? }`, `{ wallet }`, `{ caps }`. `since` is inclusive
  and `until` exclusive; `before` is exclusive.
- `lastChargeAt`/`Amount`/`Status` come from the most recent settlement by `created_at`.
- The sandbox script requires only the PayPal credentials and generates an ephemeral
  `DATA_ENCRYPTION_KEY` and `API_KEY_PEPPER` for its temporary database when unset.
- Extra files beyond the layout: `src/logger.ts`, `src/views.ts`, `src/db/rows.ts`,
  `src/services/context.ts`, `src/services/wallet-state.ts`, `src/seed.ts` (logic behind the
  thin `scripts/seed.ts`), `src/test-support.ts` (fake gateway and harness, tests only).
- Audit fixes (design spec draft 3.2): token ids are redacted from PayPal error paths and
  messages, logs and audit details carry only status/name/issues/debug id, `VAULT.*` webhook rows
  store the lookup hash; a decline after revocation makes the batch `uncollectable`; a link
  restart is refused while a finished link waits for its relink.
- No code was ported from the earlier project; the event bus, sealed values, audit and migration
  runner were written fresh, so `LICENSE` is unchanged.

## Working rules for the builder

- **Stay on branch `phase-2/facilitator`. Do not commit, push, or change git config.**
- Do not touch `spikes/`, the root `.env`, `docs/ui-brief.md`, or the "Development process"
  section of `CLAUDE.md`.
- The real PayPal sandbox may be called only from `scripts/sandbox-e2e.ts`. Tests always use the
  fake gateway.
- After each milestone, run `npm run typecheck` and `npm test`.
- Do not change the binding spec's rules. If the design spec is wrong or impossible somewhere,
  stop that part and report it with evidence.
- No `any` in exported types, no suppressed type errors, and no TODOs in place of required
  behaviour.
- When done, report:
  - what was built
  - test counts per package
  - deviations, with reasons
  - findings
  - open questions
