# Phase 4.5 build spec: operator CLI

Implementation plan for Phase 4.5 of [docs/ROADMAP.md](../ROADMAP.md). Draft 2 (2026-10-27). It
**passed review** in round 2 on 2026-10-27, with the review's notes folded into Milestones 2–4
and the working rules.

- **The behaviour is defined in [docs/spec/operator-cli.md](../spec/operator-cli.md)** (the
  **design spec**). It amends [facilitator.md](../spec/facilitator.md),
  [web-app.md](../spec/web-app.md) and [agent.md](../spec/agent.md). Section numbers below without
  a file name refer to the design spec.
- **If this file disagrees with a spec, the specs win.** Report the conflict; do not silently
  pick one.
- **Read `CLAUDE.md` (and `CLAUDE.local.md` if present) first.** All conventions apply: English
  only, no secrets in code or logs, no unlisted dependencies, no commit or push. The private name
  check in `CLAUDE.local.md` applies to every new file, including the usage text and the README.
- **No Claude code changes.** `agent.ts` and the system prompt are untouched, so the `claude-api`
  skill is not needed. `run` only calls the existing `runCli`.

## Goal and exit criteria

Phase 4.5 is built when all of the following hold:

1. **Facilitator:** migration 3, `POST /v1/agents/claims`, `POST /v1/claims/redeem`,
   `GET /v1/agent/status`, the rate limits and `FACILITATOR_TRUST_PROXY`, with tests (Milestone 1).
2. **Agent request signing** lives in `@payper402/scheme-paypal`, shared by both sides, with tests
   (Milestone 1).
3. **`apps/agent`:** the `payper402` command (`onboard`, `status`, `mcp`, `run`, `help`,
   `version`), its config file, the bin shim, with tests, including one end-to-end test
   (Milestone 2).
4. **Web:** the claim route and the "Connect from a terminal" UI (Milestone 3).
5. **Docs:** the README section, and the build notes in the design spec (Milestone 4).
6. **Unchanged behaviour:** every existing test passes **without editing it**. New tests go beside
   them. The **only** allowed edits to an existing test are in
   `apps/facilitator/src/foundation.test.ts`, because migration 3 changes the latest version:
   - the latest-version literals `toBe(2)` at lines 89, 111, 112, 127 and 149 become `toBe(3)`
   - the "newer than the code" fakes become version 4: `{ version: 3, … }` at line 126 and
     `VALUES (3, 0)` at line 163
   
   Nothing else in that file or any other existing test changes. Record the edit under Findings.
7. **These all pass:** `npm run typecheck`, `npm test`, and the name check in `CLAUDE.local.md`.

The roadmap's "Done when" items 4 and 5 (a Claude Code session paying through `payper402 mcp`,
then "Stop paying with PayPal") need the real sandbox and a real Claude Code session. The user
runs them; see "Real API use".

## Dependencies

**None.** The bin shim uses `tsx`, which resolves from the repository's `node_modules` (the root's
existing dev dependency); the command only runs from a clone (design spec §6.8). Use
`node:util` `parseArgs`, `node:crypto` (`randomInt`, `sign`, `verify`), `node:fs/promises` and
`node:os`.

## Layout

```
packages/scheme-paypal/src/
  agent-request.ts         new: message, sign, verify, header format (§4.2)
  agent-request.test.ts    new
  index.ts                 export the new functions

apps/facilitator/src/
  db/migrations.ts         migration 3 (§5)
  claims.ts                new: code generation, normalisation, hashing (§3.1)
  rate-limit.ts            new: sliding window and client key (§9.3)
  agent-auth.ts            new: the PayPer402-Agent middleware (§4.3)
  routes/agents.ts         POST /claims (§3.3)
  routes/claims.ts         new: POST /redeem (§3.4)
  routes/agent-status.ts   new: GET /status (§4.4)
  app.ts                   mounts /v1/claims and /v1/agent outside /v1/agents
  config.ts                FACILITATOR_TRUST_PROXY
  seed.ts                  reset deletes agent_claims first
  claims.test.ts           new
  agent-status.test.ts     new

apps/agent/
  bin/payper402.mjs        new: tsx register shim (§6.8)
  src/payper402.ts         new: command dispatch, runPayper402(argv, env, io, deps)
  src/cli-config.ts        new: config file read and write (§7)
  src/facilitator-api.ts   new: redeem and signed status calls, with an injectable fetch
  src/status-format.ts     new: the status text (§6.4)
  src/mcp.ts               start-up steps moved into an exported function, shared (§6.5)
  src/*.test.ts            new tests
  package.json             the payper402 script

apps/web/src/
  lib/config.ts            FACILITATOR_PUBLIC_URL, SELLER_PUBLIC_URL, WEB_LIMIT_CLAIMS_PER_HOUR
  lib/facilitator.ts       operator(key).createClaim(...)
  lib/handlers/operator.ts createClaimHandler
  app/api/operator/agents/claims/route.ts   new
  components/agents/claim-panel.tsx         new
  components/agents/agent-creator.tsx       the secondary button
  (onboarding step 3 and the Agents drawer wire the panel in)

package.json (root)        "bin" (payper402 -> apps/agent/bin/payper402.mjs) and the "payper402" script
README.md                  "Use PayPer402 from a terminal" section
```

