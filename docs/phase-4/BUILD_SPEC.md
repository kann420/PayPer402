# Phase 4 build spec: web app and AG Studio dashboards

Implementation plan for Phase 4 of [docs/ROADMAP.md](../ROADMAP.md). Draft 4 (2026-10-18): adds
[Milestone 11](#milestone-11-shared-payment-tokens-and-second-run-fixes) after the user's second
local run, with design spec draft 5 and facilitator spec draft 3.3. Milestones 1 to 10 are built and
audited; their text is unchanged except the `dev:stack` session secret.

- **Specs:**
  - The behaviour is defined in [docs/spec/web-app.md](../spec/web-app.md) (the **design spec**).
  - The facilitator, agent and protocol specs stay authoritative for their own parts.
  - The look comes from the frozen boards in [docs/design/](../design/README.md), corrected by
    [docs/ui-design-fixes.md](../ui-design-fixes.md).
  - If this file disagrees with a spec, the specs win. Report the conflict; do not silently pick
    one.
- **Read first:**
  - `CLAUDE.md`, and `CLAUDE.local.md` if present. All conventions apply: English only, sandbox
    only, no secrets in code or logs, no unlisted dependencies, no commit or push.
  - Next 16 ships its own docs in `node_modules/next/dist/docs/`. Read the pages on route handlers,
    streaming, `server-only`, `next/dynamic`, `next/font`, environment variables and
    `transpilePackages` before using them; Next 16 differs from older versions.
- **Skills:**
  - Load the `claude-api` skill before writing any Claude code (CLAUDE.md requires it).
  - Before writing AG Studio code, read the spike (`spikes/ag-studio/`) and the AG Studio docs
    index (`https://www.ag-grid.com/studio/llms.txt`). Pages are fetched with `Accept:
    text/markdown`.

## Goal and exit criteria

Phase 4 is done when all of the following hold:

1. **The plumbing checks (Milestone 1) pass,** and their results are written under
   [Findings](#findings).
2. **The facilitator additions** (design spec §5) and **the agent prompt amendment** (§6) are in,
   with tests. facilitator.md and agent.md have change notes.
3. **`apps/web` implements design spec §2–§16,** tested in Vitest:
   - unit tests for every pure module
   - an integration test of the route handlers against the facilitator harness (fake PayPal), the
     demo seller (fake AI) and a scripted Claude:
     1. sign in
     2. link
     3. caps
     4. create an agent
     5. run and pay
     6. "Charge now", which captures exactly the sum
     7. revocation
     8. a second run, which gets exactly one `refused` (`wallet_revoked`)
4. **`npm run dev:stack` starts the whole product locally,** and every screen renders against it.
   1440 px screenshots of every screen have been compared with the same boards as rendered by the
   user's prototype (`PayPer402-prototype.html`; the board files themselves need the Claude
   Design runtime). The differences are listed under Findings, each fixed or justified.
5. **Real API use** (below) has run, and its results are recorded.
6. **These all pass:** `npm run typecheck`, `npm test`, `npm run build -w apps/web`, and the name
   check in `CLAUDE.local.md`.

The roadmap's "Done when" (the whole flow in a browser with a sandbox Personal account) is then
run by the main session with the user, who approves on PayPal's page.

## Dependencies

| Package | Where | Version |
|---|---|---|
| `next` | `apps/web` | `16.4.2` exact |
| `react`, `react-dom` | `apps/web` | `19.3.1` exact |
| `ag-studio`, `ag-studio-react` | `apps/web` | `3.0.0` exact (must be identical) |
| `ag-grid-react` | `apps/web` (types for cell renderers; already installed by `ag-studio-react`) | `~36.2.0`, the same range `ag-studio-react` declares, so only one copy is installed |
| `@anthropic-ai/sdk` | `apps/web` | `^0.135.0` |
| `zod` | `apps/web` | `^4.6.7`, as in the other apps. Each app has its own 4.6.7 under `apps/*/node_modules/zod`, checked on 2026-10-17. The root copy is 3.25, so the dependency must be declared. |
| `server-only` | `apps/web` | `0.0.1` |
| `tailwindcss`, `@tailwindcss/postcss` | `apps/web` | the latest 4.x at install time (4.3.3 when this was written), then pinned to that exact version |
| `@payper402/agent`, `@payper402/scheme-paypal` | `apps/web` | workspace `"*"` |
| `@payper402/facilitator`, `@payper402/demo-seller` | `apps/web`, used only by `scripts/` and tests, never imported by `src/` page or route code | workspace `"*"` |
| `@types/react`, `@types/react-dom` | `apps/web` dev | `^19.3.0` |

**Do not add:**

- an ORM or database
- a state library
- a UI kit, an icon package or a chart library besides AG Studio
- `dotenv`, `axios`, `swr`, `react-query` or `clsx`
- a testing DOM (jsdom, Testing Library)

Icons are the boards' inline SVGs. The `.env` file is loaded by `tsx --env-file-if-exists` for
scripts; for Next, see `dev:stack` below.

CLAUDE.md's stack line already lists Tailwind CSS v4.

## Framework facts (checked while writing this spec)

- **Next 16.4.2 (Turbopack)** builds the AG Studio spike. `'use client'` is enough for Studio, and
  no CSS import is needed. The Studio host element needs an explicit height.
- **Workspace packages export TypeScript sources** (`"exports": "./src/index.ts"`). Next's docs
  (`transpilePackages.md`) say Turbopack transpiles workspace packages automatically. Set
  `transpilePackages: ['@payper402/agent', '@payper402/scheme-paypal']` anyway, as a safeguard.
  Milestone 1 proves the build either way.
- **`@payper402/agent`:**
  - Its barrel imports `@anthropic-ai/sdk`, `@typesafe-ai/sdk`, `@modelcontextprotocol/sdk` (stdio
    transport), `@x402/core/client` and `node:crypto`.
  - It does **not** import `@payper402/facilitator` or `better-sqlite3`.
  - It is server-only. A client component MUST NOT import it, or `@payper402/scheme-paypal`.
- **The facilitator exports** `./server`, `./config`, `./auth`, `./seed`, `./logger` and
  `./test-support`. It has no `.` export and no exported view types, so `apps/web` declares its
  own zod schemas for the API responses (design spec §7). It MUST NOT import facilitator source
  paths.
- **Facilitator SSE:** the first chunk is `: connected`, keepalives arrive every 15 s, and there
  are no ids and no replay.
- **`PUT /v1/operator/caps` replaces all caps:** omitting `total` clears it.
- **`POST /v1/settlements` answers 201** with any status: `completed`, `pending`, `failed` or
  `needs_review`.
- **Unlink:** a 409 `wallet_not_active` from unlink carries no `wallet`.
- **`centsToUsdString`** (scheme) throws on 0. Use the web formatter (design spec §8.2).
- **AG Studio 3.0.0 (spike):**
  - The view-mode AI panel needs the cast `['ai'] as unknown as 'filters'[]`.
  - `createAiHarness(api, …)` is used inside `ai={({ api }) => …}`.
  - `directLlmRunner` takes the read-only tools from `({ tools: { studio } })`.
  - Field ids are `<source>.<field>`.
  - Grid cell renderers come from swapping the grid widget's `comp` for `GridWidget`, with
    `options.createCellRenderer(field)`, where `field.fieldId` is the field id.
  - `layout.widgetPadding` is the space around each widget.
  - `ai`, `initialState` and `localeText` are read once, so the setup must be memoised.
- **Anthropic (Claude Sonnet 5.5 / Opus 5.5):**
  - Forced `tool_choice` is a 400.
  - Keep the history append-only, and pass thinking blocks back unchanged (the turn cache does
    this).
  - Use the beta client with `fallbacks: 'default'`.
  - Check `stop_reason` first.
  - The SDK accepts a custom `fetch`. Tests use it, so `npm test` never calls the real API.

If any of these turns out wrong at runtime, stop. Record what actually happens under
[Findings](#findings), and adapt within the design spec.

## Layout

```
apps/web/
  package.json          scripts: dev, build, start, typecheck ("next typegen && tsc -p tsconfig.json"),
                        dev:stack; "exports" none (an app)
  next.config.ts        reactStrictMode, transpilePackages, headers (design spec §15.2)
  postcss.config.mjs    @tailwindcss/postcss
  tsconfig.json         extends ../../tsconfig.base.json; DOM libs; jsx react-jsx; next plugin
  public/logo.png       the mark (copy of docs/design/canvas/assets/logo.png)
  scripts/dev-stack.ts  the one-command local stack (below)
  src/app/              App Router: layout.tsx, globals.css (Tailwind + tokens), page.tsx (landing),
                        sign-in/, link/complete/, app/** (operator), seller/**, api/** (route.ts files),
                        error.tsx, not-found.tsx, loading.tsx where needed
  src/components/       shell/, ui/ (StatusBadge, Button, KpiCard, Banner, Toast, Dialog, Drawer,
                        Stepper, CodeBlock, Money), studio/ (AG Studio client module), run/, landing/
  src/lib/              pure and server modules, each with *.test.ts:
                        config.ts, session.ts, origin.ts, limits.ts, money.ts, time.ts, status.ts,
                        caps-form.ts, facilitator.ts (typed client + zod schemas + error mapping),
                        catalog.ts, rows.ts (paid call rows, service resolution), banners.ts,
                        events-relay.ts, runs.ts (run registry + stream encoder), timeline.ts
                        (event → row model, meter reducer), ai-turn.ts (Claude translation, turn
                        cache), probe.ts, agents.ts (key generation + session keys)
  src/lib/handlers/     one factory per API route: createXHandler(deps) => (req) => Response;
                        the route.ts files only wire real deps. Tests call the factories.
```

**Route-handler pattern:**

- A handler reads the session from `request.headers.get('cookie')`, and writes it with a
  `Set-Cookie` header on the response, through `src/lib/session.ts`.
- Only `POST /api/session` and `POST /api/operator/agents` write the cookie (design spec §4.1).
- Handlers do not use `next/headers`, so they run under Vitest.
- Pages (server components) MAY read the cookie with `cookies()` through the same session module.
  They never set or delete it; Next 16 forbids that during rendering.

**Tests:**

- Tests live in `apps/web/src/**/*.test.ts`. The root Vitest config matches only
  `apps/*/src/**/*.test.ts`, with no DOM. React components are not unit-tested; their logic lives
  in `src/lib`.
- Add `apps/web` to nothing else: the root `typecheck` already runs every workspace.

**Root `package.json`** gets one script: `"dev:stack": "npm run dev:stack -w apps/web --"`.

### `npm run dev:stack`

`apps/web/scripts/dev-stack.ts`, run with `tsx --env-file-if-exists=../../.env`, does the
following. It follows the demo command's pattern (agent.md §9) and reuses its exported pieces.

0. Check that ports 3000, 4020 and 4021 are free. If one is taken, print "Port <n> is in use.
   Stop the process using it (an earlier dev:stack that was killed hard leaves its children
   running on Windows), then try again." and exit 1. This step was added after the build.
1. Start the facilitator in process with `loadConfig`:
   - `PORT` 4020
   - `PUBLIC_BASE_URL` `http://localhost:4020`
   - `WEB_APP_URL` `http://localhost:3000`
   - `DATABASE_PATH` `<repo>/data/stack.db`
   - `ADMIN_API_KEY`: from the env, or 32 random bytes in hex for this run
   - `LOG_LEVEL` `warn` unless set
   
   Then `startFacilitator` with its normal jobs.
2. Seed with `seed()`, which ensures the "Acme Data" seller. Then issue a run-scoped seller key
   with `issueApiKey`, label `dev-stack`.
3. Start the demo seller in process: `startSeller` on 4021, with `createClaudeSellerAi`.
4. Spawn the Next server with `process.execPath`, resolving `next/dist/bin/next`, never a shell:
   - `dev --port 3000`, or `start --port 3000` with `--prod`, which needs a prior `npm run build -w
     apps/web`
   - its env: `FACILITATOR_URL`, `FACILITATOR_ADMIN_KEY`, `WEB_SELLER_API_KEY`, `SELLER_URL`,
     `WEB_PUBLIC_URL`, `WEB_SESSION_SECRET` (from the env, or else the secret kept in
     `data/web-session.key`, resolved before step 1; Milestone 11), plus the inherited Anthropic and TypeSafe variables
   - stdout and stderr piped through with a `[web]` prefix
5. Print the URLs. On Ctrl+C or when the child exits:
   - stop the child
   - revoke the run-scoped seller key (as the demo does)
   - close the seller and the facilitator

It requires `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DATA_ENCRYPTION_KEY` and
`API_KEY_PEPPER`, plus Anthropic credentials. It lists any that are missing and exits 1. It never
prints keys.

## Milestone 1: plumbing checks

Fast checks before real logic. Keep each as a test or a script, and record the outcome under
Findings.

1. **Scaffold** `apps/web` with one page, one Node route handler and Tailwind v4 with one token.
   `npm run build -w apps/web` passes.
2. **Workspace server imports:** a route handler imports `@payper402/agent` (`openSession`,
   `runAgent`, `REFUSAL_NOTES`) and `@payper402/scheme-paypal` (`generateAgentKey`). Then:
   - `next build` passes
   - the route runs under `next start` and returns a generated `publicKeyX`
   - the client bundle has neither package: grep `.next/static` for `node:crypto` and
     `modelcontextprotocol`
3. **Streaming and abort:** a `text/event-stream` route handler writes a frame every 100 ms. When
   the client aborts the fetch, the handler's `request.signal` fires and its interval stops. Prove
   it with a log line or a counter under `next start`.
4. **`server-only`:** importing a `server-only` module from a client component fails the build.
   Try it once, then revert.
5. **AG Studio in `apps/web`:** port the spike's Overview Studio, with the view-mode AI panel cast
   and the read-only analyst agent, to a test page.
   - It renders under `next start`.
   - One real AI question works (see Real API use).
   - Record whether `api.setState({ panels: { ai: { collapsed } } })` opens and closes the panel in
     view mode (design spec §12.4).
6. **Grid row merging:** a grid widget fed two rows that are identical in every shown column.
   Record whether they merge, and whether a hidden or narrow `id` column keeps them apart. Choose
   the approach for §11.2 from the result.
7. **Cookie and redirect chain:**
   - A sealed cookie set by `POST /api/session` has the attributes of design spec §4.1.
   - It is sent on the redirect chain from the facilitator's `/paypal/cancel` to
     `/link/complete`, which then renders the operator's state.
   - `localhost:4020` to `localhost:3000` is same-site, because SameSite ignores the port, so this
     does not exercise the cross-site case. The cross-site property rests on browsers sending
     `Lax` cookies on top-level GET navigations. The real chain through PayPal is verified in the
     roadmap's "Done when" run.

Delete the test page and route after Milestone 1, keeping their tests where they make sense.

## Milestone 2: facilitator additions and agent amendment

**Facilitator** (design spec §5):

- `ADMIN_API_KEY` in `config.ts`: optional, at least 32 characters. The config error names the
  variable only.
- `POST /v1/admin/demo-operators`, mounted only when the key is set.
- The `usage` fields, `blockReason`, and `pendingCalls`.
- facilitator.md: a change-notes entry, plus edits to §3 (the variable), §7.2 and §7.3 (the fields)
  and a new §7.7 (the admin route).
- `.env.example` gets `ADMIN_API_KEY` (commented).

**Tests (facilitator harness):**

- **Admin route:**
  - It is not mounted without the key (404).
  - A wrong key gets 401, and an operator key gets 401.
  - It creates an operator with the demo caps, a `not_linked` wallet, and an audit record.
  - The returned key works on `GET /v1/operator`.
  - Two calls create two operators.
- **Usage:**
  - `notYetChargedCalls` counts `unsettled` and `settling`, and matches `notYetCharged`.
  - `chargeable` and `chargeableCalls` count `unsettled` only. With a `needs_review` settlement
    holding `settling` commitments, `chargeable` is lower than `notYetCharged`, and a manual
    settlement claims exactly `chargeable`.
  - `notCollected` and `notCollectedCalls` after a revocation.
  - `pendingCalls` for the seller.
- **`blockReason`:** each of the four reasons, and `null`. A paused agent still reports the
  operator's reason.
- `checkInvariants()` holds after each test.

**Agent** (design spec §6):

- `SYSTEM_PROMPT` and agent.md §6.2 get the new text. The tests that pin the prompt are updated.
- agent.md gets a change note.
- Add `"./test-support": "./src/test-support.ts"` to `apps/agent/package.json` `exports`, and
  export a scripted Anthropic `fetch` from it, if it is not already exported. The web integration
  test needs one. Change nothing else in `apps/agent`.

## Milestone 3: web foundation

- **`src/lib`:**
  - `config` (§3.1, lazy zod validation)
  - `session` (§4: seal, unseal, cookie attributes, read and write on `Request` and `Response`, at
    most 5 agent keys)
  - `origin` (§15.2)
  - `limits` (§15.3)
  - `money` (§8.2)
  - `time` (§8.3)
  - `status` (§8.4)
  - `facilitator`: a typed client with zod response schemas for every route used, and the error
    mapping of §7
  - `catalog` (§8.5, 60 s cache)
- **Tailwind v4 theme** from `DesignSystem.dc.html`:
  - every colour token
  - the fonts, through `next/font/google`, as CSS variables
  - radii and shadows
  - the dark tokens for the landing and live run
- **The shell (§9):**
  - the sandbox strip, sidebars, top bar, demo-account switcher and footer
  - "Start over" with its dialog
  - the narrow-screen nav
- **UI components** as listed in Layout, matching the DesignSystem and States boards: `StatusBadge`
  (§8.4) is the only way to show a status.
- **Session and pages:**
  - `POST /api/session` (§4.2)
  - the page guards (§4.3)
  - the sign-in page (§10.2)
  - `error.tsx`, `not-found.tsx` and the loading skeletons (§10.14)
- **`scripts/dev-stack.ts`** and the root script.

**Tests:**

- **session:**
  - a round trip
  - a tampered cookie, a wrong key, and an unknown `v`, each of which counts as no session
  - the attributes (`HttpOnly`, `SameSite=Lax`, `Secure` only for https)
  - a new cookie gets a fresh `sid`; a reused one keeps it
  - the cap of 5 agent keys, which drops the oldest
- **scope guards** (design spec §4.3): `/api/events` and `/api/ai/turn` with `scope=operator`
  need an operator in the session, and with `scope=seller` any valid session.
- **seller key 401:** maps to 503 `seller_unavailable`, not `session_ended`.
- **origin:**
  - the same origin passes
  - a foreign `Origin` fails
  - with `Origin` missing, a matching `Referer` passes
  - with neither, the request fails
- **limits:** the window maths, with an injected clock.
- **money:** 0, 1, 99, 100, 123456, negative values, and tabular formatting does not alter the
  value.
- **time:** UTC formatting around midnight.
- **status:** every enum value of every domain has an entry. The agent rule (Paused before Blocked,
  the tooltip per reason) holds.
- **facilitator client:**
  - every schema parses the real responses captured from the harness
  - 401 maps to `session_ended`
  - 409s pass through
  - 5xx maps to `upstream_error` with `ref`
- **`/api/session` against the harness:**
  - create
  - reuse
  - reuse after 401, which creates a new operator
  - `startOver`
  - the 429 at the limit
  - seller

## Milestone 4: onboarding, return page and settings

Screens §10.3–§10.6, §10.12 and §10.13. Routes `wallet/link`, `wallet/refresh`, `wallet/unlink`,
`caps` and `agents` (POST, PATCH).

- **`caps-form`** (§10.4): one pure module for parsing and validation, used by onboarding and
  Settings.
- **`agents`:** key generation, registration through `publicKeyX`, the creation response and the
  session key list (§4.4). The `.env` and JWK downloads are built in the browser.
- **Link states:** a pure function decides the state, from `GET /v1/operator` (§10.3). The
  Collecting and needs-review cases are part of it.

**Tests:**

- **caps-form:** every validation rule and message; the full payload with `total: null`.
- **The link-state function:** every row of the §10.3 table, including Collecting and
  Collecting-needs-review.
- **Polling rules:**
  - the Collecting states never call `/refresh`
  - in the Waiting state, a 409 `settlement_in_progress` from `/refresh` produces no toast and
    leads to the Collecting state on the next read
  - `/link/complete?status=waiting_for_approval` with a pending relink shows Collecting
- **Charge and unlink amounts:** they use `chargeable` and `chargeableCalls`. "Charge now" is
  disabled when `chargeable` is 0, even if `notYetCharged` is not.
- **The agents handler against the harness:**
  - the facilitator stores only the public key
  - the response holds the seed once
  - the session holds the seed
  - a sixth agent drops the oldest key
- **The unlink handler:**
  - 200
  - 409 `settlement_failed`, passed through with the declined copy code
  - 409 `settlement_in_progress`
- **The caps handler:** a facilitator 400 maps back to field issues.

## Milestone 5: live run

Screen §10.10, route `/api/runs` (§14), with the `runs` and `timeline` modules.

- **`runs`:**
  - the run registry: one run per operator; the limits; release in `finally`
  - the stream encoder: frames in order, and the keepalive
  - the combined abort signal (the request plus 180 s)
- **`timeline`:** a pure mapping from each frame and event to a row model (§10.10 table), and the
  budget meter reducer.

**Tests:**

- **timeline:** every event type and variant:
  - `refused` by the agent and by the facilitator
  - each `check` status
  - `failed` with `charged: 'unknown'`
  - every `result` status
  - the blocked end-card rules (spent 0, and spent more than 0)
  - the meter values after a scripted sequence
- **runs:**
  - a second concurrent run gets 409
  - the per-day and per-hour limits
  - an aborted request releases the slot and aborts `runAgent`, through an injected runner that
    waits on the signal
  - frame order: `catalog`, the `agent` frames, then `end`
  - `error` after a `CatalogError`
- **Integration (harness, seller with fake AI, scripted Claude):** a run with the wallet `active`
  pays two services. The `agent` frames include `paid` events whose `commitmentId`s are in the
  ledger.

## Milestone 6: operator dashboards

Screens §10.7–§10.9. Modules `rows`, `banners` and `events-relay`. The AG Studio client module,
§11, with no AI panel yet. Route `/api/events` and `POST /api/operator/settlements`.

**Tests:**

- **rows:**
  - commitments become rows: service resolution, the endpoint with its query, UTC `time` and `day`,
    status labels, the short charge id
  - paging stops at 5,000 rows, at the `since` cutoff, and when a page adds no new row
  - a page boundary inside one second: the next page uses `before = last + 1`, the rows of that
    second are all present, and none appears twice
- **banners:** each priority row of §10.7, and when several conditions hold, the first one wins.
- **events-relay:**
  - **operator:** a browser abort aborts the upstream fetch; the upstream frames pass through
    unchanged; the facilitator comments are dropped; the relay's own keepalive is sent; an upstream
    429 maps to 429.
  - **seller:** two subscribers share one upstream; the upstream closes 30 s after the last one
    leaves, using an injected timer.
- **Charge-detail grouping:** grouping by service, with both the same-price and the mixed-price
  rendering.
- **Integration:** "Charge now" against the harness. A 201 `completed` captures exactly the sum of
  the run's paid calls (fake PayPal), and the events relay delivers `settlement.updated`.

## Milestone 7: AI assistant

§12. The adapter and `/api/ai/turn`, ported from the spike and hardened, plus the panels on
Overview and Seller overview, the prompt starters, `localeText`, and the "Ask AI" button behaviour
found in Milestone 1.

**Tests (`ai-turn`, scripted Claude fetch):**

- **Translation:**
  - system and instructions
  - tools become `input_schema` with `type: 'object'`
  - forced tool choice becomes a prompt line
  - preflight ids are sanitised, and the call id and its result id match
  - a trailing assistant turn gets the nudge
  - parallel calls are grouped into one assistant message and one result message
  - a JSON `responseFormat` becomes `output_config.format` with `json_schema`
- **Turn cache:**
  - replay by `<sid>:<message id>`
  - a session that sends another session's item id gets no replay; the turn is rebuilt from the
    history instead
  - each turn is replayed once
  - eviction at 50 per `sid` and 2,000 in total
- **Response mapping:** text, tool use and refusal; `max_tokens` becomes `incomplete`.
- **Guards:** no session gives 401; the limits give the `failed` "busy" response; the body cap.

## Milestone 8: seller console

Screens §10.11. The seller relay is already in Milestone 6. Route `GET /api/seller/probe/:serviceId`.

**Tests:**

- **probe:**
  - sample params per service
  - the base64 decode of `PAYMENT-REQUIRED`
  - an unknown service gives 404
  - the limit
  - against the real seller app (fake AI) and the harness, the probe returns 402 with a decoded
    `accepts[0]` of `batch-settlement` / `paypal:sandbox` / `USD`
- **Seller KPIs:** the week window in UTC, from fixed rows.

## Milestone 9: landing

Screen §10.1 (`Main`, `LandingMobile`):

- the hero animation, with the PayPal logo replaced by the PayPer402 mark
- the reduced-motion gate and the pause control
- the auto-advancing "How it works" tabs and the meter
- the sections
- the FAQ
- the links from `NEXT_PUBLIC_REPO_URL`

Test the stage ticker as a pure reducer: it advances, pauses, and freezes on the final stage under
reduced motion.

## Milestone 10: verification and docs

1. **Integration test (exit criterion 3):** the full flow in one test file, through the handlers.
2. **`npm run dev:stack`:**
   - Visit every route at 1440 × 1100, and the landing also at 390 px.
   - Take headless Chrome screenshots (the spike README shows the command), stored outside the
     repo.
   - Take the same board from the prototype for comparison: the user's untracked
     `PayPer402-prototype.html#/<Board>`; read it, never modify it.
   - List every visible difference under Findings, and fix it or justify it.
   - Check both themes of the dark boards, reduced motion, and keyboard navigation of the dialogs
     and the drawer.
3. **Docs:**
   - `apps/web/README.md`: what it is, `npm run dev:stack`, env names, and the routes.
   - `.env.example`: the web variable names (§3.1), commented where optional.
   - The design spec gets build notes for anything decided during the build.

## Milestone 11: shared payment tokens and second-run fixes

Added on 2026-10-18, after the user's second local run. The spec changes passed review in round 2 (2026-10-18). The behaviour is defined in facilitator
spec draft 3.3 (§5, §5.1, §8, §9.3, §10, §11, §12) and design spec draft 5 (§10.3, §10.10,
§10.13, §17). The specs win if this list disagrees with them.

**What happened.**

- The user restarted `dev:stack`. `WEB_SESSION_SECRET` was unset, so the restart ended their
  session. They signed in again as a new demo operator and linked the same sandbox Personal
  account.
- PayPal returned the payment token that the earlier operator already held. The main session
  checked this read-only against `data/stack.db`, without printing any id:
  - both new setup tokens were `VAULTED`
  - repeating `POST /v3/vault/payment-tokens` with each wallet's own `PayPal-Request-Id`
    returned 200 and one identical token, whose lookup hash equals the earlier operator's
    `vault_id_hash`
- The wallet `UPDATE` failed on `UNIQUE(vault_id_hash)`, and `/paypal/return` logged the error
  and redirected with `waiting_for_approval`.
- From then on, every `/refresh` saw `VAULTED`, not `APPROVED`, and returned early.
- The return page's "Check again" only re-read the operator, so nothing on the page could finish
  the link.

### Facilitator (`apps/facilitator`)

1. **Migration 2** (§5): rebuild `wallets` without `UNIQUE` on `vault_id_hash`. Keep every
   other column, `CHECK`, default and the `UNIQUE` on `link_state` exactly as in migration 1.
   Copy every row, then add the non-unique index `wallets(vault_id_hash)`. `rows.ts` types are
   unchanged.
2. **Release, rule (e)** (§5.1):
   - Add one helper, for example `releaseVaultToken(ctx, sealed, operatorId)`. It computes the
     hash, then checks in one statement whether another live holder exists: a wallet with
     `operator_id <> X`, the same `vault_id_hash`, and status `active`, `unlinking` or
     `waiting_for_approval`.
     - If none exists, it calls today's `deleteVaultToken`.
     - Otherwise it skips the PayPal call and records the audit `wallet.token_kept_shared`, with
       no id and no hash in the details.
   - Every current caller of `deleteVaultToken` goes through it: `startLink`, `finish`'s
     lost-race path, the relink failure's `sealedToDelete` in `settlements.ts`, and
     `finishUnlink`.
   - `deleteVaultToken` stays the only code that calls PayPal's DELETE.
3. **Revoke every holder** (§5.1, §9.3, §11, §12):
   - Add one transaction-scoped helper, for example `revokeTokenHoldersTx(db, vaultIdHash, now)`.
     It applies rule (d) through `revokeWalletTx` to each wallet with that hash in `active` or
     `unlinking`, and returns the revoked operator ids.
   - Use it in three places:
     - `revokeByVaultId` (webhook), with the three outcomes in §11
     - `healthCheck`, after a 404 or a revocation-class error. Only the checked wallet's
       `last_checked_at` is written.
     - the revocation-class outcome in `settlements.ts`, inside the existing outcome transaction,
       for `relink` too. The relink's own wallet is `waiting_for_approval`, so it is excluded by
       status and still follows §8 step 3.
   - Call `afterRevoke` (events and audit) once per revoked operator, after the commit.
   - A null `vault_id_hash` revokes nothing.
4. **Finishing a link** (§8 step 2):
   - Treat `VAULTED` like `APPROVED`: create the payment token with `PayPal-Request-Id = state`.
   - Failures:
     - Transient errors (`classifyPayPalError` gives `transient`) leave the wallet unchanged and
       propagate as today.
     - Any other PayPal error from `createPaymentToken`, or any error thrown while storing the
       result:
       - In a new transaction, with the rule (a) compare-and-set, set `link_failed` and
         `link_error: 'payment_token_failed'`. Clear `link_state` and `setup_token_id`.
       - Audit `wallet.link_failed` (error fields only) and emit `wallet.updated`.
       - If a token was created, release it with step 2.
       - Return the wallet.
   - `/v1/operator/wallet/refresh` then answers 200 with the `link_failed` wallet, and
     `/paypal/return` redirects with `status=link_failed`.
   - A failed `getSetupToken` behaves as today.
5. **Docs:** update `apps/facilitator/README.md` wherever it says a token or wallet is unique per
   operator, or describes deletion or revocation.

**Tests** (fake PayPal):

- The fake must be able to return one payment token for different setup tokens of one payer, and
  to report a setup token as `VAULTED`.
- Each bullet below is at least one test.
  - **Shared link:** two operators link, and the fake returns the same token for both. Both
    wallets become `active`, both seal the same id, and each wallet row carries the masked
    email.
    - Each operator settles on its own: two orders, each for its own amount.
    - The settlement-sum invariant holds.
  - **Webhook:** `VAULT.PAYMENT-TOKEN.DELETED` for the shared token revokes both operators.
    - Each operator's `unsettled` commitments become `uncollectable`, and there are two
      `wallet.updated` events. The outcome is `wallet_revoked`.
    - Also test `wallet_not_found` (no holder) and `wallet_not_revocable` (holders, none
      revocable).
  - **Health check:** a 404 on A's check revokes A and B. Only A's `last_checked_at` is set.
  - **Charge revocation:** a revocation-class error on A's settlement also revokes B.
  - **Relink:** a revocation-class error on A's `relink` (A in `waiting_for_approval`, token shared
    with an active B):
    - A follows §8 step 3 (`link_failed`, `relink_settlement_failed`)
    - B is revoked
    - the release then deletes the token, because B is no longer live
  - **Unlink while shared:** unlinking A while B is `active` makes no PayPal DELETE.
    - It records `wallet.token_kept_shared`, A ends `not_linked`, and B still settles.
    - Unlinking B afterwards deletes the token once.
  - **Release guard on the other paths:** `startLink` with a stored token, and `finish`'s
    lost-race path, both skip the DELETE while another live holder exists. A holder in
    `stopped_by_payer` does not count as live.
  - **Waiting holder is live:** unlinking A while B is `waiting_for_approval` with the same stored
    token (a finished link with its `relink` pending) makes no DELETE and records
    `wallet.token_kept_shared`. B's relink then charges and completes.
  - **`VAULTED` resume:** `finish` calls `createPaymentToken` with request id `state` and
    activates the wallet.
  - **Payment-token failure:** a non-transient 4xx from `createPaymentToken` gives:
    - `link_failed` with `payment_token_failed`, and the audit `wallet.link_failed`
    - `/refresh` 200 with `link_failed`
    - `/paypal/return` redirecting with `status=link_failed`
    
    A transient error leaves the wallet unchanged, and `/refresh` answers 502.
  - **Storing throws:** for example, make sealing throw once.
    - The wallet becomes `link_failed`, and the token is released: deleted when it has no other
      holder, and kept when another live holder exists.
    - When the `link_failed` write affects zero rows because a twin already stored the same
      token on this wallet, nothing is released and the wallet stays `active`.
  - **Migration 2:** a version-1 database with rows (linked, waiting and not-linked wallets)
    upgrades to version 2.
    - Every row is unchanged, and two wallets can then share a hash.
    - `link_state` is still unique, and the existing check that refuses a newer database still
      passes.
- Update any existing test that relied on the unique constraint. Record which ones under
  Findings.

### Web (`apps/web`)

1. **Theme script** (§10.10): add `suppressHydrationWarning` to the inline `<script>` in
   `src/app/layout.tsx`. Its content and position stay as they are.
2. **"Check again"** (§10.13):
   - It calls `/api/operator/wallet/refresh` at once.
   - It applies `refreshOutcome` and restarts the 10-minute window of `useWaitingPoll`.
   - It cancels the pending scheduled tick, and the next tick runs 3 s after its answer, so a
     manual check and a tick never overlap.
   - It is disabled while its request runs.
   - Keep the decision logic pure where it can be, and test it. Also add a Vitest test through the
     web handler and the facilitator test harness (fake PayPal): a `waiting_for_approval` wallet
     whose setup token turns `VAULTED` becomes `active` through `POST /api/operator/wallet/refresh`.
3. **`dev:stack` session secret:**
   - If `WEB_SESSION_SECRET` is set, use it and never touch the file.
   - Otherwise read `<repo>/data/web-session.key` (ignored through `*.key`):
     - **Exactly 64 hex characters after trimming:** use it, and print "WEB_SESSION_SECRET is
       not set: using the one kept in data/web-session.key, so sessions survive restarts."
     - **Missing:** create it with 32 random bytes in hex. Use exclusive create (`wx`) and mode
       `0o600` (best effort on Windows), and print the same line.
     - **Anything else:** print "data/web-session.key is not 64 hex characters. Fix or delete
       it, then try again." and exit 1. Never overwrite it.
   - Never print the value.
   - Put the logic in a small helper with tests: env wins, file reused, file created, malformed
     file refused.
   - **When:** resolve the secret before step 1, after creating `data/` if needed. A malformed
     file then fails before the facilitator or the seller starts, so no server is left running and
     no seller key is issued.
   - Update `apps/web/README.md` and the comment on `WEB_SESSION_SECRET` in `.env.example`.

### Checks for this milestone

- **The user's stack:** the builder must not stop or restart it, and must not write to
  `data/stack.db`.
  - Test migration 2 on a **copy** in a scratch directory outside the repo. The database runs in
    WAL mode, so copy `stack.db`, `stack.db-wal` and `stack.db-shm` together, read-only, then
    open and upgrade the copy:
    - every row count is unchanged after the upgrade
    - the wallets keep their status
    - no file under `data/` changes
- **Web changes:** no browser check against the user's stack. A demo operator and a started link
  would make the user's facilitator call PayPal and write to `data/stack.db`. The tests above
  cover "Check again". The theme script change is checked by reading the code (the mismatch needs
  the user's Chrome extension).
- **No PayPal sandbox calls** outside the mocked tests, and no Claude calls.
- **After the audit** (the main session and the user, recorded under Findings):
  - The user restarts `dev:stack` and signs in once. A second restart keeps the session.
  - Linking the same sandbox Personal account to the new demo operator ends at "You're linked."
  - Then the Phase 4 Done-when continues: run, charge, "Stop paying with PayPal". Within a
    minute every operator that holds the token is `stopped_by_payer`, and a new run is refused
    with `wallet_revoked`.

## Real API use (Claude Sonnet 5.5; keep it to these runs)

The root `.env` sets `ANTHROPIC_MODEL=claude-sonnet-5-5`. Do not switch to Opus, and do not
repeat runs without a reason recorded under Findings.

1. **Milestone 1:** one AI assistant question on the Studio test page.
2. **Milestone 2:** after the prompt change, `npm run demo` once, without `--link`. Record the
   timeline's first rows: a thinking note before the first call is expected.
3. **Milestone 5:** one run through `dev:stack` with an operator whose wallet is **not linked**.
   - Expect one `refused` (`wallet_not_linked`) and the blocked end card.
   - This exercises the real Claude request through the web route without PayPal.
4. **Milestone 7:** one question on Overview and one on Seller overview.

## Findings

Filled in by the builder, milestone by milestone. Baseline before Phase 4: 707 tests (agent 263,
scheme-paypal 203, facilitator 149, demo-seller 53, paypal-client 39).

### Milestone 1: plumbing checks (2026-10-17)

1. **Scaffold:** `apps/web` with one page, one Node route handler and Tailwind v4.3.3 with one
   token (`--color-ink-950`) builds with `next build` (Turbopack). `next.config.ts` sets the three
   response headers of design spec §15.2; `curl -I` shows them under `next start`.
2. **Workspace server imports:** a route handler importing `openSession`, `runAgent` and
   `REFUSAL_NOTES` from `@payper402/agent` and `generateAgentKey` from `@payper402/scheme-paypal`
   builds and, under `next start`, returns a fresh 43-character `publicKeyX`. A grep of
   `.next/static` for `node:crypto`, `modelcontextprotocol` and `typesafe` finds nothing, also after
   the AG Studio page was added (5.9 MB of client chunks, as in the spike).
3. **Streaming and abort:** a `text/event-stream` handler wrote a frame every 100 ms. When `curl`
   was cut after 1.2 s, the handler's `request.signal` fired (log: "stopped by signal after 11
   frames") and the interval stopped; the stream's `cancel()` callback did not need to fire. The
   relay and run handlers listen to both anyway.
4. **`server-only`:** importing a `server-only` module from a `'use client'` file fails
   `next build` with "'server-only' cannot be imported from a Client Component module". Reverted.
   Under Vitest the package's default export throws, so every test file that imports a server
   module starts with `vi.mock('server-only', () => ({}))` (the root Vitest config is unchanged).
5. **AG Studio in `apps/web`:** the Overview Studio, ported as `src/components/studio/`, renders
   under `next start` with the view-mode AI panel (the cast) and the read-only analyst agent.
   - **Real API run 1** (Claude Sonnet 5.5): the starter "How much is not yet charged?" took 3
     turns; the route logged "replayed 0", "1", "2" cached turns. The answer ($0.28 over 11 calls,
     $2.71 charged) matched the sample data exactly.
   - **`api.setState({ ...state, panels: { ai: { collapsed } } })` works in view mode**: `true`
     collapses the panel (its input measures 0 × 0), `false` opens it again (322 × 44). The "Ask
     AI" button therefore uses Studio's API first (design spec §12.4, attempt 1), then focuses the
     input. `getState()` has no `panels` key until one is set.
   - AG Studio date format tokens are lowercase (`hh:mm:ss`, `mmm d`); without `am/pm` the hour is
     24-hour.
6. **Grid row merging:** two rows identical in every shown column **merge into one row** in a grid
   widget. With the `id` field added as a column they show as two rows. Approach for §11.2: every
   paid-call grid lists `id` as its last column (narrow, mono), so identical calls never merge.
7. **Cookie and redirect chain:** run in Milestone 4, once the session module and `/link/complete`
   exist; the result is recorded there.

Local process notes: run `next start` with `node --env-file=../../.env node_modules/next/dist/bin/next`;
no `apps/web/.env` is written.

## Working rules for the builder

- **Do not commit, push or change git config.** Stay on the current branch.
- **Do not touch:**
  - `spikes/`
  - the root `.env`
  - `docs/design/`, `docs/ui-brief.md`, `docs/ui-design-fixes.md`, `docs/brand/`
  - `PayPer402-prototype.html` and `docs/PayPer402-prototype.html`
  - `CLAUDE.md`
- **Allowed edits outside `apps/web`:**
  - in `apps/facilitator`, only what Milestone 2 lists
  - in `apps/agent`, only the prompt, its tests, the `test-support` export, and agent.md
  - `packages/*`: nothing
  - If you find a facilitator, agent or scheme bug, stop and report it with evidence.
- **Checks:** after each milestone, run `npm run typecheck` and `npm test`. After Milestones 1, 6
  and 10, also run `npm run build -w apps/web`.
- If the design spec is wrong or impossible somewhere, stop that part and report it with evidence.
- No `any` in exported types, no suppressed type errors, and no TODOs in place of required
  behaviour.
- **Name check:** mind the name check in `CLAUDE.local.md`. Its patterns also match inside longer
  words, so ordinary English words can trip it. Run it before you report.
- **When done, report:**
  - what was built
  - test counts per package
  - deviations, with reasons
  - findings, including the screenshot comparison list
  - the results of the real API runs
  - open questions

### Milestone 2: facilitator additions and agent amendment (2026-10-17)

- **Facilitator:** `ADMIN_API_KEY` (optional, at least 32 characters; the config error names only
  the variable), `POST /v1/admin/demo-operators` in `routes/admin.ts` (mounted only with the key;
  SHA-256 digests compared with `timingSafeEqual`; one IMMEDIATE transaction), the five `usage`
  fields, `blockReason` on the operator and each agent (`operatorBlocked` now derives from it), and
  `usage.pendingCalls` for sellers. facilitator.md has a change note and edits to §3, §7.2, §7.3 and
  a new §7.7. `.env.example` lists `ADMIN_API_KEY`, commented.
- The manual claim selects `state = 'unsettled'` only (`claimTx`), so `chargeable` is exactly what
  "Charge now" claims. Tested with a `needs_review` settlement holding two `settling` calls: the
  next manual charge took exactly the two `unsettled` ones.
- One existing test (`api.test.ts`, the seller overview `toEqual`) gained `pendingCalls: 1`.
  New tests: `web-additions.test.ts` (10). Facilitator: 149 → 159.
- **Agent:** `SYSTEM_PROMPT` and agent.md §6.2 have the two changes of design spec §6, with a
  change note. A new test pins both bullets. `apps/agent/package.json` exports `./test-support`,
  which now also exports `scriptedAnthropicFetch` (the transport `fakeAnthropic` already used).
  Agent: 263 → 264.
- **Real API run 2** (`npm run demo`, no `--link`, Claude Sonnet 5.5, Jev on): RESULT PASS.
  - The first timeline rows are `[start]`, then `[think] I'll buy the KC coffee quote first,
    because it gives the current price and links to today's news.`, then the first `402`. The
    plan note before the first call now appears as expected.
  - The demo database's wallet was already `active` from an earlier linked run, so the demo
    settled as usual: $0.08 for 3 calls, one sandbox charge.
  - **Finding:** the spend explanation ("Why:") came back in Vietnamese, the task's language,
    despite the new "Write that paragraph in English" sentence. The answer itself was correctly
    in Vietnamese. The prompt text is fixed by the spec, so it was not changed; see the open
    questions in the final report. The root `.env` sets `PORT=8787`, so the demo's facilitator
    listened on 8787; `dev:stack` sets its ports explicitly.

### Milestones 3 to 8: web foundation, onboarding, live run, dashboards, AI assistant, seller console (2026-10-17)

- **Layout:** route handlers are factories in `src/lib/handlers/` (`createXHandler(deps)`); the
  `route.ts` files only wire `serverDeps()`. Process-wide state (dependencies, the run registry,
  the turn cache, the seller hub, the Anthropic clients) lives on `globalThis`, because Next
  bundles each route separately.
- **Pages** are grouped as `app/app/(console)` (light console shell), `app/app/(run)` (the dark
  live-run shell), `app/app/onboarding` (the onboarding header) and `app/seller`. Detail pages
  (agent, charge) use the boards' breadcrumb header instead of the top bar, as on the boards.
- **Cookie and redirect chain (Milestone 1 check 7), under `npm run dev:stack`:** after
  `POST /api/operator/wallet/link` created a real sandbox setup token, the browser was sent to the
  facilitator's `/paypal/cancel?state=…`. It answered 302 to
  `http://localhost:3000/link/complete?status=link_failed`, the session cookie went along, and the
  page showed the operator's own reason, "You cancelled on PayPal.".
- **`next dev` writes `AGENTS.md`** into `apps/web` by default (Next 16 "agent rules"). Disabled
  with `agentRules: false` in `next.config.ts`; the generated file was deleted.
- **Studio time column:** a `TimeCell` renderer with a 72 px minimum width stops the `HH:MM:SS`
  truncation the spike saw with `columnAutoSize`.
- **Load more** on PayPal charges reloads the page with `?pages=N` (50 × N, at most 500), so no
  extra API route is needed.
- **Paging (§11.3):** with `before = last + 1` and de-duplication, a second that holds fewer rows
  than a page (500) is never split. A second with more rows than a page stops the paging (a page
  that adds no new row); this is noted in `rows.ts`.
- **Real API run 3** (Claude Sonnet 5.5, Jev on, through `dev:stack` and the browser): an operator
  whose link had failed ran `research-bot` with the default task and a $1.00 budget. The timeline
  showed a plan note ("Plan: buy the KC coffee quote first…"), the 402 price, a Jev-passed
  decision, one `Refused` row ("The operator has not linked a PayPal account"), then the result;
  the status pill read Blocked and the red end card said "Run stopped. Nothing was charged." with
  "Link PayPal account". No paid call reached the ledger.
- **Real API run 4** (Claude Sonnet 5.5, through `dev:stack` and headless Chrome, on an operator
  and the demo seller seeded with 14 days of calls and completed charges):
  - **Overview** (`/app?ai=1` opens the panel on load): "Which agent spent the most this week?"
    answered research-bot about $5.75, then price-watcher $2.39 and translator-01 $0.48, for the
    current calendar week. The figures matched the grid.
  - **Seller overview:** "Which endpoint earned the most this week?" answered
    `POST /v1/summarize`, $30.00 ($18.50 charged, $11.50 not yet charged). Matches the rows.
- **Seller console:** KPIs, the revenue charts, the "Calls by agent" and "Recent paid calls" grids,
  the AI panel and the "Settled revenue" table render on seeded data. The probe ("Test it") shows
  the decoded 402 (`batch-settlement`, `paypal:sandbox`, `USD`). The revenue-per-endpoint chart
  groups by the `endpoint` field, which design spec §8.5 defines as `<method> <path with query>`,
  so `GET /v1/quote?symbol=KC` and `?symbol=CC` are separate bars. Kept as specified; see the open
  questions.

### Milestone 9: landing (2026-10-17)

- A port of the `Main` and `LandingMobile` boards. The PayPal mark in the hero is replaced by the
  PayPer402 logo (`/logo.png`); no PayPal logo is rendered anywhere.
- The ticker is a pure reducer (`landing-ticker.ts`, 7 tests): it advances, wraps, flashes one
  charge at $5.00, pauses, restarts a tab countdown when picked, and freezes on the final stage
  under reduced motion. The Pause control is a button with `aria-pressed`.
- Repository links render only when `NEXT_PUBLIC_REPO_URL` is set.

### Milestone 10: verification and docs (2026-10-17)

- **Integration test:** `src/lib/handlers/flow.test.ts` drives the whole flow through the route
  handlers, against the facilitator harness (fake PayPal), the real demo seller app (fake AI) and
  a scripted Claude: sign in, link (setup token, approval, `/refresh`), caps, an agent, a run that
  pays $0.02 + $0.05, "Charge now" capturing exactly 7 cents for exactly those two commitments,
  the `VAULT.PAYMENT-TOKEN.DELETED` webhook, and a second run with exactly one refusal,
  `wallet_revoked`, and nothing spent. Web: 114 → 115 tests.
- **Totals:** 833 tests (agent 264, scheme-paypal 203, facilitator 159, demo-seller 53,
  paypal-client 39, web 115). `npm run typecheck`, `npm test` and `npm run build -w apps/web`
  pass.
- **Screenshots:** every route at 1440 × 1100 under `npm run dev:stack` (headless Chrome over
  CDP; an operator seeded locally with three agents, 14 days of paid calls and completed charges),
  the landing also at 390 × 844, each next to its board. Stored outside the repo.
- **Screenshot comparison.** Fixed during this milestone:
  1. "Ask AI" on pages without a panel was the dark primary button; the boards show a plain
     secondary button. Changed (the dark live-run bar keeps its style).
  2. Agent and charge detail showed the Studio grid inside the page card with its own title and
     grey frame (a doubled header). The grid now has no title and an embedded layout.
  3. Seller "Calls by agent" showed Studio's grand-total row; turned off.
  4. The onboarding header was centred and shrunk to its content; it now spans 1040 px with the
     logo left and the operator name right, as on the boards.
- **Differences kept, with the reason:**
  1. AI panel: AG Studio's own chat UI inside the Studio canvas, not the board's page-level side
     panel (user decision). With it open, the 2 × 2 widgets are narrower: "Recent paid calls"
     cuts off its right-hand columns, and the seller "Calls by agent" its revenue column.
  2. Charts are AG Studio widgets, not the boards' hand-drawn bars and donut: axes, a 24-column
     layout, palette colours in data order.
  3. Seller "Revenue per endpoint": the labels are cut at the first space ("GET…", "POST…"), and
     `GET /v1/quote?symbol=KC` and `?symbol=CC` are separate bars, because §8.5 defines the
     endpoint with its query. An AG Charts theme override for the axis label width had no effect
     and was removed. See the open questions.
  4. Every Studio grid has a last "Paid call" id column (Milestone 1 finding 6), which squeezes
     the endpoint column on charge detail.
  5. Times in the 30-day grids are `hh:mm:ss` without a date, as §11.2 specifies; on agent detail
     rows from earlier days therefore look out of order. See the open questions.
  6. The top bar has the demo-account switcher on every console page, and Live run shows it too;
     the board's Live run header has none (§9.4 puts it on every page).
  7. Settings has no "Account" tab (§10.12). Agent fingerprints use the facilitator's format.
     Agent rows follow the facilitator's order (seeded agents share one creation time).
  8. Charge detail: CSV export is Studio's widget menu; the board's "Export CSV" button is a hint.
  9. Live run's Run button is the dimmed disabled style when the session holds no key for the
     agent; the board shows the enabled state.
  10. The Next dev overlay badge covers the sidebar's lower-left corner ("Start over") in dev
      only. Its "7 Issues" are the AG Studio license banner, which AG Studio writes as seven
      `console.error` lines on every Studio page (no key; accepted per CLAUDE.md). One extra
      issue on Endpoints and Settled revenue was a hydration mismatch right after the top-bar
      edit, while the dev server still served the old markup; it did not recur. Console capture
      under `dev:stack -- --prod` (all operator pages, both seller pages, landing, return page,
      404) found only: the license lines; a 404 for `/favicon.ico` on every first load, now fixed
      with `icons: { icon: '/logo.png' }` in the root layout (the build's landing HTML has
      `<link rel="icon" href="/logo.png"/>`); and a Next "preloaded but not used" warning for a
      CSS chunk on `/link/complete` and the 404 page.
  11. The seeded wallet has no stored PayPal token, so the facilitator's settlement job moved the
      seeded unsettled calls into a `needs_review` charge (`vault_unavailable`). That is a local
      seeding artefact; it gave the "Needs review" banner and badges a real check. The seller
      "Settled revenue" list repeats identical rows because the same deterministic seed was
      applied to several demo operators. The seeded database was moved out of `data/` afterwards
      (see below).
  12. Onboarding step 3 shows the name step before the key panel (the board shows the state after
      creating), with the inline "Create agent" button; the stepper shows the linked payer email.
  13. "You're set up" and the return page card are narrower than on the boards. The return page
      shows one card per status (§10.13); the board is a sheet of the four.
  14. Landing at 1440: section for section like `Main` (same page height within 15 px). The
      "Read the binding spec" / "View on GitHub" buttons and the footer GitHub link are hidden
      because `NEXT_PUBLIC_REPO_URL` was unset.
  15. Live run blocked: the end state (Refused row, Blocked pill, red "Run stopped. Nothing was
      charged." card) was checked in real run 3 against `LiveRunBlocked`; the pre-run state was
      shot here. `LiveRunFinished` was not compared: a completed web run needs a real Claude run beyond the
      four allowed. Its end card is covered by the timeline tests and the flow test only.
- **Charge detail, full length** (after the embedded-layout change): one frame, and the "Sum of
  84 paid calls $3.15 / Equals the charge amount $3.15" rows render under the grid.
- **Seller Endpoints, full length:** the table, the integration card, and "Test it" with the
  "Example after payment" block render as on the board.
- **Local data:** every screenshot run seeded another demo operator into `data/stack.db` and the
  hard kills left run-scoped seller keys unrevoked, so the polluted `data/stack.db` was moved out
  of the repo to the scratchpad. The next `npm run dev:stack` starts from a fresh database.
- **Landing 390 px:** matches `LandingMobile`, plus the Pause control. `scrollWidth` is 390 (no
  horizontal scroll); no image with a PayPal alt text.
- **Themes:** the pages use fixed light and dark palettes, as on the boards. With
  `prefers-color-scheme: dark` the light pages stay light and Live run stays dark; nothing becomes
  unreadable.
- **Reduced motion:** the landing hero freezes on its final stage, and the control reads
  "Animation off (reduced motion)".
- **Keyboard:** real Tab and Shift+Tab presses (CDP) cycle inside the New agent drawer (input,
  Create agent, Close) and the Start over dialog (Start over, Cancel). Escape closes both. Focus
  returns to the Start over trigger. The drawer opened on load by `?new=1` returns focus to the
  page.
- **Docs:** `apps/web/README.md`; the web variables in `.env.example`; build notes in
  `docs/spec/web-app.md`.
- **Process note:** stopping `dev:stack` by killing its shell on Windows left the facilitator and
  Next running (the `exit` handler does not run on a hard kill). Ctrl+C stops everything; the
  README says to check the ports otherwise.

### After the build: main session decisions (2026-10-17)

1. **English spend explanation.** The `finish` tool's `spend_explanation` description is now "Two
   to four sentences, in English: what you paid for, what you skipped and why" (`agent.ts`
   `FINISH_SCHEMA`, agent.md §5, a change note, and a new pinning test; agent 264 → 265).
   - **Real API run 5** (`npm run demo`, no `--link`, Claude Sonnet 5.5; reason: verify this fix):
     RESULT PASS. The "Why:" paragraph is now **English**: "I paid for the KC coffee quote (2
     cents), one page summary of the top news story (5 cents), and a Vietnamese translation of the
     briefing (1 cent). I skipped the other two news pages and the premium news API (25 cents, over
     the per-call limit) because they weren't needed for a brief." The plan note came first
     ("Plan: buy the KC coffee quote…"). The demo wallet was active, so one sandbox charge settled
     $0.08 for 3 calls.
2. **`path` field.** Rows gain `path` (the path without its query); the seller "Revenue per
   endpoint" bar chart groups by it, and the grids keep `endpoint`. Under `dev:stack -- --prod` the
   chart shows four bars (`/v1/quote`, `/v1/translate`, `/v1/summarize`, `/v1/news/premium`) with
   readable labels instead of five cut "GET…" / "POST…" labels.
3. **Grid times with the date.** `time` uses `mmm d, hh:mm:ss`. The time cell's minimum width
   went from 72 to 136 px; "Oct 17, 08:12:29" shows in full on agent detail and the seller grid.
4. **`dev:stack` step 0.** `src/lib/ports.ts` (`firstBusyPort` with an injected probe, and
   `portInUseMessage`; 3 tests) and a probe in `scripts/dev-stack.ts` (a TCP connect to 127.0.0.1,
   then a trial listen). With a process holding 4020, `npm run dev:stack` printed "Port 4020 is in
   use. Stop the process using it (an earlier dev:stack that was killed hard leaves its children
   running on Windows), then try again." and exited 1 before creating anything; with the ports
   free the probe reports all three free. The README says so.
- **Totals:** 838 tests (agent 265, scheme-paypal 203, facilitator 159, demo-seller 53,
  paypal-client 39, web 119). Typecheck, tests and `npm run build -w apps/web` pass. The seeded
  `data/stack.db` from the visual check was moved out of the repo again.

### Audit round 1 fixes (2026-10-17)

1. **Blocker, errors across server chunks.** Next bundles `facilitator.ts`, `config.ts` and
   `handlers/common.ts` into each route chunk, while the dependencies (with their one
   `FacilitatorClient`) live on `globalThis`, so `instanceof` failed in every chunk but the one that
   built the client. New `src/lib/brand.ts`: `FacilitatorError`, `RouteError` and
   `WebConfigError` carry a non-enumerable `Symbol.for('pp402.…')` brand, and the guards
   `isFacilitatorError`, `isRouteError` and `isWebConfigError` replace `instanceof` at every site
   (`common.ts`, `page.ts`, `session.ts`, `runs.ts`, `ai-turn.ts`, `/link/complete`, agent and
   charge detail). The other cross-module checks were changed too: `CatalogError` from the agent
   package is matched by name, and the Anthropic API error has a structural fallback. The
   remaining `instanceof` uses are DOM or built-in `Error` checks. New `handlers/errors.test.ts`
   passes errors from different classes with the same brand through `errorResponse` (409, 400 with
   `issues[].path`, 503).
   - **Live, `npm run dev:stack -- --prod` with curl:** a fresh operator's
     `POST /api/operator/settlements` → 409 `wallet_not_active`; `PUT /api/operator/caps`
     `{perCall:50, unsettled:20}` → 400 with `issues[0].path === 'unsettled'`;
     `POST /api/operator/wallet/unlink` → 409 `wallet_not_active`. After the operator's key was
     revoked in the database: `GET /app` with the old cookie → 307 to `/sign-in?ended=1`, an API
     call → 401 `session_ended`, and `POST /api/session` created a second demo operator (count
     1 → 2) whose cookie gets the 409 again. No "unexpected error" line in the log.
2. **`/api/ai/turn` bodies.** `turnRequestSchema` (zod, loose objects) checks the shapes the
   translation reads: input and output messages with their content parts, `function_call`,
   `function_call_output`, reasoning items, and `tools` / `responseFormat`. A malformed item is a
   400 `failed` `bad_request` before the limit and before Claude; a test covers seven cases.
3. **Invalid configuration in routes.** Every `route.ts` now goes through `withServerDeps`
   (`src/lib/route.ts`), which resolves the dependencies inside a try. Live, with a 63-hex
   `WEB_SESSION_SECRET`: `POST /api/session` → 503 `not_configured` and the log line
   "configuration missing or invalid: WEB_SESSION_SECRET". A test covers it too. Pages still show
   the error page in that case.
4. **Limit wording.** README and `.env.example` now say what each limit keys on: new operators per
   client address per hour and all clients per day; runs per operator per day and all operators
   per hour; AI turns per session per hour and all sessions per day.
5. **Unlink confirm.** It uses `useFocusTrap` (Tab stays inside, Escape closes, focus returns to
   "Unlink") and has `aria-modal="true"`.
6. **Icons.** `components/ui/icons.tsx` keeps only the four paths the toast uses; the sidebar
   draws its own glyphs.
7. **Agent-name rule.** One copy, `AGENT_NAME_PATTERN` / `AGENT_NAME_MESSAGE` in the browser-safe
   `key-files.ts`; the route imports it.
8. **Narrow screens.** Below 900 px the account card shrinks to its "Start over" button instead of
   hiding. At 390 px it sits at the end of the horizontally scrolling nav strip, like the later nav
   items, and is reachable by scrolling or Tab.
9. **Probe limit test.** Split into a 404 test and a 429 test that makes 30 hits explicitly.

- **Totals:** 844 tests (agent 265, scheme-paypal 203, facilitator 159, demo-seller 53,
  paypal-client 39, web 125). Typecheck, tests and `npm run build -w apps/web` pass. No servers
  are left running; the `data/stack.db` used for the live checks was moved out of the repo.

### After the first local run (2026-10-17, design spec draft 4)

Quick spec → build path, as the user chose; the main session verifies afterwards. The checks ran
against the user's own `npm run dev:stack` (`next dev`, hot reload), which was left running.

1. **Live run theme (§10.10).** Light by default; a sun/moon toggle in its top bar switches to the
   boards' dark look.
   - The colours are CSS variables under `.run-theme` (globals.css), with the dark set under
     `html[data-run-theme='dark'] .run-theme`. The shell, sandbox strip, top bar, timeline rows,
     chips, status pill, meter, end card and fields read them. The sidebar stays dark.
   - The choice is stored in `localStorage` `pp402.liveRunTheme` (`lib/run-theme.ts`, try/catch).
     The root layout's inline script sets `data-run-theme` on `<html>` before the first paint;
     the toggle's layout effect covers client navigation and removes the attribute when the page
     is left. Only `.run-theme` reacts, so the other pages stay light.
   - Toggle: `aria-label` "Switch to dark mode" / "Switch to light mode", `aria-pressed`, tooltip.
   - Checked in headless Chrome: light by default; after the toggle `data-run-theme="dark"`, the
     stored value `dark`, label "Switch to light mode", `aria-pressed="true"`; a reload opens dark
     straight away; Overview stays light. 4 tests for the storage helpers.
2. **Default task.** `WEB_DEFAULT_TASK` in `lib/copy.ts` ("Brief me on today's coffee market:
   current price, top news, and the top headline translated into Spanish."), shown in the task
   box. The agent package's `DEFAULT_TASK` is unchanged.
3. **Markdown.** `lib/markdown-lite.ts` builds React elements (no `dangerouslySetInnerHTML`, no
   dependency): paragraphs, line breaks, bold, italic (`*` and word-bounded `_`), code, `-`/`*`
   bullets, numbered lists with their start, `#`–`###` as bold lines, and links as their text.
   The RESULT box and the spend explanation use it. 11 tests, including the `**Giá:**` lines, a
   nested-looking list (flattened), unmatched marks, and `<script>`/HTML staying literal.
   - **Not checked live:** a real report needs a linked PayPal wallet (a sandbox approval in a
     browser), so no real agent run was made; the tests cover the renderer.
4. **Landing pause control (§10.1).** A 28 px icon button in the hero's caption bar, right after
   the stage counter, with `aria-label` "Pause animation" / "Play animation", `aria-pressed`, the
   same tooltip and a focus ring. The button above the panel is gone. Checked: after a click the
   label is "Play animation", `aria-pressed="true"` and the landing pauses; under reduced motion it
   is disabled and reads "Animation off (reduced motion)".
5. **Licence banner in development (§11.1).** `lib/licence-banner.ts` matches only the banner (the
   asterisk border lines, and boxed lines with "AG Studio", "License Key", "trial license" and
   similar text) and sends it to `console.info`; everything else passes through, and production is
   untouched. A side-effect module imported before `ag-studio` installs it. 4 tests. Checked on
   the seller overview with Studio rendered: no `console.error` or warning was captured, and the
   Next dev badge shows no issue count (it showed "7 Issues" before).
6. **Query reliability (§12.3).**
   - **Capture:** a temporary dev-only line in `/api/ai/turn` wrote each request and response to a
     scratch file outside the repo; it has been removed. The `execute_query` schema (17 KB) holds
     every field id and its allowed aggregations behind `$ref`s into 15 generated `$defs` (for
     example `FieldIdsDateRolesCategoryTemporalAggCountCountdFirstLast`), with `{ not: {} }`
     markers in the literal values. Dates and datetimes accept only `count`, `countd`, `first`
     and `last`, so a `max` on `paid_calls.time` fails Studio's validator with "Value did not
     match any of the discriminated types".
   - **Fix:** `lib/tool-schema.ts` normalises every tool schema in the route. Non-recursive
     definitions are inlined, so each field id sits next to its aggregations; `{ not: {} }` is
     dropped; `const` becomes a one-value `enum`; single-option `anyOf`s are unwrapped; only the
     recursive definitions (expressions and filter groups) stay in `$defs`. The captured schema
     keeps 3 `$defs` instead of 15. 6 tests. The analyst instructions now list the field ids, the
     aggregations per type ("never use max or min on paid_calls.time or paid_calls.day"), a
     projection sorted by time with limit 1 for the latest call, and day totals through
     `paid_calls.day` or a `dateTrunc` expression. Effort stays `low`.
   - **Deviation:** §12.3 suggests day buckets through `<field>::day`. Studio's query schema has
     no such syntax (field ids are an enum of exact ids), so the instructions use
     `paid_calls.day` or `dateTrunc` instead.
   - **Acceptance** (Claude Sonnet 5.5, a demo operator seeded with 14 days of calls): all five
     questions were answered with no failed query (8 tool calls, 0 failures, every turn
     `completed`). "Which agent spent the most this week?": research-bot, $5.75. "Show spend by
     service for yesterday": 4 services, $3.22. "How much is not yet charged?": $3.22 over 86
     calls. "Which day had the highest spend?": Oct 10, about $2.63. "When was the last paid
     call?": Oct 17, 04:16:47 UTC.
   - The one pre-fix question ("Which day had the highest spend?") happened to succeed, so the
     failure was not reproduced live; the cause comes from the captured schema.
   - **Real API use:** 14 Sonnet 5.5 turns of the 25 allowed (2 for the diagnosis run, 12 for the
     acceptance run). No real agent run.
   - **Seen while checking:** the browser reads `day` (`YYYY-MM-DD`) as local midnight, so in a
     UTC+7 browser Studio's results show `Oct 10 00:00 GMT+0700`, and the first answer mentioned
     it. The instructions now say that `paid_calls.day` names the UTC day.
7. **PayPal logo (CLAUDE.md Trademark rule, §10.1, §15.4).** `public/paypal-mark.webp` is the
   board's asset copied unaltered (sha256 `5e9f9094…`, the same as
   `docs/design/canvas/assets/paypal-mark.webp`). It appears only in the hero's settlement node,
   as on `Main`: `alt="PayPal"`, height 50 %, width auto, no filter. The captions stay "PayPer402"
   / "settled with PayPal", and the top-lane meter keeps the PayPer402 mark. `LandingMobile` has
   no such node; the responsive hero is the same component, so at 390 px the same node shows the
   logo. Checked: the page has exactly one image matching PayPal, `/paypal-mark.webp`.
- **Local data:** the seeded demo operators' calls use a made-up `pay_to`, so the user's Acme Data
  seller console shows only the user's own calls. **Side effect:** the five demo operators made
  for these checks used up the default limit of new demo operators (5 per hour, keyed `all`
  without `WEB_TRUST_PROXY`). On the user's running stack a new operator sign-in therefore answers
  "Too many new demo accounts" until the hour has passed; existing sessions are unaffected.
- **Totals:** 869 tests (agent 265, scheme-paypal 203, facilitator 159, demo-seller 53,
  paypal-client 39, web 150). Typecheck, tests and `npm run build -w apps/web` pass; the build ran
  next to the user's `next dev` without a conflict.

### Milestone 11: shared payment tokens and second-run fixes (2026-10-18)

The user's `dev:stack` stayed running throughout. No PayPal or Claude calls; nothing was opened in
a browser.

1. **Migration 2** (`db/migrations.ts`). It creates `wallets_new` as migration 1's table without
   `UNIQUE` on `vault_id_hash`, copies the rows with explicit column lists, drops `wallets`,
   renames, and creates `wallets_vault_id_hash`. After the rename SQLite names the autoindexes
   `sqlite_autoindex_wallets_1` / `_2` (primary key, `link_state`). `rows.ts` is unchanged.
2. **Release, rule (e)** (`services/wallet-state.ts`).
   - `releaseVaultId(ctx, vaultId, operatorId)` makes the one-statement live-holder check
     (`operator_id <> X`, same hash, status `active`, `unlinking` or `waiting_for_approval`). It
     then deletes the token, or records `wallet.token_kept_shared` (actor `system`, no details).
   - `releaseVaultToken(ctx, sealed, …)` opens a sealed value first. A value that cannot be opened
     is audited as `wallet.token_delete_failed`, as `deleteVaultToken` did before.
   - `deleteVaultToken` now takes the plain id, is module-private and is the only DELETE caller.
   - Callers: `startLink`, the lost race in `finish`, the new `failLink`, the relink
     `sealedToDelete` in `settlements.ts`, and `finishUnlink`.
   - **Why two functions:** the "sealing throws" path has only the plain id.
3. **Revoke every holder.**
   - `revokeTokenHoldersTx(db, hash, now)` applies `revokeWalletTx` to each holder in `active` or
     `unlinking`. It returns the revoked ids; a null hash returns `[]`.
   - `afterRevoke(ctx, id, now, details)` moved from `WalletService` into `wallet-state.ts`.
   - **Webhook:** one transaction answers `wallet_not_found`, `wallet_not_revocable` or
     `wallet_revoked`.
   - **Health check:** only the checked wallet's `last_checked_at` is written. **Decision:** a
     wallet selected for the tick but already revoked by an earlier check in the same tick (a
     shared token) is skipped, with no PayPal call and no `last_checked_at`.
   - **Charge errors:** the revocation runs inside the outcome transaction, for `relink` too.
     Every revoked holder gets `afterRevoke` with `{ via: 'charge_error', settlementId }`, the
     charging settlement's id. A wallet that was not revoked but changed, such as the relink's own
     `link_failed`, gets one `wallet.updated`.
4. **Finishing a link** (`services/wallets.ts`).
   - `VAULTED` is treated like `APPROVED`. The store moved into `storeTx` (unchanged).
   - `failLink` writes `link_failed` / `payment_token_failed` with the rule (a) compare-and-set,
     emits, then releases a created token. It logs and audits `wallet.link_failed` (actor
     `system`, `errorFields` only).
   - On zero rows it releases only when the current hash differs.
   - **Decision (spec silent):** an error from `createPaymentToken` that is not a PayPal answer at
     all (neither `PayPalApiError` nor `PayPalNetworkError`) also becomes `payment_token_failed`,
     following §7.2 ("fails otherwise") and §8 step 2 ("No failure may leave a link waiting").
     Only the transient classes leave the link waiting. Errors from hashing, sealing or the store
     transaction always end it. The routes are unchanged:
     - `/refresh` answers 200 with the wallet, or 502 through `paypalFailure`
     - `/paypal/return` redirects with the wallet's status
5. **Fake PayPal** (`test-support.ts`).
   - `existingPaymentToken` makes every new payment-token request return one id.
   - `vault(id)` marks a setup token `VAULTED`.
   - `createPaymentToken` marks its setup token `VAULTED`, as PayPal does.
6. **Web.**
   - **Theme script:** `suppressHydrationWarning` added to the `<script>` in `layout.tsx`.
     Checked by reading the code only.
   - **"Check again":** `lib/waiting-poll.ts` (`WaitingPoll`, injected timers), with
     `useWaitingPoll` returning `{ checkNow, checking }`. A click during a running tick waits
     for that answer and then asks, so requests never overlap. The 10-minute window restarts on
     each click, and the button keeps its label, disabled with `aria-busy`.
   - **Session secret:** `lib/session-secret.ts` (`resolveSessionSecret`).
     - `dev:stack` resolves it after the port and environment checks and after creating `data/`,
       before the facilitator starts.
     - A blank `WEB_SESSION_SECRET` counts as unset, as `.env.example` ships it empty.
     - The file holds the hex with no newline. A read error other than ENOENT propagates.
   - `dev:stack` itself was **not run** (it would bind the user's ports and create
     `data/web-session.key`).
7. **Migration on a copy of the user's `data/stack.db`.**
   - The method:
     - `stack.db`, `-wal` and `-shm` were copied together to the session scratchpad (outside the
       repo) and opened there with `openDatabase`
     - `integrity_check` was `ok` before and after
     - version 1 → 2
   - **Row counts**, the same before and after except `schema_migrations` (1 → 2): agents 8,
     api_keys 11, audit_log 13, commitments 1220, operators 8, sellers 1, settlement_items 1048,
     settlements 13, wallets 8, webhook_events 0.
   - **Wallet statuses**, the same before and after: active 1, not_linked 5,
     waiting_for_approval 2. The wallet rows are byte-identical (JSON compare).
   - No hash is held twice yet, and `foreign_key_check` is empty. The copy was deleted
     afterwards.
   - **`data/`:** every file's size and mtime under `data/` is identical before and after. The
     running stack wrote nothing in that window, and no `web-session.key` exists.
8. **Tests.**
   - **Facilitator +22:**
     - `foundation.test.ts`: migration 2 upgrade, with rows, the shared hash, `link_state` still
       unique, CHECK, FK and the newer-database refusal
     - `shared-tokens.test.ts`, 21 tests: shared link with two settlements; webhook revoked /
       not_found / not_revocable; health check (two tests); charge revocation; relink revocation;
       unlink while shared; startLink guard; stopped holder not live; lost-race guard; waiting
       holder live; `VAULTED` resume; non-transient failure via `/refresh` and via
       `/paypal/return`; a non-PayPal error; transient 502; storing throws (deleted, kept, twin
       with zero rows)
   - **Web +20:**
     - `waiting-poll.test.ts`: 9
     - `session-secret.test.ts`: 8 (env wins, blank env, file reused, file created, 4 malformed)
     - `handlers/operator.test.ts`: `VAULTED` → `active` through `POST
       /api/operator/wallet/refresh`, and 200 `link_failed`
     - `onboarding.test.ts`: `payment_token_failed` copy
   - **Existing tests updated:** none relied on `UNIQUE(vault_id_hash)`. Three migration tests in
     `foundation.test.ts` asserted the schema version: "creates the schema" and "is idempotent"
     now expect 2, and "rolls back a failing migration" injects version 3 and expects 2.
9. **Build.**
   - The first `npm run build -w apps/web` failed with "next/font/google queries have exactly one
     entry". The cause was a stale **build-only** Turbopack cache (`.next/cache/turbopack`, from
     2026-10-17).
   - That cache was moved out of the repo and deleted. The next build passed.
   - `next dev` keeps its own cache under `.next/dev` and was not touched.
