# Phase 1 build spec: x402 binding for PayPal

Implementation plan for Phase 1 of [docs/ROADMAP.md](../ROADMAP.md).

- The protocol rules live in [docs/spec/scheme_batch_settlement_paypal.md](../spec/scheme_batch_settlement_paypal.md)
  (the **binding spec**). This file says how to build it.
- If the two disagree, the binding spec wins. Report the conflict; do not silently pick one.
- Read `CLAUDE.md` first. Its conventions apply: English only, no dependencies beyond those listed
  here, sandbox only, no secrets.

Review history: v1 drafted 2026-10-15, reviewed the same day, and revised. This is v2.

## Goal and exit criteria

PayPal becomes an x402 network that plugs into the official SDK the same way the EVM network
does. Phase 1 is done when all of the following hold:

1. **The plumbing test (Milestone 1) passes**, and its findings are written under
   [Findings](#findings) below.
2. **`packages/scheme-paypal` implements** the client, resource-server and facilitator scheme
   interfaces for `batch-settlement` on `paypal:sandbox`, with in-memory stores.
3. **The end-to-end test passes:**
   - an Express route behind `paymentMiddleware` answers `402`
   - a client using `wrapFetchWithPayment` pays automatically and the route responds
   - the ledger holds exactly one commitment with the right amount
4. **Every failure case below is covered by a test** and fails with the binding spec's error code.
5. **These all pass:** `npm run typecheck`, `npm test`, and the name check in `CLAUDE.local.md`
   (if present).

Out of scope for Phase 1: any PayPal API call, SQLite, the HTTP facilitator service, caller
authentication, redemption or batching jobs, webhooks, the LLM agent, and any UI. The interfaces
are designed so that Phase 2 can plug those in without changing the scheme code.

## Dependencies

| Package | Where | Why |
|---|---|---|
| `@x402/core@2.28.0` | `scheme-paypal` dependency (already present) | Scheme interfaces, client, resource server, facilitator |
| `zod@^4` | `scheme-paypal` dependency | Payload validation. `@x402/core` brings its own zod 3; two copies are expected. |
| `@x402/express@2.28.0`, `@x402/fetch@2.28.0`, `express@^5`, `@types/express@^5` | `scheme-paypal` devDependencies | Tests only |

Pin the x402 packages to the exact same version. Use Node's built-in `node:crypto` for Ed25519
and SHA-256; do not add a crypto library.

## SDK facts (checked against the `@x402/core@2.28.0` runtime code during review)

**Import paths:**

- types from `@x402/core/types`
- `x402Client` from `@x402/core/client`
- `x402ResourceServer` from `@x402/core/server`
- `x402Facilitator` from `@x402/core/facilitator`
- `paymentMiddleware` and `setSettlementOverrides` from `@x402/express`
- `wrapFetchWithPayment` from `@x402/fetch`

**`Network`** is `` `${string}:${string}` ``.

- `x402Client.register` and `x402ResourceServer.register` accept wildcards such as `paypal:*`.
- **The facilitator must register the concrete network `paypal:sandbox`.** `getSupported()`
  echoes registered networks literally, and the resource server matches kinds by exact network.

**`SchemeNetworkClient`:**

- `scheme`
- optional `findDefaultAsset(asset, network)`
- `createPaymentPayload(x402Version, requirements, context?)` returns
  `{ x402Version, payload }`
- The client does not receive the resource URL.

**`SchemeNetworkServer`:**

- Members:
  - `scheme`, `defaultAssetTransferMethod`, `paymentFlows`
  - `parsePrice(price, network)` returns `{ asset, amount, extra? }`
  - optional `getAssetDecimals(asset, network)`
  - `enhancePaymentRequirements(requirements, supportedKind, facilitatorExtensions)`
- Use `defaultAssetTransferMethod: "default"` and
  `paymentFlows: { default: { supported: ["authorization"], default: "authorization" } }`.
  - This is the flow the EVM `batch-settlement` server uses.
  - Verify runs before the handler. Settle runs after the handler, but only when the handler
    succeeded (status below 400, no throw).
  - If settle fails, the middleware discards the buffered handler output and returns `402` with
    `PAYMENT-RESPONSE.errorReason`.
- The SDK sets `maxTimeoutSeconds` to `300` when a route omits it, before
  `enhancePaymentRequirements` runs.

**`SchemeNetworkFacilitator`:** `scheme`, `caipFamily`, `getExtra(network)`,
`getSigners(network)`, `verify(payload, requirements, context?)`,
`settle(payload, requirements, context?)`.

**`x402Facilitator`:**

- `register(networks, impl)`, `verify`, `settle`, `getSupported()`
- `getSupported()` is synchronous, while `FacilitatorClient.getSupported()` returns a promise.
  Hence the in-process adapter.

**Client spend controls:**

- By default the client only pays assets that the scheme's `findDefaultAsset` recognises. Without
  it, the client throws or filters out every PayPal requirement.
- The default cap is **$1 (100 cents) per payment**. Prices above that need
  `x402Client.setSpendControls`. Document this in the package README.

**Dynamic pricing:**

- A handler calls `setSettlementOverrides(res, { amount: "<cents>" })`. The facilitator's
  `settle` then receives `requirements.amount` equal to the override.
- `paymentPayload.accepted.amount` still holds the advertised maximum.
- The SDK does **not** bound the override; the facilitator must.

**Error visibility over HTTP:**

- On a verify failure, only `invalidReason` reaches the client, in the decoded
  `PAYMENT-REQUIRED` header's `error` field.
- On a settle failure, `errorReason` appears in the decoded `PAYMENT-RESPONSE`.
- `invalidMessage` and `extra` are not sent over HTTP.

If any of these turns out wrong at runtime, stop, record what actually happens under
[Findings](#findings), and adapt. Do not paper over it.

## Milestone 1: plumbing test

A fast proof that a custom scheme on a custom network runs through the official middleware and
fetch wrapper, before any real logic is written.

- **`packages/scheme-paypal/src/plumbing.test.ts`:**
  - The fake client returns `payload: { ok: true }`.
  - The fake server parses `$0.01` into `{ asset: "USD", amount: "1" }` and uses the flow config
    above.
  - The fake facilitator accepts everything, and its `settle` returns
    `{ success: true, transaction: "fake-<n>", network, amount: requirements.amount }`.
  - Wiring:
    - `x402Facilitator` with the fake scheme registered on `paypal:sandbox`
    - an in-process `FacilitatorClient` adapter
    - `x402ResourceServer` with the fake server scheme on `paypal:*`, then `await initialize()`
    - Express on port `0` with `paymentMiddleware`
    - a client built with `wrapFetchWithPayment(fetch, new x402Client().register("paypal:*",
      fakeClient))`
- **Assertions:**
  - the unpaid request gets `402` with a decodable `PAYMENT-REQUIRED` listing the PayPal
    requirement
  - the paid request gets `200` with a decodable `PAYMENT-RESPONSE`
  - a route that calls `setSettlementOverrides(res, { amount: "1" })` on a `$0.02` price makes
    the fake facilitator see `requirements.amount === "1"` and `accepted.amount === "2"`
- **Write the findings** (anything surprising) under [Findings](#findings).
- Close the "x402 plug-in spike" gate in `CLAUDE.md` when this passes.
- Keep the test once the real scheme exists; it guards the SDK wiring.

## Milestone 2: `packages/scheme-paypal`

### Files

```
src/constants.ts          PAYPAL_SANDBOX_NETWORK ("paypal:sandbox", keep this existing name),
                          PAYPAL_NETWORK_FAMILY ("paypal:*"), SCHEME, ASSET, BINDING_VERSION ("1.0.0"),
                          CLIENT_TTL_SECONDS (120), MAX_TIMEOUT_SECONDS (300),
                          CLOCK_SKEW_SECONDS (30), SETTLE_GRACE_SECONDS (60),
                          SIGNATURE_DOMAIN ("payper402/commitment/v1\n")
src/errors.ts             the binding spec's error codes, as a const object and a union type
src/money.ts              cents parsing and formatting
src/canonical.ts          RFC 8785 canonical JSON for plain objects of strings, safe integers and nested objects
src/keys.ts               Ed25519 agent keys: generate, kid, import/export (JWK and raw base64url)
src/commitment.ts         Commitment type, strict zod schema, build, sign, verify signature, payloadHash
src/stores.ts             AgentRegistry and CommitmentLedger interfaces
src/memory.ts             InMemoryAgentRegistry and InMemoryCommitmentLedger
src/client.ts             PayPalBatchClientScheme implements SchemeNetworkClient
src/server.ts             PayPalBatchServerScheme implements SchemeNetworkServer
src/facilitator.ts        PayPalBatchFacilitatorScheme implements SchemeNetworkFacilitator
src/local-facilitator.ts  localFacilitatorClient(facilitator: x402Facilitator): FacilitatorClient
src/index.ts              public exports (keep PAYPAL_SANDBOX_NETWORK, SCHEME, ASSET)
```

### Money (`money.ts`)

- **Cents are represented as `number`.**
  - Every parsed value goes through a range check after parsing: it must be a safe integer with
    `1 <= cents <= 10_000_000` ($100,000).
  - Zero is never a valid amount.
- **`parseCentsString(s)`** accepts only `/^[1-9][0-9]{0,7}$/`, then runs the range check. It
  throws otherwise.
- **`priceToCents(price)`:**
  - Accepts `"$0.05"`, `"0.05"`, or a number `0.05` (dollars) with at most 2 decimal places, or an
    `AssetAmount` with `asset: "USD"` and a cents `amount` string.
  - Parse decimal strings without floating-point arithmetic; convert a number input to its
    shortest decimal string first.
  - Reject more than 2 decimals, negatives, `NaN`, zero, and any other asset.
- **`centsToUsdString(cents)`** returns `"D.CC"` (for example 5 → `"0.05"`, 1234 → `"12.34"`).
  It is used in Phase 2 and tested now.

### Keys and signatures (`keys.ts`, `commitment.ts`, `canonical.ts`)

- **`generateAgentKey()`** returns `{ privateKey, publicKey, publicKeyX, kid }`, using
  `crypto.generateKeyPairSync("ed25519")`.
- **`publicKeyX`** is the JWK `x` member: the raw 32-byte key as base64url. Import it with
  `createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" })`.
- **`kid`** is base64url (no padding) of SHA-256 over the raw 32 bytes.
- **`id`** is `randomBytes(16)` as base64url, no padding.
- **Signing:**
  - `message = SIGNATURE_DOMAIN + canonical(commitment)`
  - `signature = crypto.sign(null, Buffer.from(message, "utf8"), privateKey)`, encoded base64url
  - Verification returns `false`, never throws, on bad input of any kind.
- **`payloadHash`** is base64url SHA-256 of `canonical(commitment) + "." + signature`. It does
  not include the settle amount.
- **`canonical()`:**
  - Recursively sorts keys by UTF-16 code unit and outputs no whitespace.
  - Accepts only strings, safe integers and plain objects; it throws on anything else.
  - Pin the exact output bytes with a test vector.
- **The zod schema for `commitment` MUST be `.strict()`.** Unknown fields are rejected, not
  stripped.

### Stores (`stores.ts`)

```ts
type WalletStatus = "active" | "revoked" | "unlinked";
type CapName = "perCall" | "daily" | "unsettled" | "total";

interface Caps {
  perCall: number;      // cents
  daily: number;        // cents per UTC day of recordedAt, settled + unsettled
  unsettled: number;    // cents not yet redeemed
  total?: number;       // cents, lifetime, optional
}

interface AgentRecord {
  agentId: string;
  kid: string;
  publicKeyX: string;   // raw public key, base64url
  operatorId: string;
  status: "active" | "disabled";
}

interface OperatorRecord {
  operatorId: string;
  walletStatus: WalletStatus;
  caps: Caps;
}

interface AgentRegistry {
  getAgentByKid(kid: string): Promise<AgentRecord | undefined>;
  getOperator(operatorId: string): Promise<OperatorRecord | undefined>;
}

interface SpendSnapshot { spentToday: number; unsettled: number; spentTotal: number }

interface CommitmentRecord {
  id: string;
  kid: string;
  agentId: string;
  operatorId: string;
  payTo: string;
  resourceUrl: string;
  maxAmount: number;    // cents, as signed
  amount: number;       // cents, actually charged
  iat: number;
  recordedAt: number;   // unix seconds
  state: "unsettled" | "settling" | "settled" | "uncollectable";
  payloadHash: string;
}

type RecordResult =
  | { ok: true; record: CommitmentRecord; duplicate: boolean; snapshot: SpendSnapshot }
  | { ok: false; reason: "replay" }
  | { ok: false; reason: "cap_exceeded"; cap: CapName };

interface CommitmentLedger {
  has(id: string): Promise<boolean>;
  get(id: string): Promise<CommitmentRecord | undefined>;
  snapshot(operatorId: string, nowSeconds: number): Promise<SpendSnapshot>;
  /**
   * Atomic. If `id` exists: same payloadHash → { ok: true, duplicate: true, original record };
   * different payloadHash → replay. Otherwise check caps with entry.amount, then insert.
   */
  record(entry: Omit<CommitmentRecord, "state">, caps: Caps, nowSeconds: number): Promise<RecordResult>;
}
```

`InMemoryCommitmentLedger.record` must be atomic. Do the check and the insert synchronously, with
no `await` in between, so that concurrent calls cannot both pass the cap check. Test it with
parallel `record` calls.

### Client scheme (`client.ts`)

- **Constructor:** `{ privateKey: KeyObject; now?: () => number; ttlSeconds?: number }`.
  `ttlSeconds` defaults to `CLIENT_TTL_SECONDS`.
- **`createPaymentPayload`:**
  - Validate the requirements: scheme, a `paypal:*` network, asset `USD`, a valid cents
    `amount`.
  - Build the commitment with
    `exp = iat + min(ttlSeconds, requirements.maxTimeoutSeconds || MAX, MAX)`, sign it, and return
    `{ x402Version, payload: { commitment, signature } }`.
- **`findDefaultAsset(asset, network)`** returns `{ asset: "USD", decimals: 2, symbol: "USD" }`
  for `"USD"` on `paypal:*`, and `undefined` otherwise.

### Server scheme (`server.ts`)

- `scheme = "batch-settlement"`, `defaultAssetTransferMethod = "default"`, with the
  `paymentFlows` above.
- `parsePrice(price, network)` returns `{ asset: "USD", amount: String(priceToCents(price)) }`,
  and rejects non-`paypal:*` networks.
- `getAssetDecimals` returns `2` for `USD` and `undefined` otherwise.
- `enhancePaymentRequirements` sets `extra.version = BINDING_VERSION`, keeps other `extra` fields,
  and clamps `maxTimeoutSeconds` to at most `MAX_TIMEOUT_SECONDS` (300 when missing or 0).

### Facilitator scheme (`facilitator.ts`)

- **Constructor:** `{ agents: AgentRegistry; ledger: CommitmentLedger; now?: () => number }`.
- **Static members:**
  - `scheme = "batch-settlement"`, `caipFamily = "paypal:*"`
  - `getExtra()` → `{ version: BINDING_VERSION }`
  - `getSigners()` → `[]`
- **`verify`:**
  - Implements binding-spec verification steps 1 to 8 in order.
  - On failure, returns `{ isValid: false, invalidReason, invalidMessage, extra? }`. Cap failures
    put `{ cap }` in `extra`. It never throws for client-caused problems.
  - On success, returns `{ isValid: true, payer: agentId, extra: { unsettledAmount,
    unsettledCap } }`, with amounts as cents strings.
- **`settle`** follows the binding spec's Settlement section exactly:
  - Re-run steps 1 to 6.
  - Check `commitment.maxAmount == accepted.amount`, and check `1 <= requirements.amount <=
    maxAmount`.
  - The expiry check uses the 60-second grace.
  - Then call `ledger.record`, which decides replay, idempotency and caps.
  - On success: `{ success: true, transaction: commitment.id, network, payer: agentId, amount,
    extra: { chargedAmount, unsettledAmount } }`.
  - A duplicate returns the original record's values.
  - On failure: `{ success: false, errorReason, errorMessage, transaction: "", network }`.
- **Register it on the concrete network:** `facilitator.register("paypal:sandbox", scheme)`.

### Local facilitator client (`local-facilitator.ts`)

`localFacilitatorClient(facilitator)` returns a `FacilitatorClient` that calls the facilitator in
process. `getSupported` wraps the synchronous result in a promise.

## Milestone 3: tests

Unit tests sit next to each module. End-to-end tests are in `src/e2e.test.ts`.

**End-to-end setup:**

- An Express app on port `0` with `GET /paid` priced `$0.05`, and `GET /dynamic` priced `$0.10`
  whose handler calls `setSettlementOverrides(res, { amount: "4" })`.
- An `x402ResourceServer` with `localFacilitatorClient`, then `initialize()`.
- An `x402Facilitator` with the PayPal facilitator scheme registered on `paypal:sandbox`.
- An in-memory registry and ledger seeded with one operator (active wallet; caps: perCall 25,
  daily 100, unsettled 50) and one active agent.
- Capture the commitment id on the client side with `x402Client.onAfterPaymentCreation`.

**Where error codes appear:** verify failures appear in the decoded `PAYMENT-REQUIRED.error`;
settle failures appear in the decoded `PAYMENT-RESPONSE.errorReason`.

**End-to-end cases** (assert status, decoded headers and ledger contents):

- **Happy path:**
  - The unpaid request gets `402`, then the paid one gets `200`.
  - `PAYMENT-RESPONSE.transaction` equals the captured commitment id.
  - The ledger has 1 record of 5 cents.
- **Dynamic price:** the record has `amount` 4 and `maxAmount` 10.
- **Unsettled cap:** repeated `$0.10` calls succeed until the unsettled total would exceed 50.
  The next call gets `402` with `error === "invalid_batch_settlement_paypal_cap_exceeded"`.
- **Revoked wallet:** set the operator's `walletStatus` to `revoked`. The next call gets `402`
  with `..._wallet_revoked`, and the ledger is unchanged.
- **Unknown agent:** a client with an unregistered key gets `402` with `..._unknown_agent`.

**Facilitator unit tests** call `verify` and `settle` directly with crafted payloads. Assert
`extra.cap` where relevant. Cases:

- bad signature, a signature over a different message, and garbage base64
- a tampered `maxAmount`, `payTo`, `network` or `asset`, and an unknown extra field in the
  commitment (rejected by the strict schema)
- expired; `iat` more than 30 s in the future; lifetime above 300 s; settle at `exp + 30` succeeds
  but settle at `exp + 61` fails
- replay:
  - verifying an already recorded id fails with `replay`
  - an identical settle retry returns the original result, even when the retry carries a
    different override amount
  - a different payload with the same id fails with `replay`
- a malformed `requirements.amount` (`"0"`, `"-1"`, `"1.5"`, `"01"`, `"abc"`)
- settle override amounts: `"0"`, and an amount above `maxAmount`, both fail with
  `amount_exceeds_commitment`
- per-call, daily and total caps, with the daily cap reset at the UTC day boundary under an
  injected clock
- a disabled agent
- an unlinked wallet
- a wallet revoked between verify and settle

**Other unit tests:** money (boundaries and rounding traps such as `0.1 + 0.2`), canonical JSON
(a pinned vector), and keys (`kid` derivation, a JWK round trip).

## Milestone 4: docs

- Keep the binding spec in sync with what was built. Note any rule that changed and why.
- Add `packages/scheme-paypal/README.md`: what the package is, a usage snippet for each role, the
  $1 default client spend cap and how to raise it, and a link to the binding spec.
- Tick the Phase 1 tasks in `docs/ROADMAP.md`. Do not move the "Current phase" marker; the final
  audit does that.

## Findings

Builder: record anything from Milestone 1 (or later) that differs from "SDK facts" or that
surprised you.

Milestone 1 (plumbing test, `src/plumbing.test.ts`) passed on `@x402/*@2.28.0`. Every "SDK fact"
above held at runtime, with these corrections and additions:

- **`FacilitatorClient` is not exported from `@x402/core/types`.** Import it from
  `@x402/core/server` (or `@x402/core/http`).
- **`x402Facilitator.getSupported()` types `kinds[].network` as `string`**, while
  `SupportedResponse` wants `Network`. The in-process adapter narrows it (a type-only cast; the
  value is always a registered network).
- **`wrapFetchWithPayment` returns the second `402` instead of throwing** when the paid retry is
  refused (verify or settle failure). End-to-end failure cases can use the wrapped fetch and read
  the headers.
- **Confirmed over HTTP:** a verify failure's `invalidReason` arrives as the decoded
  `PAYMENT-REQUIRED.error`; a settle failure discards the handler body and returns `402` with
  `PAYMENT-RESPONSE.errorReason`; a handler that answers `500` is not settled.
- **`enhancePaymentRequirements` may change `maxTimeoutSeconds`.** The SDK's immutability guard
  (`assertAcceptsAdditiveExtraAfterSchemeEnrich`) only runs for `enrichPaymentRequiredResponse`
  hooks, so the clamp of a route's `maxTimeoutSeconds: 600` to `300` works.
- **`npm install <pkg>@2.28.0` writes `^2.28.0`.** The x402 dev dependencies were edited back to
  the exact version.
- **The $1 default client cap is real:** `x402Client.createPaymentPayload` rejects a 150-cent
  PayPal requirement by default, accepts 100 cents, and accepts 150 after
  `setSpendControls({ maxAmountPerPayment: "$5" })` (tested in `client.test.ts`).

Later milestones (implementation choices and clarifications; the binding spec was updated to
match). The first two items change binding-spec rules and were accepted in the final audit; the
rest are clarifications:

- **Settle amount validation.** The test matrix wants override `"0"` to fail with
  `amount_exceeds_commitment`, but a literal re-run of step 1 would reject it as `payload`. In
  settle, step 1 validates `accepted.amount` as a cents string and only requires the settle
  amount to be a canonical base-10 integer (`"0"` allowed); `0` or anything above `maxAmount`
  then fails with `amount_exceeds_commitment`. `"-1"`, `"1.5"`, `"01"` and `"abc"` fail with
  `payload`.
- **Settle short-circuits identical retries (audit follow-up).** After the payload-shape check,
  settle looks up `commitment.id`; a record with the same `payloadHash` returns the original
  result at once, before the wallet, expiry and amount checks. A retry after revocation, after
  `exp + 60`, or with an out-of-range override now gets the original result; a different payload
  with the same id still fails with `replay`. `extra.unsettledAmount` on a retry is the current
  value.
- **Audit hardening.** `settle` and `verify` return `payload` for null or missing
  requirements instead of throwing. `exceededCap` fails closed on NaN or missing caps, and
  `InMemoryAgentRegistry` validates caps (`assertValidCaps`) and rejects an agent whose `kid`
  does not match its public key or is already registered.
- **`/supported` signers:** `x402Facilitator.getSupported()` keys signers by `caipFamily`, so
  the PayPal kind yields `"signers": { "paypal:*": [] }`, not `{}`. The binding spec example
  was corrected (asserted in `e2e.test.ts`).
- **Step 2 also checks the requirements themselves:** `scheme` is `batch-settlement`, `network`
  is exactly `paypal:sandbox` (sandbox only), and `asset` is `USD`. Otherwise
  `requirements_mismatch`.
- **A signature that does not decode to exactly 64 bytes** (garbage, wrong length, padding) fails
  step 1 with `payload`, as the binding spec says; only a well-formed signature that does not
  verify gives `signature`.
- **Settle cap failures also carry `extra: { cap }`**, like verify failures.
- **Unsettled-cap e2e numbers.** `/dynamic` advertises 10 cents (checked at verify) but records 4,
  so with an unsettled cap of 50 it succeeds 11 times (44 cents) before the 12th call is refused.
  A second e2e case uses the 5-cent route: 10 calls fill the cap exactly, the 11th is refused.
- **Two extra source files:** `src/encoding.ts` (strict base64url decoding and SHA-256 helpers;
  `Buffer.from(s, "base64url")` silently skips bad characters) and `src/test-fixtures.ts`
  (shared test helpers, not exported).
- **`PAYPAL_SANDBOX_NETWORK` widens to `string` inside an object literal**, so route
  `accepts` objects need a `PaymentOption` annotation (from `@x402/core/http`) to typecheck.

## Working rules for the builder

- **Stay on branch `phase-1/x402-plugin-spike`. Do not commit and do not push.** `CLAUDE.md`
  says to commit only when the user asks, so leave all changes in the working tree for the final
  audit.
- The working tree already contains uncommitted Phase 0 changes (the translated vault spike,
  `.gitignore`, `CLAUDE.md`, roadmap, workspaces). Leave them as they are.
- After each milestone, run `npm run typecheck` and `npm test`.
- Do not change the binding spec's rules on your own. If something in it is wrong or impossible,
  stop and report it with evidence.
- No `any` in exported types, no suppressed type errors, and no TODOs in place of required
  behaviour.
- When done, report:
  - what was built
  - test counts
  - deviations from this spec, with reasons
  - findings
  - open questions