## Milestone 1: facilitator and shared signing

### `packages/scheme-paypal/src/agent-request.ts`

Not part of the binding; it is a PayPer402 service helper that lives here because both the
facilitator and the agent already depend on this package and on its `canonical` helper. Its file
comment says so.

```ts
export const AGENT_REQUEST_DOMAIN = 'payper402-agent-request:v1\n';
export const AGENT_AUTH_SCHEME = 'PayPer402-Agent';
export function agentRequestMessage(input: { kid: string; iat: number; method: string; path: string }): string;
export function signAgentRequest(input: { privateKey: KeyObject; kid: string; iat: number; method: string; path: string }): string; // the full header value
export function parseAgentAuthorization(header: string | undefined): { kid: string; iat: number; sig: string } | undefined;
export function verifyAgentRequestSignature(input: { publicKeyX: string; kid: string; iat: number; method: string; path: string; sig: string }): boolean; // never throws
```

- `agentRequestMessage` returns `AGENT_REQUEST_DOMAIN + canonical({ iat, kid, method, path })`, with
  `method` uppercased.
- `parseAgentAuthorization` applies the exact regex of §4.2 and parses `iat` as a safe integer.
- **Tests:** a sign/verify round trip; every field change breaks verification (kid, iat, method,
  path); a header with padding, a short signature, a leading-zero `iat` or another scheme is
  rejected; **domain separation:** a commitment signature never verifies as a request signature
  over the same key, and `AGENT_REQUEST_DOMAIN` and the commitment `SIGNATURE_DOMAIN` are not
  prefixes of each other.

### Migration 3 and seed

- Append migration 3 with the SQL of §5. Do not touch migrations 1 and 2.
- `seed.ts` `reset`: `DELETE FROM agent_claims WHERE operator_id = ?` before deleting agents.
- **Tests:** a fresh database reaches version 3; a database at version 2 with rows upgrades and
  keeps them; the seed reset works with a claim present (redeemed and open).

### `src/claims.ts`

```ts
export const CLAIM_TTL_SECONDS = 900;
export const MAX_OPEN_CLAIMS = 5;
export function generateClaimCode(): { display: string; normalised: string };
export function normaliseClaimCode(input: string): string | undefined; // undefined when invalid
export function claimCodeHash(pepper: string, normalised: string): string; // hmacHex(pepper, 'claim:' + normalised)
```

- **Tests:** generated codes match `^[0-9A-HJKMNP-TV-Z]{4}-…{4}-…{4}$` and normalise to
  themselves; lower case, spaces, missing dashes, `O`, `I` and `L` normalise as §3.1 says; 11 or 13
  characters, `U` and punctuation are invalid; 1,000 generated codes are distinct.

### `src/rate-limit.ts`

- A sliding window with the same interface as `apps/web/src/lib/limits.ts` `SlidingWindow`
  (written here, not imported: the facilitator must not depend on the web app), with an
  injectable millisecond clock.
- `clientKey(req, trustProxy)`: the first `X-Forwarded-For` address, trimmed, when `trustProxy`,
  otherwise `'shared'`.
- A middleware factory `rateLimit(windows: [SlidingWindow, (req) => string][])` that answers 429
  `too_many_requests` with `Retry-After` (seconds until the oldest hit leaves the window,
  rounded up, at least 1) and records nothing when any window is full.
