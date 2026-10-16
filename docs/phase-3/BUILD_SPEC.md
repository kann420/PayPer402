# Phase 3 build spec: demo seller and AI agent

Implementation plan for Phase 3 of [docs/ROADMAP.md](../ROADMAP.md). Draft 3, revised with
design spec draft 3 after the second review.

- The behaviour is defined in [docs/spec/agent.md](../spec/agent.md) (the **design spec**). The
  facilitator's behaviour stays in [docs/spec/facilitator.md](../spec/facilitator.md), and the
  protocol rules in [docs/spec/scheme_batch_settlement_paypal.md](../spec/scheme_batch_settlement_paypal.md).
- If this file disagrees with a spec, the specs win. Report the conflict; do not silently pick
  one.
- Read `CLAUDE.md` (and `CLAUDE.local.md` if present) first. All conventions apply: English
  only, sandbox only, no secrets in code or logs, no unlisted dependencies, no commit or push.
- Load the `claude-api` skill before writing any Claude code (CLAUDE.md requires it).

## Goal and exit criteria

Phase 3 is done when all of the following hold:

1. **The plumbing checks (Milestone 1) pass,** and their results are written under
   [Findings](#findings).
2. **`apps/demo-seller` implements design spec §3,** tested with an in-memory facilitator and a
   fake seller AI. The tests include the charging rule: no ledger record for a 4xx or 5xx answer.
3. **`apps/agent` implements design spec §4–§8,** tested with:
   - a fake Anthropic transport (scripted Messages API responses through the SDK's `fetch`
     option)
   - a real seller app and a facilitator, both in process
4. **An end-to-end test passes inside Vitest:**
   - the facilitator harness (fake PayPal) + the demo seller (fake AI) + the agent (scripted
     Claude)
   - the paid calls appear in the ledger with the report's commitment ids and amounts
   - a manual settlement charges the fake PayPal exactly the sum
   - after revocation, the next run gets exactly one `refused` (`wallet_revoked`) event, and its
     later calls are blocked locally
5. **`npm run demo` exists and is documented.**
   - The user runs it with `--link` against the real sandbox; its `RESULT: PASS` is the
     roadmap's "Done when".
   - The builder runs it **without** `--link` once (the wallet is not linked, so paid calls are
     refused). This exercises the real Claude request shape end to end. See "Real API use" below.
6. **These all pass:** `npm run typecheck`, `npm test`, and the name check in `CLAUDE.local.md`.

## Dependencies

| Package | Where |
|---|---|
| `@payper402/scheme-paypal` (workspace, `"*"`) | both apps |
| `@x402/core@2.28.0` (exact) | both apps |
| `@x402/express@2.28.0` (exact), `express@^5.3.0`, `@types/express@^5.0.6` (dev) | `apps/demo-seller`; `apps/agent` dev only (tests) |
| `@anthropic-ai/sdk@^0.135.0` | both apps |
| `zod@^4.6.7` | both apps |
| `@modelcontextprotocol/sdk@^1.32.1` | `apps/agent` |
| `@payper402/facilitator`, `@payper402/demo-seller` (workspace, `"*"`) | `apps/agent`, as regular dependencies: `scripts/demo.ts` is the roadmap's "one command" and imports both. `src/` (the library) MUST NOT import them; only `scripts/` and tests do. |

Notes:

- `npm install <pkg>@2.28.0` writes `^2.28.0`. Edit the x402 entries back to the exact version
  (Phase 1 finding).
- Do **not** add `@x402/fetch` to `apps/agent` (design spec §4.2), `@x402/mcp` (§8),
  `@x402/extensions`, `dotenv`, `commander`, `yargs`, `chalk` or a test HTTP library.
  - Parse CLI arguments with `node:util` `parseArgs`.
  - Load `.env` with `tsx --env-file-if-exists=../../.env`.
- Check facts at the time of writing:
  - `@anthropic-ai/sdk@0.135.0` declares the peer `zod ^3.25.0 || ^4.0.0`.
  - `@modelcontextprotocol/sdk@1.32.1` declares `zod ^3.25 || ^4.0`.
  - `@x402/mcp@2.28.0` depends on zod 3 and provides paid MCP tools and a paying MCP client only.
- **zod copies.**
  - The root `node_modules/zod` is 3.25 (hoisted from the x402 SDK). The apps get their own zod
    4.6.7, as `apps/facilitator` does.
  - The Anthropic SDK and the MCP SDK will likely be hoisted to the root. They then resolve
    `zod` (or `zod/v4`) from the 3.25 copy, while our tool schemas are built with 4.6.7.
  - So the Phase 2 finding "the facilitator never mixes in SDK zod schemas" does **not** hold
    for this phase: both SDKs turn our zod schemas into JSON Schema. Milestone 1 checks the
    result.

**The one facilitator change.** Add an `exports` map to `apps/facilitator/package.json`:

```json
"exports": {
  "./server": "./src/server.ts",
  "./config": "./src/config.ts",
  "./auth": "./src/auth.ts",
  "./seed": "./src/seed.ts",
  "./logger": "./src/logger.ts",
  "./test-support": "./src/test-support.ts"
}
```

Change nothing else in `apps/facilitator` or `packages/*`. If you find a facilitator or scheme
bug, stop and report it with evidence; do not fix it in this phase.

## SDK facts (checked while writing this spec)

**x402 (`@x402/core@2.28.0`):**

- `x402HTTPClient` (from `@x402/core/client`) has:
  - `getPaymentRequiredResponse(getHeader, body?)`
  - `createPaymentPayload(paymentRequired)`, which delegates to `x402Client`: it applies
    policies, spend controls and hooks
  - `encodePaymentSignatureHeader(payload)`
  - `getPaymentSettleResponse(getHeader)`
- `x402Client` has `register`, `registerPolicy((version, reqs) => reqs)`, `setSpendControls`,
  `onBeforePaymentCreation` and `onAfterPaymentCreation`.
  - A before-hook that returns `{ abort: true, reason }` makes the core **throw** `Payment
    creation aborted: <reason>`.
  - The design does not depend on hooks: checks happen in our code before
    `createPaymentPayload` is called.
- `@x402/fetch` re-exports `x402Client` and `x402HTTPClient` from `@x402/core/client`.
- Phase 1 findings still apply:
  - `FacilitatorClient` comes from `@x402/core/server`.
  - A verify failure arrives as `PAYMENT-REQUIRED.error`, a settle failure as
    `PAYMENT-RESPONSE.errorReason`.
  - A handler answering 400 or more is not settled.
  - Route `accepts` objects need a `PaymentOption` annotation (from `@x402/core/http`).
  - The default client spend cap is $1 per payment.

**Anthropic (Claude Opus 5.5, `@anthropic-ai/sdk` 0.135):**

- The tool runner is `client.beta.messages.toolRunner({...})`. `betaZodTool` comes from
  `@anthropic-ai/sdk/helpers/beta/zod`.
- Thinking cannot be disabled; `effort` defaults to `medium` and must be set explicitly.
- `tool_choice` `any` or `tool` returns 400.
- Opus 5.5 returns the notes between tool calls as `thinking` blocks, which are empty unless
  `display: "updates"` is set (beta `thinking-display-updates-2026-08-18`).
- Server-side fallbacks: `betas: ["server-side-fallback-2026-07-01"]` with `fallbacks:
  "default"`.
- Check `stop_reason` (`refusal`, `max_tokens`) before reading content. Read blocks by `type`.
- Keep the history append-only. Pass thinking blocks back unchanged; the runner does this.
- The SDK accepts a custom `fetch` in its client options. Tests use it, so `npm test` never calls
  the real API.

If any of these turns out wrong at runtime, stop, record what actually happens under
[Findings](#findings), and adapt within the design spec. Do not paper over it.

## Layout

```
apps/demo-seller/
  package.json          scripts: start, dev, typecheck; "exports": { ".": "./src/index.ts" }
  src/config.ts         zod env schema (design spec §3.1)
  src/services.ts       SERVICES table (single source of truth), catalog(), x402 route config
  src/data/quotes.ts    simulated quote feed (§3.5)
  src/data/news.ts      newsroom fixtures (§3.5), fictional
  src/ai.ts             SellerAi interface, createClaudeSellerAi(client, model)
  src/app.ts            createSellerApp(deps): Express app, no I/O at import time
  src/server.ts         startSeller(options), main (guarded like the facilitator's)
  src/index.ts          exports
apps/agent/
  package.json          scripts: agent, mcp, demo, typecheck; "exports": { ".": "./src/index.ts" }
  src/config.ts         env and argument parsing (§7), key import (raw seed or JWK)
  src/catalog.ts        catalog schema, fetch, params validation (§4.1)
  src/budget.ts         Budget with reservations (§4.4)
  src/events.ts         AgentEvent, RefusalCode, refusal notes, code mapping (§4.5, §4.6)
  src/payer.ts          the paid-call flow (§4.3)
  src/session.ts        openSession, AgentSession, report builder (§4, §4.7)
  src/tools.ts          tool core: definitions and handlers (§5)
  src/agent.ts          runAgent, system prompt, finish tool (§6)
  src/format.ts         CLI rendering of events and the report
  src/cli.ts            CLI entry (§7)
  src/mcp.ts            createMcpServer(session) and the stdio entry (§8)
  src/index.ts          exports for the demo script and Phase 4
  src/demo-steps.ts     pure demo decisions: agent lookup, ledger check, settlement outcome
  scripts/demo.ts       the demo command (§9)
```

Root `package.json` gets one script: `"demo": "npm run demo -w apps/agent --"`.

## Milestone 1: plumbing checks

Fast checks before real logic, kept as tests afterwards
(`apps/agent/src/plumbing.test.ts`):

1. **POST through x402 with the manual flow.**
   - An Express app on port 0 with `express.json()` and `paymentMiddleware`, protecting `POST
     /echo` at 3 cents.
   - It uses `PayPalBatchServerScheme`, and an in-memory facilitator through
     `localFacilitatorClient`.
   - Run the §4.3 flow by hand with `x402HTTPClient`: the unpaid POST gets 402; decode it; build a
     payload; send the paid POST with the same JSON body.
   - Assert: 200, the handler saw the body, `getPaymentSettleResponse` gives `success`, the amount
     is `"3"`, and `transaction` is the ledger record's id.
2. **Policy and spend controls.**
   - A policy that filters out every requirement makes `createPaymentPayload` throw.
   - `setSpendControls({ maxAmountPerPayment: "$0.02" })` makes a 3-cent requirement throw.
   - Record the error messages.
3. **Anthropic tool runner** with a fake `fetch` returning a scripted `tool_use` message, then an
   `end_turn` message:
   - Assert that the request body has all of these:
     - `model`
     - `max_tokens`
     - `thinking: { type: "adaptive", display: "updates" }`
     - `output_config.effort: "medium"`
     - `fallbacks: "default"`
     - `cache_control`
     - the tool list, with `strict: true` where §6.1 says
   - Assert that the `anthropic-beta` header lists both betas.
   - Assert that the `betaZodTool` `run` received the parsed input.
   - Assert the **generated JSON Schema** of a tool built like `call_service`: the `service_id`
     enum values, a `maxLength`, an integer's `minimum` and `maximum`, `required`, and
     `additionalProperties: false` where `strict` needs it.
   - Record which of these fields the SDK types accept. If one is missing from the types, pass it
     with the smallest typed extension of the params type (no `any`, no `@ts-expect-error`), and
     note it.
4. **MCP SDK with zod 4.**
   - Register one tool with a zod 4 input schema on an `McpServer`.
   - Connect a `Client` through `InMemoryTransport.createLinkedPair()`.
   - List the tools and assert the same JSON Schema content as in check 3. Call the tool.
5. **Record which zod file each SDK resolved**, for example with `require.resolve` from the SDK's
   own directory.
   - **If check 3 or 4 shows a wrong or incomplete schema** (a cross-copy problem), switch that
     SDK to hand-written JSON Schemas, and validate inputs with our own zod inside the handler:
     - Anthropic: `betaTool` from `@anthropic-ai/sdk/helpers/beta/json-schema`
     - MCP: the low-level `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema`
       handlers
   - The tool contract of design spec §5 stays the same either way. Record the choice.

Write the results under [Findings](#findings) before Milestone 2.

## Milestone 2: `apps/demo-seller`

Implement design spec §3 exactly.

- `createSellerApp({ payTo, sellerName, publicUrl, resourceServer, ai, now })` takes `now` (unix
  ms) for the quote date and `asOf`, so tests are deterministic.
- **`startSeller({ port, publicUrl?, facilitatorUrl, sellerApiKey, ai, fetch? })`:**
  - when `publicUrl` is omitted, it is `http://localhost:<bound port>`, known after listening
    (tests listen on port 0)
  - the returned `url` equals `publicUrl`. Tests and the demo pass that `url` to the agent as
    `sellerUrl`, so the catalog, the calls and the `relatedNews` links share one origin.
  - resolves `payTo` from `GET /v1/seller`
  - builds the `HTTPFacilitatorClient`, runs `initialize()` and listens
  - returns `{ server, port, url, payTo, close() }`
  - The demo script uses it in process.
- `main` loads config (§3.1), builds `createClaudeSellerAi(new Anthropic(), model)`, and calls
  `startSeller`.

### Tests

**Unit:**

- the services table: every route config price equals the catalog price, and every route in
  the table is protected (the agent's catalog tests validate this catalog against the agent's
  schema; `apps/demo-seller` must not depend on `apps/agent`)
- the quote formula: deterministic per UTC day, `d` within ±4%, `previousClose` from the previous
  day, 2-decimal rounding
- newsroom fixtures: 2–3 articles per topic, body lengths within 120–250 words, unique slugs
- the summarize URL check:
  - accepted: the seller's origin plus a known slug
  - rejected: another origin, `http` versus `https` mismatch, an unknown slug, a path traversal
    attempt, a non-URL
- translate validation: the `targetLanguage` pattern and the text length
- `createClaudeSellerAi` with a fake `fetch`:
  - the request shape: model, effort `low`, `max_tokens`, the fallbacks beta and field, the
    static system prompt
  - `refusal`, `max_tokens` and a typed API error all throw

**HTTP** (the in-memory facilitator from `@payper402/scheme-paypal` through
`localFacilitatorClient`, a fake `SellerAi`, and a client that pays):

- Each paid route answers an unpaid request with 402 and the catalog price.
- Each paid route succeeds when paid (GET and POST), and the ledger records the amount.
- None of these is recorded in the ledger:
  - an invalid symbol (400)
  - a bad summarize URL (400)
  - an over-long translate text (400)
  - an AI failure (503 `ai_unavailable`)
  - a malformed JSON body (400 `invalid_json`, before payment)
  - a body over 32 KB (413 `body_too_large`, before payment)
- The error table of design spec §3.4: an unknown route (404) and a handler that throws (500
  with no stack trace in the body).
- The catalog, newsroom pages and `/healthz` are free (200 with no payment). Newsroom HTML is
  escaped.
- `startSeller` fails with a clear error when `/v1/seller` answers 401.

## Milestone 3: agent payment core

`catalog.ts`, `budget.ts`, `events.ts`, `payer.ts` and `session.ts`: design spec §4.

### Tests

**Catalog:**

- the real demo seller catalog validates
- each limit in §4.1 is rejected one at a time: an unknown field, a bad id, a duplicate id, a long
  description, a bad path (`//`, `..`, an absolute URL), the wrong network, too many params
- params validation: unknown, missing, wrong type, enum, `maxLength`, integer bounds

**Budget:**

- reserve, commit, release and uncertain arithmetic
- `maxPerCall`
- 20 parallel reservations against a budget that fits 7: exactly 7 succeed
- a token settled twice throws
- commit with a lower actual amount
- commit with a higher reported amount: only the reserved amount is committed

**Payer and session**, against a real seller app and the in-memory facilitator:

- the happy path, with events in order: `discovered_price` → `decided` → `paid`, with the
  commitment id equal to the ledger id and correct running totals
- the local pre-check refuses (no request made) for:
  - a catalog price above `maxPerCall`
  - a catalog price above the remaining budget
- `price_changed`: the test seller's 402 asks more than its catalog says
- `payee_mismatch`: the 402's `payTo` differs from the catalog's
- facilitator refusals map to their codes and notes:
  - `cap_exceeded`
  - `wallet_revoked`, which blocks the session; the next call is `payments_blocked` with no HTTP
    request (count requests with a fetch spy)
  - `agent_disabled` (paused agent)
  - `unknown_agent`
- a 400 after a valid payment: `failed` with `charged: "no"`, the budget is released, and there is
  no ledger record
- a network error on the paid request (a fetch spy that throws after sending): `failed` with
  `charged: "unknown"`, and the amount counts in `uncertainCents`
- **the paid-request `402` table of design spec §4.3 step 6**, one test per row:
  - a settle refusal with a binding code: a `FacilitatorClient` wrapper whose `settle` returns
    `{ success: false, errorReason: ErrorCode.capExceeded, transaction: "", network }`. Expect
    `refused` (`cap_exceeded`), the reservation released, and nothing in the ledger.
  - a settle that throws in transit: a wrapper whose `settle` throws `new Error("fetch failed")`
    after a successful `verify`. Assert that the `402` carries a `PAYMENT-RESPONSE` with a
    non-binding `errorReason`. Expect `failed` with `charged: "unknown"`, and the amount counts
    in `uncertainCents`.
  - a verify refusal with a binding code (for example a paused agent): `refused`.
  - a verify that throws in transit: a wrapper whose `verify` throws. Expect `failed` with
    `charged: "no"`, and the reservation released.
  - neither header: the session's injected `fetch` strips both headers from the paid
    response. Expect `failed` with `charged: "unknown"`.
- **a 502 on the paid request:** a wrapper whose `settle` throws a `FacilitatorResponseError`.
  Expect `failed` with `charged: "unknown"`.
- a 503 from the handler (AI failure) after a valid payment: `failed` with `charged: "no"`, and
  the reservation released
- a probe `402` without a `PAYMENT-REQUIRED` header: `failed` with `charged: "no"`, and nothing
  is reserved
- an over-reported settle amount (a test seller whose `PAYMENT-RESPONSE` claims more than the
  signed maximum, for example through a response-rewriting middleware): `paid` with the reserved
  amount, then `failed` with the design spec §4.4 note
- a missing `PAYMENT-RESPONSE` on a 2xx: the reserved price is committed, and `commitmentId` is
  null
- dynamic pricing: a test route that settles 3 of 5 cents commits 3
- a body over 64 KB is replaced by `response_too_large`, and the call stays paid
- parallel calls never exceed the budget
- the report: lines, `notUsed`, refusals, commitment ids, and its numbers equal the event sums
- `onEvent` that throws does not break the call

## Milestone 4: tools, Claude agent and CLI

`tools.ts`, `agent.ts`, `format.ts` and `cli.ts`: design spec §5–§7.

- Build the four tools with `betaZodTool`. `call_service.service_id` is a `z.enum` of the catalog
  ids.
- The system prompt is the exact text of design spec §6.2, as a constant.
- `runAgent` takes the `Anthropic` client as a parameter. The CLI builds `new Anthropic()`.

### Tests (fake Anthropic `fetch`, real session against the seller app and in-memory facilitator)

- **Request shape on every request:**
  - the §6.1 parameters and both betas
  - no `tool_choice`
  - the first user message format
  - the system prompt is byte-identical between two runs
- **History is append-only:** every request's messages are a prefix-extension of the previous
  request's.
- **Script: list → quote → summarize → finish alone:**
  - the events: thinking rows from `thinking` blocks (with text) and `text` blocks; then
    `discovered_price`, `decided`, `paid` per call; then `result`
  - the status is `completed`
  - the report: two lines, with `premium_news` and `translate` in `notUsed`
  - no request after `finish`
- **Script: finish together with another tool use:** the other tool runs, and the run stops with
  `completed` when the next message arrives.
- **Script: the model calls `premium_news`** with a per-call limit of 10 cents: a local
  `refused` with `over_per_call_limit`, and no HTTP request.
- **`stop_reason: refusal`:** status `refused`, and no tools of that message run.
- **`end_turn` without `finish`:** `completed`, with the text as the answer and an empty
  explanation.
- **The iteration limit:** with `maxIterations: 3`, a script whose third message calls
  `quote`. Expect `incomplete`, no HTTP request and no `paid` event from that third message, and
  exactly 3 requests to the fake API. `max_iterations` is not in any request body.
- **The iteration limit with `finish`:** the third message has `finish` and `quote` together.
  Expect `completed` with the `finish` answer, and no `quote` request.
- **A 529 from the fake API:** status `error` and a `failed` event. After the SDK's retries
  (set `maxRetries: 0` in the test client), there are no keys in the note.
- **Invalid `call_service` input** (an unknown param): a tool error. The run continues.
- **CLI:**
  - argument parsing (`--budget`, `--max-per-call`, the default task)
  - key import from a raw seed and from a JWK
  - missing `AGENT_PRIVATE_KEY` exits 1 with a message
  - `format.ts` renders each event type on one line, and the report table

## Milestone 5: MCP server

`mcp.ts`: design spec §8. `createMcpServer(session)` returns an `McpServer`; the stdio entry
wires it to `StdioServerTransport`.

### Tests (`InMemoryTransport`, a real session against the seller app and in-memory facilitator)

- `listTools` shows exactly `list_services`, `call_service` and `get_budget`, with the
  descriptions, the `service_id` enum and the annotations
- `call_service` pays, and `get_budget` reflects it
- an over-limit service returns `isError` with `refused`
- invalid params return `isError` with `invalid_params`. Use a `params` object that passes the
  MCP input schema but fails our validation (an unknown param name), because the MCP SDK rejects
  schema-invalid input such as a bad `service_id` itself, before the handler.
- the budget persists across calls in one server
- nothing is written to stdout by the server code (events go to a stderr logger, injectable for
  the test)

## Milestone 6: demo command and end-to-end test

**`scripts/demo.ts`:** design spec §9.

- Reuse the Phase 2 sandbox script's patterns: the link polling loop, the `Fail` error class,
  the abort on Ctrl+C, and the cleanup in `finally`. Do not import from `apps/facilitator/scripts`;
  copy what you need.
- Use `startFacilitator` (`@payper402/facilitator/server`), `loadConfig`, `seed`, `issueApiKey`
  and `hashApiKey` (for revoking the run keys at exit), `startSeller` and `runAgent`.
- Create the key file with `fs.writeFileSync(path, seed, { mode: 0o600 })`, and create its
  directory if missing. The mode is ignored on Windows; do not test it.
- Factor the demo's pure decisions into small functions, and unit-test them in
  `src/demo-steps.test.ts` with the facilitator harness:
  - the agent lookup on 409 (§9 step 3), including "registered to another operator"
  - the ledger comparison (§9 step 7)
  - the settlement outcome handling (§9 step 8): 201 `completed`, `pending` then `completed`,
    `failed`, `needs_review`, and the three 409 codes
  
  `src/demo-steps.ts` imports nothing from the facilitator, not even types. It takes an
  `api(method, path, body?)` function that returns `{ status, body }`, and declares the few
  response fields it reads.
  - The tests pass a closure over the harness's `api(method, path, { key, body })` that fixes
    the operator key.
  - The demo passes a `fetch`-based one with the run's operator key.

**`src/e2e.test.ts`** (Vitest, no network):

- `createHarness()` from `@payper402/facilitator/test-support`:
  - an operator with caps per call 10, daily 1000, unsettled 500
  - an active wallet
  - a seller and an agent
- **Align the clocks.** The harness clock is unix seconds and starts at a fixed `T0`, while
  commitments carry `iat`. Give the session `nowSeconds: () => harness.clock.now` (design spec
  §4). Do not set the harness clock to the system time instead: a frozen clock falls behind, and
  after 30 s `iat > now + 30` fails.
- `startSeller` against the harness URL with a fake `SellerAi`
- `runAgent` with a scripted fake Anthropic: list → quote → summarize → translate → finish
- **Assert:**
  - the report's `commitmentIds` equal `GET /v1/commitments` for the agent
  - the amounts match
  - `POST /v1/settlements` creates a settlement whose amount equals the sum; the fake PayPal saw
    one charge of exactly that amount
  - the harness invariants hold
- **Revoke** the wallet through the harness (the webhook or the health-check path), then run the
  agent again with a script that calls `quote` twice:
  - exactly one `refused` event with `wallet_revoked`
  - the second call answers `payments_blocked` with no HTTP request
  - status `completed` (the model finishes and explains)

**Real API use.** Tests never call Anthropic or PayPal. The builder MAY:

- run `npm run demo` once **without** `--link`, if Anthropic credentials and the PayPal sandbox
  credentials are present. Use a temporary `DEMO_DATABASE_PATH`. If `DATA_ENCRYPTION_KEY` or
  `API_KEY_PEPPER` is missing, set throwaway values in the shell for that run only.
- run one manual smoke check of `createClaudeSellerAi` (one summarize and one translate) against
  the real API.

Report what happened. Never print or commit the keys, and do not run `--link` (it needs the
user).

## Milestone 7: docs

- `apps/demo-seller/README.md`:
  - what it is
  - the services and prices
  - configuration
  - running it against a seeded facilitator
  - the charging rule
  - that its data is simulated and its articles fictional
- `apps/agent/README.md`:
  - the payment core in one paragraph
  - the CLI
  - the MCP server, with a Claude Code `claude mcp add` example and a Claude Desktop config
    example using placeholders only
  - the demo command and its two scenes (linked and stopped)
  - the event schema pointer
- The root `README.md`: add a short "Run the demo" section that points to `npm run demo`.
- Add the new variables to `.env.example`, with placeholders only: `SELLER_*`,
  `FACILITATOR_URL`, `AGENT_*`, `SELLER_URL`, `DEMO_DATABASE_PATH`.
- Keep the design spec in sync with what was built, with change notes.
- Tick the Phase 3 tasks in `docs/ROADMAP.md`, except the "Done when" PASS, which the user
  confirms. Do not move the "Current phase" marker.
  - Amend two phrases there to match the build: "two or three paid APIs" becomes "four paid
    APIs", and "call a paid API through `@x402/fetch`" becomes "call a paid API with the x402
    client (`@x402/core`), seeing the price before paying".

## Findings

Builder: record the Milestone 1 results and anything later that differs from "SDK facts" or that
surprised you.

### Milestone 1 (plumbing checks, `apps/agent/src/plumbing.test.ts`)

All five checks were run on `@x402/*@2.28.0`, `@anthropic-ai/sdk@0.135.0` and
`@modelcontextprotocol/sdk@1.32.1`. The "SDK facts" above held, with these results:

1. **Manual x402 flow on a POST route works.** `express.json()` before `paymentMiddleware`; the
   unpaid POST gets 402; `getPaymentRequiredResponse` decodes it; `createPaymentPayload` signs;
   the paid POST with the same JSON body gets 200; the handler saw the body;
   `getPaymentSettleResponse` gives `success: true`, `amount: "3"`, and `transaction` equals the
   ledger record's id.
2. **Policy and spend controls throw as expected.** Messages (recorded in the test):
   - a policy returning `[]`: `All payment requirements were filtered out by policies for x402
     version: 2`
   - `setSpendControls({ maxAmountPerPayment: "$0.02" })` with a 3-cent requirement: `All payment
     requirements were rejected by spendControls.maxAmountPerPayment ($0.02 …)`. `"$0.03"`
     accepts it, so `"$<price as D.CC>"` is an exact per-call ceiling.
3. **Tool runner request shape.** Every parameter typechecks on
   `client.beta.messages.toolRunner(...)` without any extension of the params type: `thinking:
   { type: "adaptive", display: "updates" }`, `output_config.effort`, `fallbacks: "default"`
   (typed as `BetaFallbacksParam = BetaFallbackParam[] | "default"`), top-level `cache_control`,
   and `betas`. `betas` travels as the `anthropic-beta` header (both values), never in the body.
   No `tool_choice` and no `max_iterations` are sent. `strict: true` is passed by spreading it onto
   the tool object. The tool's `run` receives the parsed input.
4. **MCP SDK.** A low-level `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema`
   handlers, connected through `InMemoryTransport.createLinkedPair()`, lists the exact
   hand-written JSON Schema and calls the tool.
5. **zod copies: a cross-copy problem, so both SDKs use hand-written JSON Schemas.**
   - Ours: `apps/agent/node_modules/zod` (4.6.7). The Anthropic SDK resolves `zod/v4` from the root
     `node_modules/zod` (3.25.76); the MCP SDK resolves `zod` and `zod/v4` from the same root copy.
   - `betaZodTool` with our zod 4 schema produced an incomplete schema at runtime: every
     `.describe()` text, `maxLength`, `minLength`, `minimum` and `maximum` was dropped, and
     `z.number().int()` became `{ "type": "number" }`. `McpServer.registerTool` with the same
     shape produced the same loss in `listTools`. Neither call typechecks either: the root
     copy's `ZodType` rejects our schema (`_zod.version.minor`: `0` is not `6`).
     Both losses are kept as tests in `plumbing.test.ts`, next to the hand-written-schema checks.
   - **Choice (per check 5):** Anthropic tools use `betaTool` from
     `@anthropic-ai/sdk/helpers/beta/json-schema` with hand-written JSON Schemas; the MCP server
     uses the low-level `Server` with `ListToolsRequestSchema` and `CallToolRequestSchema`
     handlers. Inputs are validated with our own zod 4 inside the handlers. The §5 tool contract is
     unchanged. A consequence: `createMcpServer(session)` returns the low-level `Server`, not an
     `McpServer` (build spec Milestone 5).
   - **Strict tools and length limits.** The structured-outputs schema rules do not support
     `minLength`, `maxLength`, `minimum` or `maximum`, and `betaTool` passes the schema unchanged.
     So the strict tools (`list_services`, `get_budget`, `finish`) send schemas without those
     keywords, and `finish`'s 1–8000 and 1–1500 character limits are enforced by our zod in code.
     `call_service` is not strict and keeps `maxLength` on `reason`.

### Later milestones

**SDK behaviour observed in tests:**

- **Tool runner.** The runner yields each message before it runs that message's tools: the tools
  run when the loop resumes. So every §6.3 stop is a `break` before resuming, and no tool of a
  stopping message runs. A tool failure becomes `is_error` only by throwing from `run`. The tool
  core returns `{ isError, text }`, and the Claude adapter throws the SDK's `ToolError`
  (`@anthropic-ai/sdk/lib/tools/ToolError`) with the JSON text. The runner catches it and sends
  that text unchanged, with no `Error:` prefix. "Handler code never throws into the runner" is read
  as: our handlers never throw; the adapter uses the SDK's documented error channel. The MCP
  adapter sets `isError` directly.
- **`finish` with other tools** costs one more model request, as §6.3 describes, because the runner
  sends the next request right after it runs the tools. That message is discarded: no thinking
  rows and no tools.
- **`betaTool` typing.** Its result type is inferred from the schema, so the runnable tools are
  passed to `toolRunner` without a `BetaRunnableTool<unknown>` annotation.
- **x402 answers on the paid request**, as the §4.3 step 6 table expects:
  - a `verify` that throws gives `402` with `PAYMENT-REQUIRED.error` set to the thrown message
    (for example `fetch failed`), a non-binding code, so the call fails with `charged: "no"`
  - a `settle` that throws gives `402` with `PAYMENT-RESPONSE` `success: false` and a non-binding
    `errorReason`
  - a `settle` that throws `FacilitatorResponseError` gives `502`
- **The MCP stdout risk is real.** `npm run mcp -w apps/agent` prints npm's `> pkg mcp` banner to
  stdout, which corrupts the protocol; `npm run --silent …` prints nothing. The README examples
  use `npm run --silent --prefix <repo>/apps/agent mcp`. `--prefix <repo> -w apps/agent` fails
  with "No workspaces found".
- **Test pitfall.** A cloned `Response` whose clone is never read keeps the connection busy, and
  `server.close()` then waits. The tests capture headers instead of cloning.

**Choices where the specs were silent (also in the design spec's change notes):**

- **The seller's Claude client** uses `new Anthropic({ timeout: 15_000, maxRetries: 0 })`, in
  `main` and in the demo. A slow model then answers 503 before the agent's 20 s paid-request
  timeout. Otherwise the call would be uncertain on the agent side but recorded by the
  facilitator, and the demo's ledger check would fail.
- **Summarize** also returns `source` and `simulated: true`, because §3.5 says every data response
  does.
- **The over-reported settle amount** emits `failed` with `charged: "no"`: nothing beyond the
  `paid` row was charged.
- **A lone `finish` that fails zod validation** ends the run `incomplete`, with the last text as
  the answer (the reviewer's observation). A `finish` sent with other tools that fails validation
  becomes a tool error, and the loop goes on.
- **A `call_service` input that fails the tool schema** is `unknown_service` when `service_id` is
  not a catalog id, and `invalid_params` with zod issues otherwise. `list_services` returns
  `seller: { name }`. An unknown MCP tool name answers `isError` with `unknown_tool`.
- **Display amounts** use `formatUsd`: `$` plus `centsToUsdString`, with `$0.00` for zero, because
  `centsToUsdString` rejects 0.
- **The demo command:**
  - It requires one of `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE`. A
    default profile on disk alone is not detected.
  - It skips `--link` when the wallet is already `active`.
  - The facilitator logs at `warn` unless `LOG_LEVEL` is set.
  - `maxPerCallCents` is `min(perCall, budget)`, so a budget below the cap still gives a valid
    session.
  - Run keys are revoked by setting `revoked_at` on their hash.
- **Extra files beyond the layout:**
  - `src/test-support.ts` in both apps (fakes and environments, tests only)
  - `src/server.ts` exports `SELLER_AI_TIMEOUT_MS` and `SellerStartError`
  - `src/data/quotes.ts` exports `DEMO_SOURCE`

**Real API use.** Both permitted runs were **skipped**: no Anthropic credentials are available.
The root `.env` has the PayPal sandbox credentials and none of `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_PROFILE`, and no `ant` CLI or profile directory exists. So
`createClaudeSellerAi` and the agent's request shape have been checked only against the fake
transport. One consequence: strict `finish` without length keywords has not been seen accepted by
the real API. Instead, two checks used no real API:

- `npm run demo` with the real `.env` fails fast with the list of missing variables.
- The full `scripts/demo.ts` was smoke-run twice against a local fake Messages API, with dummy
  PayPal credentials and a scratch database. Steps 1–9 ran:
  - the wallet was `not_linked`, so there was one `wallet_not_linked` refusal, then
    `payments_blocked`
  - `Ledger matches: 0 paid calls, $0.00`, and the settlement was skipped
  - `RESULT: PASS`
  - the second run found the agent through the 409 lookup
  - all four run keys were revoked at exit

### Audit round 1 fixes

- **Prototype keys.** `validateParams` and the catalog's `required` check used `name in
  service.params`, so `constructor`, `toString` and similar names passed as known params. The
  required-presence check and the value lookup also read `params[name]` through the prototype.
  - All four now use `Object.hasOwn`.
  - Tests cover `constructor`, `toString`, `hasOwnProperty` and `__proto__`, a catalog with
    `required: ["constructor"]`, and a declared param named `constructor`.
  - No other new code uses `in` on a plain object. Service, enum and `ErrorCode` lookups use
    `find`, `includes`, a `Set` or a `Map`.
- **Demo step 8 gating** moved to `settlementDecision` in `src/demo-steps.ts` and is tested. Its
  order is `--no-settle`, then no paid calls, then the wallet status known after step 4. The status
  is no longer re-read, so a wallet revoked after the run reaches 409 `wallet_not_active` and
  `RESULT: FAIL`. The stopped-wallet scene (no paid calls) still ends PASS.
- **Recorded `finish`, then an error.** When a validated `finish` sent with other tools has been
  recorded, an error or abort on the next request ends the run `completed`, with the recorded
  answer and explanation. No `failed` event is emitted, because the run's outcome is the finish.
  An unrecorded (invalid) `finish` still ends `error`.
- **Removed** the unused `serviceById` from `apps/demo-seller/src/services.ts`.
- **Design spec** §6.3, §9 step 6 and §9 step 8 were amended, with Build notes lines.

## Working rules for the builder

- **Stay on branch `phase-3/agent-demo`. Do not commit, push, or change git config.**
- Do not touch `spikes/`, the root `.env`, `docs/ui-brief.md`, `docs/brand/`,
  `PayPer402-prototype.html`, or the "Development process" section of `CLAUDE.md`.
- In `apps/facilitator`, change only `package.json` (the `exports` map). Do not change
  `packages/*`.
- After each milestone, run `npm run typecheck` and `npm test`.
- If the design spec is wrong or impossible somewhere, stop that part and report it with
  evidence.
- No `any` in exported types, no suppressed type errors, and no TODOs in place of required
  behaviour.
- Mind the name check in `CLAUDE.local.md`. Its patterns also match inside longer words, so
  ordinary English words can trip it. Run it before you report.
- **When done, report:**
  - what was built
  - test counts per package
  - deviations, with reasons
  - findings
  - the results of the real-API runs
  - open questions