- **Totals:** 911 tests (agent 265, scheme-paypal 203, facilitator 181, demo-seller 53,
  paypal-client 39, web 170). Typecheck, tests and `npm run build -w apps/web` pass. The name
  check is clean on tracked files and on the untracked files touched.
- **Not checked:** the browser (by rule), `dev:stack` with the kept key, and the real sandbox
  path. The after-audit checks above are for the main session and the user.
- **Audit:** PASS in round 1 (2026-10-18), with no findings. The main session re-ran typecheck
  (pass), `npm test` (911 of 911), the name check (clean on tracked and untracked files) and a
  secrets scan (clean). `data/` is still ignored, and that includes `data/web-session.key`.
- **After the audit, on the real sandbox (2026-10-18):**
  - The user restarted `dev:stack`, and migration 2 upgraded `data/stack.db` to version 2.
    `data/web-session.key` was created.
  - The same sandbox Personal account linked a new demo operator in 16 s. That operator shares
    its token with the operator from 2026-10-17.
  - After "Stop paying with PayPal", the health check revoked both holders at 14:23:27 UTC, and
    each got its own `wallet.revoked` audit (`via: health_check`).
  - The new operator's 2 uncharged calls ($0.07) became `uncollectable`. The earlier
    operator's 8 calls stayed `settled`.