- The windows are created once per `createApp` call, so each test harness starts empty.
- `AppDeps` gains an optional `rateClock?: () => number` (milliseconds), defaulting to
  `Date.now`, so tests can move time. The harness passes `() => clock.now * 1000`.

### `POST /v1/agents/claims` and `POST /v1/claims/redeem`

As §3.3 and §3.4, step by step. Reuse the agent insertion of `POST /v1/agents`: move it into one
function used by both routes, so the row, audit record and event cannot drift apart. The function
takes the audit details as a parameter. The existing `POST /v1/agents` path MUST keep its audit
details exactly `{ generatedKey: <bool> }`, with no `via` key: the web app's
`operator.test.ts` asserts them.

**Tests (`claims.test.ts`, the facilitator `Harness`):**

- Issue: 201 with a display code and `expiresAt = now + 900`; only the hash is stored (the code
  string appears nowhere in the database, checked by scanning every text column of
  `agent_claims` and `audit_log`); a seller key gets 403; a sixth open claim gets 409
  `too_many_claims`; after the clock passes `expires_at`, a new claim is allowed again; a bad
  `sellerUrl` (`ftp:`, relative, over 300 characters) gets 400.
- Redeem: 201 creates an active agent with the claim's name and the caller's public key, under the
  claim's operator; `sellerUrl` is returned (and null when none was stored); `agent.updated` is
  emitted to that operator; audit records `agent.created` (`via: 'claim'`) and
  `agent.claim_redeemed` exist.
- Redeem errors: an unknown code 404; a malformed code 400 without a database lookup; a second
  redemption 409 `claim_used`; an expired code 410; an existing `kid` 409 `agent_key_exists`, with
  the claim still open afterwards; a malformed `publicKeyX` 400.
- Lower-case and dash-less input redeems the same claim.
- The redeemed agent can pay: a commitment signed with its key passes `/x402/verify`.
- Rate limit: the 11th redemption from one client inside a minute gets 429 with `Retry-After`;
  with `FACILITATOR_TRUST_PROXY=1`, two `X-Forwarded-For` addresses have separate windows; moving
  the rate clock past the window allows requests again.

### `GET /v1/agent/status`

- `agent-auth.ts`: the middleware of §4.3, setting `res.locals` to the agent row. The 401 message
  is "Missing or invalid agent signature" for every failure.
- `routes/agent-status.ts`: the view of §4.4, built from the existing helpers. Extract the usage
  query of `GET /v1/operator` into a shared function rather than copying it.
- **Mounting** in `app.ts`: `app.use('/v1/claims', claimRoutes(...))` and
  `app.use('/v1/agent', statusLimit, agentAuth, agentStatusRoutes(...))`, both before
  `notFoundHandler`. `/v1/agents` and its operator mount are unchanged.

**Tests (`agent-status.test.ts`):**

- A valid signature returns the §4.4 shape; the figures equal those of `GET /v1/operator` for the
  same operator, and `agent.*` equals the agent's row in `GET /v1/agents`.
- It contains no operator id, no `payerEmailMasked`, no other agent (check the serialised body
  for the operator id and another agent's name).
- 401 for: no header, a Bearer API key, a wrong scheme, a bad signature, an unknown `kid`, `iat`
  121 seconds in the past or future, and a signature made for another path or method.
- `iat` exactly 120 seconds off passes.
- A paused agent gets 200 with `agent.status: 'paused'`.
- After the wallet becomes `stopped_by_payer`, `blocked` is true with `wallet_not_active`.
- `remainingToday` is never negative.
- The rate limit answers 429 on the 61st request in a minute.
- Neither the header nor the signature appears in captured log output.

## Milestone 2: the `payper402` command (`apps/agent`)

### `src/cli-config.ts`

```ts
export interface CliConfig { version: 1; facilitatorUrl: string; sellerUrl: string; operatorName: string;
  agent: { id: string; name: string; kid: string; keyFingerprint: string }; privateKey: string; createdAt: number }
export function configDir(env: Record<string, string | undefined>): string;  // PAYPER402_HOME or ~/.payper402
export function configPath(env): string;
export async function readCliConfig(env): Promise<{ ok: true; config: CliConfig; privateKey: KeyObject } | { ok: false; reason: 'missing' | 'invalid' }>;
export async function writeCliConfig(env, config: CliConfig): Promise<void>; // 0o700 dir, 0o600 tmp file, rename
```

- The status body's zod schema treats `caps.total` as optional (design spec §4.4).
- `readCliConfig` checks the strict schema and that `kidFromPublicKeyX(publicKeyX(key)) ===
  agent.kid` (§7). Errors never include file content.
- **Tests** (a temporary `PAYPER402_HOME` per test): round trip; a missing file; invalid JSON, an
  extra field, a wrong `version`, a key that does not match `kid` are each `invalid`; the write
  leaves no `.tmp` file behind; on POSIX the file mode is `0o600` (skip the mode check on
  Windows).

### `src/facilitator-api.ts`

- `redeemClaim({ api, code, publicKeyX, fetch?, timeoutMs = 15_000 })` and
  `getAgentStatus({ api, privateKey, kid, fetch?, now?, timeoutMs = 15_000 })`.
- Both return a discriminated result: `{ ok: true, body }`, `{ ok: false, kind: 'http', status,
  error }` or `{ ok: false, kind: 'network' }`. Response bodies are validated with zod; an
  unexpected shape is `kind: 'http'` with error `bad_response`.
- `getAgentStatus` signs with `signAgentRequest` for `GET /v1/agent/status` at `now()` seconds.

### `src/payper402.ts`

- `runPayper402(argv: string[], env: Record<string, string | undefined>, io: CliIo, deps:
  Payper402Deps = {}): Promise<number>`, where `deps` carries `fetch?`, `now?`, `platform?`
  (for the Windows `cmd /c` line), and the existing `CliDeps` for `run`. It returns the exit code.
- The file's entry check runs it when executed directly, like `cli.ts`.
- Commands as §6.2–§6.7. `onboard`, `status` and `help` write only through `io`. `mcp` is the
  exception: its stdout is the protocol.
- **`mcp`:** move the body of `src/mcp.ts` `main()` into an exported
  `startMcpStdio(config: AgentConfig, log)` and call it from both `main()` and `payper402 mcp`.
  `main()` keeps its behaviour exactly. `payper402 mcp` builds `config` with `loadAgentConfig`
  as §6.5 says.
- **`run`:** call `runCli(rest, { ...env, AGENT_PRIVATE_KEY, SELLER_URL }, io, deps)` as §6.6
  says, where `AGENT_PRIVATE_KEY` is the config's seed.

### `bin/payper402.mjs`

```js
#!/usr/bin/env node
import { register } from 'tsx/esm/api';
register();
const { main } = await import('../src/payper402.ts');
await main();
```

- `main()` in `payper402.ts` is the process entry: `runPayper402(process.argv.slice(2),
  process.env, stdio)` with `process.exitCode` set from the result, and `SIGINT` aborting `run`.
  The file's own entry check calls the same `main()`.
- `apps/agent/package.json` gets the script
  `"payper402": "tsx --env-file-if-exists=../../.env src/payper402.ts"` and **no** `bin`.
- Root `package.json` gets `"bin": { "payper402": "apps/agent/bin/payper402.mjs" }` and the script
  `"payper402": "npm run --silent payper402 -w apps/agent --"`. Run `npm install` after adding
  the `bin` so the lockfile records it.
- The repo `.env` is read only through the npm scripts (as `npm run agent` does). The global
  command and the `node …/payper402.mjs` form read only the real environment.

### Tests (`payper402.test.ts`, `status-format.test.ts`)

Use the facilitator `Harness` from `@payper402/facilitator/test-support` over HTTP (`h.url()`), a
temporary `PAYPER402_HOME`, and captured `io`.

- **help / version:** no command, `help`, `--help` and `-h` print the usage with the resolved
  config path and exit 0; `version` prints the package version; an unknown command or flag prints
  the usage to stderr and exits 1.
- **onboard:** with a claim issued through the operator API, `onboard --claim <code> --api <url>`
  exits 0, writes the config, prints the §6.3 text (the Windows variant when `platform` is
  `win32`), and the facilitator's agent has the config key's public key. The printed output and
  the request body never contain the private seed (check the captured request in an injected
  `fetch` wrapper).
- **onboard errors:** each row of the §6.3 table gives its message and exit 1, and writes no file;
  an existing config without `--force` makes no request; `--force` replaces it; `--seller`
  overrides the returned `sellerUrl`; with neither, the default seller URL is stored.
- **status:** prints the §6.4 lines for: ready, paused, each wallet status, each cap reason, no
  total limit, and a last charge; `--json` prints the body; no config gives the "not connected"
  error; an invalid config the "invalid" error; a 401 the "does not recognise" error.
- **Precedence:** with `AGENT_PRIVATE_KEY` set to another key in `env`, `status` still signs with
  the config key (§6.7).
- **status-format:** pure tests of every State line and the money and time formats.
- **End to end (one test):** a claim through the operator API → `onboard` → a session opened with
  the config's key against a seller whose facilitator is the same `Harness` facilitator → one paid
  call recorded under the new agent → `status` shows that spend in `agent.spentToday` and in the
  printed "this agent" figures. Wire the seller as `apps/agent/src/e2e.test.ts` already does
  (`startSeller({ facilitatorUrl: await h.url(), … })`). The harness clock is fixed at `T0`, so
  the session MUST use `nowSeconds: () => h.clock.now` and the `status` call
  `deps.now = () => h.clock.now`; `Date.now()` would fail both the commitment skew check and the
  §4.3 window.
- **mcp:** `startMcpStdio(config, log, transport?)` takes an optional transport (default
  `StdioServerTransport`). One test connects it to an in-memory transport pair against
  `startDemoEnv` and lists the three tools; another checks that `payper402 mcp` with no config
  writes nothing to stdout, writes the error to stderr and exits 1. `main()` in `mcp.ts` keeps its
  behaviour and is covered by the manual shim check.
- **run:** with a scripted Anthropic (the Phase 3 test seams) and the config, `run "task"` passes
  the config key and seller URL to `runCli`.
- **Shim (manual, recorded under Findings):** on Windows, `npm link` at the repo root, then
  `payper402 --help`, `payper402 version`, and `payper402 mcp` with no config (nothing on
  stdout, the error on stderr); `npm run --silent payper402 -- --help` from the root; and `node
  <repo>/apps/agent/bin/payper402.mjs --help` from another directory. Remove the link afterwards
  (`npm unlink --global payper402`). If `npm link` does not give a working command, stop and
  report it (design spec §6.8); do not invent another route.
- **Unknown command:** the `Error:` line then the usage, both on stderr, exit 1 (design spec
  §6.1).

## Milestone 3: web

- **Config:** the three variables of §8.1, validated with the existing zod config, with the
  defaults stated there.
- **Facilitator client:** `operator(key).createClaim({ name, sellerUrl })` → `{ claim }`, zod-checked.
- **Handler and route:** `POST /api/operator/agents/claims` as §8.2, through the existing
  `operatorRoute`, same-origin check, body limit and error mapping. A per-operator
  `SlidingWindow` from `lib/limits.ts` enforces `WEB_LIMIT_CLAIMS_PER_HOUR`. The `command` string
  is built server-side.
- **Copy:** `too_many_claims` gets the §8.2 text in `lib/copy.ts` (or wherever web-app.md §8.6 copy
  lives). The limit answer is 429 `claim_limit` with `CLAIM_LIMIT_MESSAGE` = "Too many claim codes
  right now. Try again later.", a constant beside `RUN_LIMIT_MESSAGE`.
- **UI:**
  - `AgentNameForm` gains an optional `onClaim(claim, command)` prop. When the prop is set, the
    secondary button "Connect from a terminal" is shown under "Create agent", using the same
    validation and busy state.
  - `ClaimPanel` renders §8.3 with the existing code-block and button styles, and the toast
    "Command copied".
  - Onboarding step 3 and the Agents drawer pass `onClaim` and show the panel, with "I ran the
    command" (onboarding) or "Done" (drawer).
  - The "Install the payper402 command" link points to `${NEXT_PUBLIC_REPO_URL}#use-payper402-from-a-terminal`
    and is hidden without the variable.
- **Tests** (the existing handler test style, `operator.test.ts`): the route returns the claim
  and a command with `--api` set to `FACILITATOR_PUBLIC_URL` (and to `FACILITATOR_URL` when it is
  unset); it sends `SELLER_PUBLIC_URL` as `sellerUrl`; the name rule rejects `Bad Name`; a
  cross-origin request gets 403; the 11th claim in an hour gets 429 (pre-fill the per-operator
  window with `.hit()`, as `seller.test.ts` does for probes, because the facilitator answers 409
  from the 6th open claim); `too_many_claims` passes through; no session cookie is changed.
- **Limiter order:** as in the existing routes (`session.ts`, `runs.ts`), the web limiter takes its
  hit before the facilitator call, so a 409 from upstream still counts.
- **Browser check** (recorded under Findings): with `npm run dev:stack`, create a claim in the
  drawer and in onboarding step 3, run the printed command in a terminal with a temporary
  `PAYPER402_HOME`, and see the agent appear in the list.

## Milestone 4: docs and spec sync

- **README:** a section "Use PayPer402 from a terminal" (anchor
  `use-payper402-from-a-terminal`): `npm install` and `npm link` in the clone; the
  `npm run --silent payper402 -- …` and `node <repo>/apps/agent/bin/payper402.mjs …` forms
  without a link; `onboard`, `status`, `run`; the Claude Code `mcp add` lines (global command on
  macOS/Linux, `cmd /c` on Windows, and the `node …/payper402.mjs` form); where the config file
  lives, and that it holds the agent's private key like a `.env`. **Never** document `npx
  payper402`: the `bin` is on the root package, so `npx` would fall through to the npm registry
  and could fetch a stranger's package of that name.
- **Design spec:** a "Build notes" section in `operator-cli.md` for every place the build chose
  where the spec was silent.
- **Roadmap:** tick the build tasks. The marker moves only after the audit passes.

## Real API use

The builder makes **no** real PayPal, Anthropic or TypeSafe call. The user, after the audit:

1. `npm run dev:stack`, sign in, link the sandbox Personal account, set caps.
2. "Connect from a terminal", run the command, `payper402 status`.
3. `npm link` at the repo root, `claude mcp add payper402 -- cmd /c payper402 mcp`, then in
   Claude Code ask for a stock quote
   through the payper402 tools. The call appears on the dashboard under the new agent.
4. "Stop paying with PayPal" in the sandbox Personal account; `payper402 status` shows "PayPal
   stopped by the payer", and the next paid call is refused.

Use Claude Sonnet 5.5 for any real run (`ANTHROPIC_MODEL=claude-sonnet-5-5`).

## Findings

### Milestone 1: facilitator and shared signing

- Baseline before any edit: typecheck clean, 65 test files, 911 tests. After Milestone 1: 68
  files, 970 tests.
- **`foundation.test.ts` edit (exit criterion 6):** only the literals named in the criterion:
  lines 89, 111, 112, 127 and 149 `toBe(2)` became `toBe(3)`, line 126 `version: 3` became
  `version: 4`, and line 163 `VALUES (3, 0)` became `VALUES (4, 0)`. No other existing test was
  edited.
- **Choices where the specs were silent:**
  - The shared agent insertion is `insertAgent` in `routes/agents.ts` (row, `agent.created`
    audit record, `agent_key_exists` check). It does **not** emit `agent.updated`: the claim
    route must emit after its transaction commits, so both callers emit themselves.
  - `clientKey` returns `'shared'` also when `FACILITATOR_TRUST_PROXY=1` but the request has no
    `X-Forwarded-For` (the web limiter uses `'unknown'`); one bucket either way.
  - The redeem route reports both a bad `code` and a bad `publicKeyX` in one 400 `issues` list.
  - `agentAuth` logs one debug line per request with the request id and a reason category
    (`bad_header`, `stale`, `unknown_agent`, `bad_signature`); the client always sees the same
    401. The signed path is `req.baseUrl + req.path`; the tests build headers with the package's
    `signAgentRequest` and the literal `/v1/agent/status`.
  - `SlidingWindow` in `rate-limit.ts` sweeps expired keys when it holds more than 10,000, so
    rotating client keys cannot grow the map without bound.
  - `Config` gained a required `trustProxy: boolean`; `testConfig` sets it to `false`, and
    `createHarness` passes `rateClock: () => clock.now * 1000`.
  - The usage query of `GET /v1/operator` is now `operatorUsage` in `views.ts`, used by both
    routes. The operator route's response is unchanged.
- **Ordering note:** `express.json` runs before the redeem limiter, so a request with malformed
  JSON gets 400 without counting against the limit. Not restructured.

### Milestone 2: the `payper402` command

- After Milestone 2: 71 test files, 1,055 tests; `npm run typecheck -w apps/agent` clean.
- **Choices where the specs were silent:**
  - `redeemClaim` and `getAgentStatus` results for an HTTP failure also carry `issuePaths`, the
    `path` of each issue in a 400 body, so `onboard` can tell a 400 on `code` ("not valid") from
    any other 400 ("answered 400"). Both calls refuse redirects (`redirect: 'error'`), so a signed
    request is never forwarded to another host.
  - The response schemas are `z.looseObject`, so `status --json` prints every field the
    facilitator sent, not only the ones the CLI reads.
  - With a config file that exists but is invalid, `onboard` without `--force` answers "This
    machine already has a config at <path>. Use --force to replace it; the old key is deleted."
    (the spec's message needs the agent name, which an invalid file cannot give).
  - `onboard` also checks that the returned agent's `kid` is the generated key's `kid`, and
    writes nothing when it is not (it cannot happen against a correct facilitator).
  - A missing `--claim`, an unknown flag and an unexpected positional argument are usage errors
    (the `Error:` line, then the usage, on stderr). An invalid `--api`/`--seller` URL is a plain
    `Error:` line, with no usage.
  - A seller URL returned by the facilitator is trimmed of trailing slashes before it is stored.
  - `status`: with a total limit the Limits line ends "${amount} total"; a charge status such as
    `needs_review` is printed as "needs review"; an unknown wallet status reads "PayPal is not
    active". The singular "1 call" is used.
  - `payper402 run` and `mcp` pre-validate their flags with a strict `parseArgs` (so an unknown
    flag gets the usage), then hand the original arguments to `runCli` / `loadAgentConfig`. An
    agent-configuration error from `run` is printed by `runCli` as it always is (no `Error:`
    prefix); from `mcp` it is printed with the `Error:` prefix.
  - `startMcpStdio(config, log?, transport?)` returns `{ ok: true, server, session }` or `{ ok:
    false, message }` instead of throwing, so `src/mcp.ts` `main()` keeps its exact messages and exit
    codes and `payper402 mcp` adds the `Error:` prefix. `SIGINT` is hooked only for `run`: hooking
    it for `mcp` would stop Ctrl-C from ending the server.
  - `runPayper402` reads only the `env` argument, never `process.env`; every test sets
    `PAYPER402_HOME` to a temporary directory.
  - The lockfile gained the root `bin` entry through `npm install --package-lock-only` (the dev
    stack was running, so a full install could have failed on locked files); that was the only change.
- **Manual shim check (Windows 11, Node 24.22.1, npm global prefix `%APPDATA%
pm`):** `npm link` at
  the repo root created `payper402`, `payper402.cmd` and `payper402.ps1`. All with a temporary
  `PAYPER402_HOME`:
  - Git Bash: `payper402 --help` printed the usage, exit 0; `payper402 version` printed `0.0.0`;
    `payper402 mcp` with no config wrote 0 bytes to stdout and the "not connected" error to
    stderr, exit 1.
  - `cmd /c payper402 --help`, `version` and `mcp` (no config): the same results.
  - PowerShell: `payper402 version` worked (the `.ps1` shim was not blocked in the builder's shell).
  - `npm.cmd run --silent payper402 -- --help` from the repo root: the 14-line usage with no npm
    banner on stdout, exit 0.
  - `node D:PayPer402appsagentinpayper402.mjs --help` from another directory: same, exit 0;
    `mcp` with no config: exit 1, nothing on stdout.
  - A real MCP handshake through the shim (a throwaway script, deleted afterwards): an MCP client
    spawned `node …/payper402.mjs mcp` with a config pointing at the in-process demo seller,
    listed the three tools, made one paid `call_service`, and the seller's ledger recorded one
    commitment with the config key's `kid`. Stdout carried only the protocol; the ready line and
    event lines went to stderr.
  - The link was removed afterwards (`npm unlink --global payper402`); the three shims are gone.

### Milestone 3: web

- **Choices where the specs were silent:**
  - `FACILITATOR_PUBLIC_URL` and `SELLER_PUBLIC_URL` use an optional-URL zod field and fall back in
    `parseWebConfig` (the existing `url(fallback)` helper only takes a static default); blank means
    unset, and an invalid value names the variable in the 503.
  - `AgentNameForm` now shares one `submit` for both buttons, and a non-validation error from
    either goes through `errorCopy`, so `too_many_claims` shows the §8.2 copy. (This also maps the
    existing agent-creation errors through `errorCopy`; no existing code has copy, so it changes
    nothing today.)
  - The claim panel's time is the browser's local time, `HH:MM`, from `expiresAt`.
  - "Install the payper402 command" opens in a new tab and is hidden when `NEXT_PUBLIC_REPO_URL` is
    unset or blank.
- **Tests:** `apps/web/src/lib/handlers/claims.test.ts` (config defaults, the route, the limit, the
  409 pass-through, no cookie change). `operator.test.ts` is untouched and still asserts the
  `{ generatedKey: false }` audit details.
- **Browser check (done by the builder):** a production build (`next build`) compiled. Because the
  user's stack uses fixed ports and a fixed database (`data/stack.db`), the builder ran a throwaway
  stack instead: a facilitator on :14020 with a temporary database and a fake PayPal, and `next
  start` on :13000 (both stopped and deleted afterwards; no real PayPal, Anthropic or TypeSafe
  call). In the browser, as the demo operator:
  - Onboarding step 3: "Connect from a terminal" showed the claim panel with the command, the
    Copy button, "Code … · expires at … (15 minutes)", the key note, the `claude mcp add` block, and
    the single footer button "I ran the command" (no "Skip for now" or "I saved the key"). The
    repository link was hidden (no `NEXT_PUBLIC_REPO_URL`).
  - The printed command, run with `node apps/agent/bin/payper402.mjs onboard …` and a temporary
    `PAYPER402_HOME`, connected `research-bot`; `payper402 status` printed the seven lines
    ("State  PayPal not linked", the demo caps); the agent appeared in the Agents list.
  - Agents drawer (`?new=1`): the secondary button sits under "Create agent"; an empty name shows
    the name error; with a name it showed the panel and a single "Done" button; after the CLI
    redeemed the code, "Done" closed the drawer and the list showed both agents.
  - Not checked: the copy-to-clipboard toast, and a mobile viewport.

### Milestone 4: docs

- README section "Use PayPer402 from a terminal" (anchor `use-payper402-from-a-terminal`), with the
  `npx` warning; the web, facilitator and agent READMEs list the new variables, route and rate
  limits; the design spec has a "Build notes" section (§11); the four build tasks in the roadmap
  are ticked and the Current phase marker is untouched.

### Final results

- `npm run typecheck`: exit 0, no errors in any workspace.
- `npm test`: 72 test files passed; 1,065 tests passed, 1 skipped (the POSIX file-mode check on
  Windows). Before the build: 65 files, 911 tests. The 155 new tests: scheme-paypal 8, facilitator
  51 (claims 36, agent-status 15), agent 86 (one skipped on Windows), web 10.
- The private name check in `CLAUDE.local.md`: prints nothing on tracked files. Run again with
  `--untracked` it matches only the two pre-existing untracked prototype pages
  (`PayPer402-prototype.html` and its copy under `docs/`), where a minified script contains the
  letters of one pattern as a regular-expression word; none of the new or changed files match.
- **Spec conflicts found:** none between this file and the design spec. One wording point: §3.4
  says the shared insertion makes the event and audit record "cannot drift"; the event is emitted
  by the callers (after the commit), the row and audit record by the shared function.
- **Not done / not verified:** the real-sandbox "Done when" items 4 and 5 (a Claude Code session
  paying through `payper402 mcp`, then "Stop paying with PayPal"); the audit.

## Working rules for the builder

- Implement milestone by milestone; run `npm run typecheck` and the affected tests after each.
- Do not edit existing tests (exit criterion 6). If an existing test fails, the change is wrong.
- Do not add dependencies.
- Do not commit or push.
- Record under Findings: every choice where the specs were silent, the manual shim and browser
  checks, and any spec conflict you found.
