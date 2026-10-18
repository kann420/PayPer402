# PayPer402 web app: design spec

> Status: draft 5 (2026-10-18), for roadmap Phase 4, revised after the second local run.
> Normative keywords follow RFC 2119.

Phase 4 gives judges a complete product in a browser. They can:

- link a sandbox PayPal account
- set limits
- create an agent key
- watch an AI agent pay per call
- see the spend and the one PayPal charge
- stop the agreement in PayPal and see the agent blocked

Sellers get a console with their revenue, their endpoints and a live `402`.

This document defines the behaviour of `apps/web` and the small additions it needs in the
facilitator and the agent. Implementation details (files, milestones, tests) are in
[docs/phase-4/BUILD_SPEC.md](../phase-4/BUILD_SPEC.md).

**Inputs:**

- the facilitator ([facilitator.md](facilitator.md))
- the demo seller and the agent ([agent.md](agent.md))
- the decision layer ([decision-layer.md](decision-layer.md))
- the frozen UI design ([docs/design/README.md](../design/README.md))
- the content fixes ([docs/ui-design-fixes.md](../ui-design-fixes.md))
- the AG Studio spike ([spikes/ag-studio/README.md](../../spikes/ag-studio/README.md))

When they disagree, the precedence in the design README applies: CLAUDE.md, then this spec, then
the fixes, then the boards, then the brief.

## 1. Scope

In scope:

- **`apps/web`**: a Next.js 16 app with these parts:
  - the landing page, and the sign-in demo picker
  - operator onboarding, overview, agents, charges, live run and settings
  - the seller overview, endpoints and settled revenue
  - the PayPal link return page
  - the AG Studio dashboards and the AI assistant
- **Server routes in `apps/web`** that hold every key and talk to the facilitator, the demo seller,
  Anthropic and TypeSafe. The browser holds no API key, ever.
- **Facilitator additions (§5):**
  - an admin route that creates a demo operator
  - unsettled and not-collected counts and sums
  - a block reason
  - a pending-calls count for sellers
- **One agent amendment (§6):** the system prompt asks for a plan note before the first call, and
  an English spend explanation.
- **A one-command local stack** (`npm run dev:stack`) that runs the facilitator, the demo seller
  and the web app together.

Out of scope:

- hosting, the PayPal webhook registration and the uptime check (Phase 5)
- the demo video and the Devpost text (Phase 6)
- a real user sign-up, and several sellers
- editing endpoint prices, per-agent budgets and key rotation (removed by the fixes)
- dark mode outside the two dark boards (landing and live run)
- a page listing every paid call
- the "Account" settings tab (undesigned)

## 2. Architecture

```
 browser ──HTTPS──► apps/web (Next.js, Node runtime)
   │ pages (server components) ─┬─► facilitator /v1/*    operator key (per visitor), seller key (shared)
   │ /api/* route handlers ─────┼─► facilitator /v1/admin/demo-operators   admin key
   │ SSE /api/events ◄──────────┼─◄ facilitator /v1/events  (relayed)
   │ SSE /api/runs ◄── agent run in process (@payper402/agent) ─► demo seller (x402) ─► facilitator /x402
   │ /api/ai/turn ──────────────┼─► Anthropic Messages API
   │                             └─► demo seller /v1/catalog, unpaid probe ("Test it")
 PayPal ◄── approval page ──► facilitator /paypal/return ──302──► apps/web /link/complete
```

- **Processes:** three, as in Phase 3:
  - the facilitator (default port 4020)
  - the demo seller (4021)
  - the web app (3000)
  
  The web app reaches the other two over HTTP; their URLs come from configuration (§3).
- **Keys:** the facilitator sends no CORS headers (facilitator.md §13). Every facilitator call
  therefore comes from the web server, with the key taken from the visitor's session (§4) or from
  the web app's environment.
- **Rendering:**
  - Pages are server components that fetch their data on the server.
  - Interactive parts are client components.
  - AG Studio is a client component, loaded only on the routes that use it (§11).
- **Money:** integer cents everywhere in code. Display goes through one formatter (§8.2).
- **Time:**
  - The facilitator uses unix seconds; agent events use milliseconds.
  - Every time and day shown in the app is **UTC**, because the daily cap resets at midnight UTC.
  - The shell footer says "Times in UTC".

## 3. Configuration

### 3.1 Web app

Environment variables are validated with zod when first used. A missing required variable makes
the affected route answer 503 with a clear log line, and never prints a value.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WEB_PUBLIC_URL` | no | `http://localhost:3000` | The web app's own origin. Used for the same-origin check (§15). |
| `FACILITATOR_URL` | no | `http://localhost:4020` | Facilitator base URL |
| `FACILITATOR_ADMIN_KEY` | for the operator demo | — | Admin key for `/v1/admin/demo-operators` (§5.1). It equals the facilitator's `ADMIN_API_KEY`. |
| `WEB_SELLER_API_KEY` | for the seller demo | — | The demo seller's facilitator key (`pp402_sel_…`) |
| `SELLER_URL` | no | `http://localhost:4021` | The demo seller, for the catalog, runs and "Test it" |
| `WEB_SESSION_SECRET` | yes | — | 64 hex chars (32 bytes), the AES-256-GCM key for the session cookie |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | Model for agent runs and the AI assistant (CLAUDE.md). Credentials are resolved by the SDK. |
| `TYPESAFE_API_KEY` | no | — | Turns the decision layer on for runs (decision-layer.md §8) |
| `WEB_DECISION_LAYER` | no | `on` | `off` turns the decision layer off even with a key |
| `AG_STUDIO_LICENSE_KEY` | no | — | Passed to `AgStudioProvider`. The app works without it (CLAUDE.md). |
| `NEXT_PUBLIC_REPO_URL` | no | — | GitHub repository URL. Landing links to the repo and the binding spec are hidden when unset. |
| `WEB_TRUST_PROXY` | no | `0` | `1` means rate limits key on the first `X-Forwarded-For` address (§15.3) |
| `WEB_LIMIT_*` | no | see §15.3 | Overrides for the limits |

### 3.2 Facilitator

- **New:** `ADMIN_API_KEY`, optional, at least 32 characters. When it is unset, the admin route is
  not mounted (§5.1).
- **Existing:** `WEB_APP_URL` MUST be set to the web app's origin. `/paypal/return` then redirects
  to `${WEB_APP_URL}/link/complete`.

## 4. Sessions and demo accounts

There is no sign-up. "Sign in" is the demo picker. Each visitor gets their **own demo operator**,
so judges never affect each other; the seller is shared. These rules follow the user's decision
of 2026-10-17.

### 4.1 Cookie

- **Name and contents:** `pp402_session`. The value is AES-256-GCM sealed JSON, keyed by
  `WEB_SESSION_SECRET`, in the facilitator's sealed format: `v1.<iv>.<tag>.<ciphertext>`, base64url
  parts, 12-byte IV.
- **Attributes:** `HttpOnly`, `Path=/`, `SameSite=Lax`, `Max-Age` 30 days, and `Secure` when
  `WEB_PUBLIC_URL` is https.
  - `SameSite=Lax` is required, not `Strict`. The return from PayPal is a cross-site redirect chain
    (PayPal, then the facilitator, then `/link/complete`), and `Strict` would drop the cookie.
- **Payload:**

  ```ts
  { v: 1,
    sid: string,                                                     // 16 random bytes, base64url
    operator?: { id: string; key: string; createdAt: number },       // unix seconds
    agents: { id: string; name: string; seed: string }[] }           // at most 5
  ```

  - `sid` identifies the browser session. It keys the per-session limits (§15.3) and the AI turn
    cache (§12.3).
  - `operator.key` is the visitor's operator API key.
  - `agents[].seed` is the raw 32-byte Ed25519 seed in base64url, for agents created in this
    session (§4.4).
  - The cookie holds no role. The console a page belongs to comes from its path (§4.3).
- **Who writes it:** only two route handlers, `POST /api/session` (§4.2) and `POST
  /api/operator/agents` (§4.4). Pages are server components, which cannot set or delete cookies in
  Next 16. They only read the cookie.
- **Bad cookies:** a cookie that fails to unseal, or has an unknown `v`, counts as no session.
  Pages redirect as in §4.3. The next `POST /api/session` replaces the cookie.
- **Server-only:** the cookie is read and written only by server code. Client code never sees its
  contents.

### 4.2 Starting a session

`POST /api/session` with body `{ role: 'operator' | 'seller', startOver?: boolean }`. Without a
valid cookie, it starts a new one with a fresh `sid` and no operator.

- **`seller`:** keep any operator data in the cookie. Answer `{ next: '/seller' }`.
- **`operator`:**
  - **Reuse:** if the cookie holds an operator and `startOver` is not true, call `GET
    /v1/operator` with its key.
    - On 200, keep everything.
    - On 401, treat the operator as gone: the key was revoked or the database reset. Create a new
      operator, as below.
  - **Create** a new operator through `POST /v1/admin/demo-operators` (§5.1).
    - This clears the cookie's `agents`.
    - It is subject to the creation limits (§15.3). Over the limit, answer 429 `demo_limit` with
      the message "Too many new demo accounts right now. Try again in a few minutes."
- **Response:** `{ next }`. `next` is `/app` when the wallet is `active`, `unlinking` or
  `stopped_by_payer`; otherwise it is `/app/onboarding/link`.

The demo-account switcher in the top bar posts the same route. "Start over" (§9.3) posts
`{ role: 'operator', startOver: true }`.

### 4.3 Page guards

| Request | Requires | Without it |
|---|---|---|
| `/app/**` | a valid session holding an operator | redirects to `/sign-in` |
| `/seller/**` | a valid session | redirects to `/sign-in` |
| `/api/operator/**`, `/api/runs` | a session holding an operator | 401 `no_session` |
| `/api/events`, `/api/ai/turn` | `scope=operator` needs an operator; `scope=seller` needs a valid session | 401 `no_session` |
| `/api/seller/**` | a valid session | 401 `no_session` |

`/api/events` takes the scope as the query parameter `?scope=operator|seller`. `/api/ai/turn`
takes it as `?scope=`. The scope comes from the page that calls them, never from the cookie.

- **Expired operator:** when a facilitator call with the operator key returns 401, the page
  redirects to `/sign-in?ended=1`. The sign-in page then shows "Your demo session ended. Start a
  new one."
- **Seller key:** the seller key comes from `WEB_SELLER_API_KEY`, never from the cookie. A 401
  with it means misconfiguration, not an ended session (§7).

### 4.4 Agent keys

- **Generation:** the web server generates every agent key it creates with `generateAgentKey`. It
  registers the key with `POST /v1/agents { name, publicKeyX }`. The facilitator therefore never
  sees a private key, as before.
- **The key shown once:** the browser receives the private key once, in the creation response: the
  raw seed (43 characters), the JWK and the fingerprint.
- **Sealed in the session:** the seed is also stored in the cookie's `agents` list, so that "Run
  this agent" works from this browser.
  - At most 5 agents keep a key. Adding a sixth drops the oldest key from the cookie; the agent
    itself is unchanged.
  - This is stated on screen: "This browser keeps the key so you can run the agent here. Clear the
    session to forget it."
- **Agents without a key:** an agent created any other way (by the seed CLI, or by an earlier
  session) cannot be run from the browser. Its "Run this agent" control is disabled, with the
  tooltip "This browser doesn't hold this agent's key."

## 5. Facilitator additions

All of these are additive. Existing fields and behaviour do not change. Each addition gets a
change note in facilitator.md, and tests.

### 5.1 `POST /v1/admin/demo-operators`

- **Mounting:** the route is mounted only when `ADMIN_API_KEY` is set. Without the env var it does
  not exist (404 `not_found`).
- **Auth:** `Authorization: Bearer <ADMIN_API_KEY>`.
  - Compare the SHA-256 digests of the given and configured keys with `timingSafeEqual`.
  - A missing or wrong key gets 401 `unauthorized`.
  - Operator and seller keys are not accepted here.
- **Body:** strict `{ name?: string }`, trimmed, 1 to 60 characters, default `"Northwind Research
  (demo)"`.
  - The default differs from the seed's `"Northwind Research"` on purpose. `seed()` finds its demo
    operator by name, and `seed --reset` deletes whatever that lookup returns, so a visitor's
    operator must never match it.
- **Effect:** one transaction that:
  - inserts an operator with the demo caps of `DEMO_OPERATOR` (per call 10, daily 1000,
    unsettled 500, total 5000 cents) and `email: null`
  - inserts a wallet with status `not_linked`
  - issues an operator key with label `web-demo` through `issueApiKey`
  - writes the audit record `operator.demo_created`, with `actorType: 'system'` and `actorId:
    'admin'`. `AuditEntry.actorType` is unchanged.
- **Response:** 201 `{ operator: { id, name }, apiKey }`. The key appears only in this response.

### 5.2 Usage counts

`GET /v1/operator` `usage` gains:

| Field | Definition |
|---|---|
| `notYetChargedCalls` | the count of commitments in state `unsettled` or `settling`, matching `notYetCharged` (the snapshot's `unsettled`, which covers both states) |
| `chargeable` | the sum of `amount` over commitments in state `unsettled` only: what a manual or unlink settlement would claim now (facilitator.md §9.2) |
| `chargeableCalls` | their count |
| `notCollected` | the sum of `amount` over commitments in state `uncollectable` |
| `notCollectedCalls` | their count |

`chargeable` can be lower than `notYetCharged`. That happens when a settlement in `pending` or
`needs_review` still holds `settling` commitments. The UI uses `chargeable` for every amount it
offers to charge (§10.7, §10.12).

`GET /v1/seller` `usage` gains `pendingCalls`: the count of the seller's commitments in state
`unsettled` or `settling` (matching `pending`).

### 5.3 Block reason

`GET /v1/operator` gains `blockReason`, and each agent in `GET /v1/agents` and `GET
/v1/agents/:id` gains the same field. It is computed with the same check as `blocked`:

- `'wallet_not_active'` when the wallet is not `active`
- otherwise `exceededCap(caps.perCall, snapshot, caps)` mapped as follows:
  - `'daily'` → `'daily'`
  - `'unsettled'` → `'unsettled'`
  - `'total'` → `'total'`
  - `undefined` → `null`
  - `'perCall'` cannot occur, because the amount checked is `caps.perCall` itself. It maps to
    `null`.

`blocked` stays, and equals `blockReason !== null`. Neither looks at the agent's own `status`; the
UI shows "Paused" before "Blocked" (§8.4).

## 6. Agent amendment

This is the roadmap's Phase 3 carry-over. agent.md §6.2's system prompt changes in two places,
and nothing else changes:

1. After "Call list_services first…", add the bullet:

   ```
   - Before your first call_service, write one short sentence that says what you plan to buy and
     why.
   ```

2. Replace the last bullet with:

   ```
   - When you are done, call finish once, alone, with the answer and a short paragraph that explains
     what you paid for, what you skipped and why. Write that paragraph in English, whatever language
     the answer is in. Do not state amounts the tools did not report.
   ```

`SYSTEM_PROMPT` in `apps/agent/src/agent.ts` gets the same text. Tests that pin the prompt are
updated.

The `finish` tool's `spend_explanation` description (agent.md §5) also becomes "Two to four
sentences, in English: what you paid for, what you skipped and why". This was added after the
build: in the real demo run, the system prompt line alone did not keep the paragraph in English. agent.md gets a change note. After the build, `npm run demo` is re-run once on Claude
Sonnet 5.5 to confirm the recorded PASS still holds.

## 7. Server routes (`apps/web/src/app/api`)

All routes run on the Node runtime. Bodies are JSON and validated with zod (strict, 16 KB limit,
except `/api/ai/turn`, which allows 256 KB). Errors use `{ error, message }`. Every `POST`, `PUT`
and `PATCH` passes the same-origin check (§15.2).

| Method and path | Session | Does | Answer |
|---|---|---|---|
| `POST /api/session` | any | §4.2 | `{ next }` |
| `GET /api/events?scope=operator\|seller` | per scope (§4.3) | SSE relay (§13) | `text/event-stream` |
| `POST /api/operator/wallet/link` | operator | `POST /v1/operator/wallet/link` | `{ approveUrl, expiresAt }` |
| `POST /api/operator/wallet/refresh` | operator | `POST /v1/operator/wallet/refresh` | `{ wallet }` |
| `POST /api/operator/wallet/unlink` | operator | `POST /v1/operator/wallet/unlink` | `{ wallet }`; 409 bodies passed through |
| `PUT /api/operator/caps` | operator | `PUT /v1/operator/caps`, always with all four fields; `total: null` means no total limit | `{ caps }` |
| `POST /api/operator/settlements` | operator | `POST /v1/settlements` | `{ settlement }` |
| `POST /api/operator/agents` | operator | §4.4 | `{ agent, key: { seed, jwk, fingerprint } }` |
| `PATCH /api/operator/agents/:id` | operator | `PATCH /v1/agents/:id` with `{ status }` | `{ agent }` |
| `POST /api/runs` | operator | agent run (§14) | `text/event-stream` |
| `POST /api/ai/turn?scope=operator\|seller` | per scope (§4.3) | AI assistant turn (§12) | `AgLlmResponse` |
| `GET /api/seller/probe/:serviceId` | valid session | unpaid probe of a seller endpoint (§10.11) | probe result |

**Facilitator errors reaching the browser:**

- A 409 code passes through unchanged with its message. The UI maps it to copy (§8.6).
- A facilitator 401 with an operator key becomes 401 `session_ended`.
- A facilitator 401 with the shared seller key becomes 503 `seller_unavailable`, with a log line
  saying the seller key is wrong. It is a configuration fault, not an ended session.
- A 502 `paypal_unavailable` passes through.
- Anything else becomes 502 `upstream_error`, with the facilitator's `X-Request-Id` as `ref`.

## 8. Shared presentation rules

### 8.1 Design tokens

The tokens come from `DesignSystem.dc.html`: colours (light, and dark for the two dark boards),
Plus Jakarta Sans for text, JetBrains Mono for amounts, ids, HTTP codes and code, the type
scale, radii, shadows and component styles.

- They are defined once as Tailwind v4 theme tokens. The DesignSystem board names them
  (`ink-950`, `ground-50`, `line-200`, `meter-400`, …).
- Fonts load through `next/font/google`.
- The chart palette is the design system's six colours, in order.

### 8.2 Money

- `formatUsd(cents)` returns `$D.CC`. It handles 0 (`$0.00`) and negative values (`−$0.41`, with
  U+2212).
- `centsToUsdString` from the scheme throws on 0, so display code MUST NOT use it.
- Amounts use tabular figures.
- A seller's net share can be negative on a small charge, because PayPal's fixed fee is larger
  than the charge. It is then shown in the danger ink colour, with the tooltip "PayPal's fixed fee
  is larger than this small charge."

### 8.3 Times

- `formatTime(seconds)` gives `HH:MM:SS`.
- `formatDateTime(seconds)` gives `Nov 2, 09:14`.
- `formatDate(seconds)` gives `Nov 2, 2026`.
- Day buckets are UTC days.

### 8.4 Status vocabulary (one table, one badge component)

Every status in the app renders through one `StatusBadge`, from this table. Each badge pairs a
colour with a glyph and a label (WCAG: never colour alone). This table settles the boards'
inconsistencies; where a board differs, this table wins.

| Domain | Value | Label | Glyph | Tone |
|---|---|---|---|---|
| PayPal link | `not_linked` | Not linked | ○ | neutral |
| | `waiting_for_approval` | Waiting for approval | ↻ | pending |
| | `active` | Active | ✓ | ok |
| | `unlinking` | Unlinking… | ↻ | pending |
| | `stopped_by_payer` | Stopped by payer | ⊘ | bad |
| | `link_failed` | Link failed | ✕ | bad |
| Agent | `active` | Active | ● | ok |
| | `paused` | Paused | ❙❙ | neutral |
| | blocked (derived) | Blocked | ⊘ | bad |
| Paid call | `unsettled` | Not yet charged | ◷ | pending |
| | `settling` | Charging | ↻ | warn |
| | `settled` | Charged | ✓ | ok |
| | `uncollectable` | Not collected | ✕ | bad |
| PayPal charge | `pending` | Charging | ↻ | warn |
| | `completed` | Completed | ✓ | ok |
| | `failed` | Failed | ✕ | bad |
| | `needs_review` | Needs review | ! | warn |
| Run | running / finished / blocked | Running / Finished / Blocked | ● | dark-board pills (LiveRun) |

Tones map to the design system badge colours:

| Tone | Background | Ink |
|---|---|---|
| ok | `#DDF9E9` | `#05592C` |
| pending | `#ECE8FF` | `#3A2799` |
| warn | `#FFF1D6` | `#6B4200` |
| bad | `#FDE7E4` | `#8A1C12` |
| neutral | `#EEF0EB` | `#3A423E` |

**Agent badge rule:** show Paused when the agent is `paused`. Otherwise show Blocked when
`blockReason` is set, with the tooltip:

| `blockReason` | Tooltip |
|---|---|
| `wallet_not_active` | "PayPal link not active" |
| `daily` | "Daily limit reached" |
| `total` | "Total limit reached" |
| `unsettled` | "Waiting for the PayPal charge" |

Otherwise show Active.

**Charge triggers:**

| Value | Label | Legend text |
|---|---|---|
| `threshold` | Threshold | "near <Auto-charge at>" |
| `daily` | Daily | |
| `manual` | Manual | |
| `unlink` | Unlink | "final charge when you unlinked" |
| `relink` | Re-link | "earlier usage collected when you re-linked" |

### 8.5 Service names

A paid call's service name and endpoint come from the demo seller's catalog:

- Match the commitment's `path` (without the query) against the catalog `path`.
- Display the endpoint as `<method> <path with query>`, for example `GET /v1/quote?symbol=KC`.
- A path missing from the catalog shows as its own path.
- The web server caches the catalog for 60 seconds.

### 8.6 Error copy

| Code | Copy |
|---|---|
| `nothing_to_settle` | "Nothing to charge right now." |
| `settlement_in_progress` | "A PayPal charge is already running." |
| `wallet_not_active` | "Your PayPal link isn't active." |
| `wallet_already_active` | "Your PayPal account is already linked." |
| `settlement_failed` (unlink) | "The final charge was declined, so your PayPal account stays linked. Try again later." |
| `paypal_unavailable` | "PayPal didn't answer. Try again in a moment." |
| `validation_failed` | the field messages (§10.4) |
| `session_ended` | redirect (§4.3) |
| `demo_limit`, `run_limit`, `ai_limit` | the route's message |
| `seller_unavailable` | "The seller console isn't available right now." |
| `upstream_error` | the error page (§10.14) |
| any other code (for example `agent_key_exists`) | the facilitator's `message` |

Toasts sit bottom right for 4 seconds, as `role="status"`, and can be dismissed.

## 9. App shell

### 9.1 Layout

- The shell follows §0.3 of the boards: the sandbox strip, the dark sidebar, the white top bar and
  the content area.
- The sandbox strip is on every page, and reads "SANDBOX · Sandbox: test money only. No real
  charges." On the dark boards and the landing, it uses those boards' styles.

### 9.2 Navigation

- **Operator sidebar:** Overview, Agents, Live run, PayPal charges, Settings.
- **Seller sidebar:** Overview, Endpoints, Settled revenue. The board's seller "Settings" link is
  dropped, because it is undesigned.
- Below 900 px wide, the sidebar becomes a horizontal, scrollable nav bar above the content. The
  boards have no mobile console.

### 9.3 Account card

- **Operator:** the operator's name, then the short id in mono (`op_7Hq2…`), because demo
  operators have no email.
- Under it, a small text button "Start over" opens a confirm dialog:
  - Title: "Start a new demo account?"
  - Body: "You get a fresh operator with no PayPal link, agents or paid calls. This one stays as it
    is."
  - Buttons: "Start over" and "Cancel".
- **Seller:** "Acme Data" / "Settled with PayPal".

### 9.4 Top bar

- **Demo-account switcher:** a select with "Operator demo · <operator name>" and "Seller demo ·
  Acme Data". It posts `/api/session` (§4.2).
- **"Ask AI":**
  - On Overview and Seller overview it opens the AI panel (§12.4).
  - On the other operator pages it links to `/app?ai=1`, which opens Overview with the panel
    focused.

### 9.5 Footer

Each console page ends with a muted line: "Times in UTC · Sandbox demo · Settled with PayPal".

## 10. Screens

Each screen ports its board (layout, styles, motion) and applies the fixes. Only the behaviour,
the data binding and the copy that is new or changed are listed here. Sample numbers in the
boards are replaced by data.

### 10.1 Landing `/`, boards `Main` and `LandingMobile`

- **Sections and copy:** as on the boards, with the fixes of §2.1 already applied there.
- **The PayPal logo:**
  - The hero pipeline's middle box shows the official PayPal logo, as on the board.
    - It uses the board's asset (`/_blob/f0ff…`, imported as
      `docs/design/canvas/assets/paypal-mark.webp`), served as `public/paypal-mark.webp`.
    - It is rendered unaltered, as on the board: height 50 % of the box, width auto, `alt="PayPal"`.
      It is not recoloured, cropped or filtered, and it keeps its clear space.
  - The captions stay "PayPer402" / "settled with PayPal".
  - This is the only place the logo appears. It shows PayPal as the payment rail, as the CLAUDE.md
    Trademark rule allows since 2026-10-17. Everywhere else, "PayPal" is plain text.
- **Hero animation:**
  - There are 9 stages; stage 3 is the Jev check.
  - The JS ticker MUST stop advancing when `prefers-reduced-motion: reduce` is set. The hero then
    shows its final stage.
  - A pause control toggles the ticker. It sits **inside** the hero panel, in its bottom caption
    bar next to the stage counter (`03/09`), never as a separate button above the panel.
    - It is a small icon button (pause or play glyph, about 28 px, in the caption bar's muted
      style).
    - It has `aria-label` "Pause animation" or "Play animation", `aria-pressed`, a tooltip with the
      same text, and the focus ring.
  - The "How it works" auto-advancing tabs and the meter follow the same rule.
- **Links:**
  - "Try the live demo" goes to `/sign-in`.
  - "For API sellers" goes to the page's sellers section.
  - "View on GitHub" and "Read the binding spec" use `NEXT_PUBLIC_REPO_URL`, the latter at
    `/blob/main/docs/spec/scheme_batch_settlement_paypal.md`. Both are hidden when the variable is
    unset.
- **Mobile:** the mobile layout (390 px) follows `LandingMobile`.

### 10.2 Sign in `/sign-in`, board `SignIn`

- **Cards:**
  - "Operator demo" posts `{ role: 'operator' }` and follows `next`.
  - "Seller demo" posts `{ role: 'seller' }`.
- **Notices:**
  - `?ended=1` shows the notice from §4.3.
  - A 429 shows the `demo_limit` message under the cards.
- **Returning visitors:** with an operator already in the session, the operator card's sub-line
  reads "Continue as <operator name>". A link under it, "Start a new demo account", posts
  `startOver`.

### 10.3 Onboarding step 1: Link PayPal `/app/onboarding/link`, board `OnbLink` and its wrappers

The stepper shows: Link PayPal, Set limits, First agent. The state comes from `GET /v1/operator`.

| State | Condition | Behaviour |
|---|---|---|
| Ready | wallet `not_linked` | "Link PayPal account" calls `/api/operator/wallet/link`, then does `window.location.assign(approveUrl)` in the same tab. A full-screen "Redirecting to PayPal…" hand-off shows for up to 1 second first. |
| Waiting | `waiting_for_approval` and no pending `relink` | "Finish on PayPal's page" with a spinner. The page polls `/api/operator/wallet/refresh` every 3 s, for up to 10 minutes. It also offers "Restart linking". |
| Collecting | `waiting_for_approval`, and `lastSettlement` is a `relink` in `pending` | OnbLinkCollecting copy, with `lastSettlement.amount`. It does **not** poll `/refresh`, which answers 409 `settlement_in_progress` while a relink is pending. It re-reads `GET /v1/operator` every 3 s, through `router.refresh()`, and also refreshes on the §13 relay's `settlement.updated` and `wallet.updated`. |
| Collecting, needs review | `waiting_for_approval`, and `lastSettlement` is a `relink` in `needs_review` | **New copy:** "Linked, but we couldn't confirm the charge for your earlier usage with PayPal. It is under review, and it will not be charged twice. Agents stay paused until it clears." There is no retry button, and no polling of `/refresh`; the relay keeps the page current. |

- **A 409 from `/refresh`:** in the Waiting state, a 409 `settlement_in_progress` means the
  approval just finished and a relink was claimed. The page treats it as "now collecting": no
  toast, and an immediate `router.refresh()`, which lands in the Collecting row.
| Linked | `active` | A check mark with `payerEmailMasked`; "Continue" goes to step 2 |
| Failed | `link_failed` | The reason from `linkError`: `cancelled` and `expired` use the fixes §2.3 copy; `relink_settlement_failed` uses the "couldn't collect" copy with `usage.notCollected`. Any other reason, including `payment_token_failed` (facilitator.md §8 step 2), uses "Linking did not complete. Try again." "Try again" restarts linking. |
| Stopped | `stopped_by_payer` (reached from "Re-link") | The Ready state, with the sub-text "$X of earlier usage will be charged first." (X = `usage.notCollected`) |

- The board's "Link states" annotation cards are designer notes, not UI.
- "Skip for now" goes to step 2. Linking is needed only to pay, not to explore.

### 10.4 Onboarding step 2: Set limits `/app/onboarding/limits`, board `OnbLimits`

- **Fields:** Max per call, Daily limit, Total limit (optional, with a "No total limit"
  checkbox), and Auto-charge at.
- **Initial values:** prefilled from the current caps in dollars.
- **Copy:** the helper text and the preview sentence come from fixes §1.4.
- **Validation:** one pure function, shared with Settings. It runs live, and its messages appear
  under the fields:
  - each value parses as dollars, with at most 2 decimals and at most $10,000.00
  - Max per call is at least $0.01
  - Max per call is at most the daily limit: "Max per call can't be higher than the daily limit"
  - Max per call is at most Auto-charge at: "Max per call can't be higher than Auto-charge at"
  - Total, when set, is at least Max per call: "The total limit can't be lower than Max per call"
- **Save:** "Save and continue" sends `PUT /api/operator/caps` with all four fields. A 400 from
  the facilitator maps its issues to the fields.

### 10.5 Onboarding step 3: First agent `/app/onboarding/agent`, board `OnbAgent`

- **Two steps,** as in the Agents drawer:
  1. The name field and "Create agent". The name matches `^[a-z0-9][a-z0-9-]{0,39}$`, with the
     message "Use lowercase letters, digits and dashes."
  2. The key, shown once.
- **The key panel:** "You won't see this again. Store the key somewhere safe."; the fingerprint;
  the 43-character key; and the buttons:
  - **"Copy":** copies the key and shows the toast "Key copied".
  - **"Download .env":** `<name>.env` with `# .env for <name>\nAGENT_PRIVATE_KEY=<seed>\n`.
    - The variable is `AGENT_PRIVATE_KEY`, the name the repo's agent CLI and MCP server read
      (agent.md §7). A judge can run `apps/agent` with the downloaded file as it is.
    - This overrides the name `PAYPER402_AGENT_KEY` in fixes §5.5, in the `.env` snippet, in the
      key label example and in the "Use it in your agent" code
      (`importPrivateKeyRaw(process.env.AGENT_PRIVATE_KEY)`).
  - **"Download key (JWK)":** `<name>.jwk.json`.
  
  The files are built in the browser from the creation response. Nothing is stored server-side.
- Then come the `.env` snippet and the "Use it in your agent" code block (fixes §5.5, with
  `AGENT_PRIVATE_KEY` as above), and the
  §4.4 note about the browser keeping the key.
- "I saved the key" goes to the Done screen.

### 10.6 Onboarding done `/app/onboarding/done`, board `OnbDone`

- "Run the demo agent" goes to `/app/live-run`.
- "Go to dashboard" goes to `/app`.

### 10.7 Operator overview `/app`, board `Overview` (all variants)

Data: `GET /v1/operator`, `GET /v1/agents`, and the paid calls of the last 30 days (§11.3).

**KPI cards:**

- **Spent today:** a bar against the daily cap. Over 90 % the bar uses the amber ink.
- **Not yet charged:**
  - a bar against Auto-charge at, with the sub-line "auto-charge near $X"
  - the "Charge now" button (rules below)
  - when the wallet is `stopped_by_payer` and `notCollected > 0`, the line "Not collected $X ·
    charged when you re-link"
- **Last PayPal charge:** the amount and "<date> · <status label>", or "—" with "No charges yet".
- **Active agents:** the count of agents in `active` status.
  - If `blockReason` is set, show "N · blocked" with the block reason as the sub-line.
  - Otherwise the sub-line is "N paused", or "No agents yet".

**PayPal link card:** the status badge, `payerEmailMasked`, "Linked since <date>" (or the stop
date), and "Manage" to `/app/settings`.

**Banners:** at most one, the first that applies:

| # | Condition | Banner |
|---|---|---|
| 1 | wallet `stopped_by_payer` | Stopped (fixes §2.7 copy, with `notCollected`). Button "Re-link PayPal account" goes to `/app/onboarding/link`. |
| 2 | wallet `unlinking` | Unlinking (fixes §2.7, with `lastSettlement.amount` when it is an `unlink` in `pending`) |
| 3 | collecting (as in §10.3) | Collecting: "Linked. Collecting $X of usage from before you stopped… Agents can pay again once this charge completes." |
| 4 | wallet `not_linked`, `link_failed` or `waiting_for_approval` | Not linked (fixes §2.7), with "Link PayPal account" |
| 5 | `lastSettlement` `failed` with `failureCode: 'declined'` | Declined (fixes §2.7, with its amount and date) |
| 6 | `lastSettlement` `needs_review` | Needs review (fixes §2.7) |
| 7 | `blockReason: 'daily'` | Daily limit (board copy, with the daily cap) |
| 8 | `blockReason: 'total'` | **New:** "Total limit reached. Agents spent $X in total. Raise the total limit in Settings to let them pay again." |
| 9 | `blockReason: 'unsettled'` | **New:** "Waiting for the PayPal charge. Unpaid usage reached $X. Agents pay again once the charge completes." |

**"Charge now":**

- **Enabled when** the wallet is `active`, `usage.chargeable > 0`, and `lastSettlement` is not
  `pending`.
  - It uses `chargeable`, not `notYetCharged`. Commitments held by a `needs_review` settlement
    stay `settling` and count in `notYetCharged`, but a manual charge cannot claim them (§5.2).
- **Confirm dialog:** "Charge $X to your PayPal account now?" / "This covers N paid calls that are
  not yet charged. It is one PayPal charge, so one fee." X is `chargeable` and N is
  `chargeableCalls`.
- **On confirm:**
  - The page calls `/api/operator/settlements`.
  - On 201, the toast is "PayPal charge started", or "PayPal charge completed" if the status is
    already `completed`, and the page refreshes.
  - A 409 shows its §8.6 copy as a toast.

**Spend section (AG Studio, §11):**

- **Controls:** the header has the range buttons 7d / 14d / 30d (default 14d) and an agent select.
  Both filter the rows passed to Studio, in the browser.
- **Widgets:** the 2×2 grid has Spend per day (line), Spend per agent (bar), Spend per service
  (donut) and Recent paid calls (grid), with the AI panel on the right (§12).
- **Empty state:** with no paid calls in the range, the empty state from the `Overview` `empty`
  variant replaces the grid. Its "Create an agent" goes to `/app/agents?new=1`, and "Run the demo
  agent" to `/app/live-run`.
- **Dropped:** the board's "View all" link. There is no all-calls page, and the widget header is
  AG Studio's.

**Live refresh:** §13.

### 10.8 Agents `/app/agents` and `/app/agents/[id]`, boards `Agents` and `AgentDetail`

**List:**

- **Table:** from `GET /v1/agents`, with the columns of the board.
- **Status badge:** §8.4.
- **Filters:** the search and the status buttons filter in the browser.
- **Blocked alert:** when `blockReason` is set, the alert "All agents are blocked. <tooltip
  text>."
- **Row actions:**
  - "Pause" / "Resume" calls `PATCH`, then shows the toast "Agent paused" with "Undo", or "Agent
    resumed".
  - "View" opens the detail page.

**"New agent":** opens the drawer; `?new=1` opens it on load. The drawer has the same two steps as
§10.5, including the "Use it in your agent" block, which the board's drawer lacks.

**Detail:**

- **Header:**
  - the name, the status badge (§8.4) and the fingerprint
  - "Pause" or "Resume"
  - "Run this agent", which goes to `/app/live-run?agent=<id>`. It is disabled when the session
    holds no key for the agent (§4.4).
- **KPIs:** Spent today, Spent total, Calls today, Last call.
- **Recent paid calls:** an AG Studio grid (§11) with the columns of the board. It holds the
  agent's paid calls of the last 30 days, loaded as in §11.3 with `agentId`, up to 5,000 rows. The "Charge" column holds the short settlement id, linking to the charge. The
  status select filters the rows passed to Studio.

### 10.9 PayPal charges `/app/charges` and `/app/charges/[id]`, boards `Charges` and `ChargeDetail`

**List:**

- **Table:** `GET /v1/settlements`, 50 at a time, with "Load more" using `before`. Plain React; no
  AG Studio.
- **Header:** the "Not yet charged $X / $Y" meter with "auto-charge near $Y", and "Charge now"
  (§10.7).
- **Trigger legend:** §8.4.

**Detail:** `GET /v1/settlements/:id`.

- **Header:** the amount, the status badge, and "PayPal charge · <trigger> · <date> · N paid
  calls".
- **Notes:** the boards' note for each status:
  - `pending`: Charging.
  - `failed` with `failureCode` `declined`: Declined.
  - `failed` with `failureCode` `payer_stopped`: Stopped.
  - `needs_review`: Review.
  - Any other `failureCode` uses the Declined layout with the facilitator's `failureReason`.
- **Summary:**
  - Amount, Trigger (threshold shows "Threshold (near $Y)"), Created, Paid calls.
  - References: Charge id, PayPal order id, PayPal capture id ("pending" while `pending`, "—"
    when absent), and Payer (`wallet.payerEmailMasked`).
- **By service:** the included calls grouped by service.
  - Each group shows "N × $unit = $total".
  - When prices differ within a service, it shows "N calls = $total".
- **Included paid calls:** an AG Studio grid with Time, Agent, Service, Endpoint and Price. Studio's
  own CSV export replaces the board's "Export CSV" button.
- **Sum rows:** below the grid, as React:
  - "Sum of N paid calls" with the sum
  - "✓ Equals the charge amount", or, if the sum ever differs, the bad-tone row "✕ Does not equal
    the charge amount ($X)"

### 10.10 Live run `/app/live-run`, boards `LiveRun`, `LiveRunFinished` and `LiveRunBlocked`

**Layout:** the page holds the task setup, the timeline and the budget meter, and then the spend
report, or the blocked card.

**Theme:**

- **Default light.** Live run is light by default, like the rest of the console:
  - white cards with the console's borders and ink
  - the light sandbox strip and top bar
  - the light badge and banner tones of §8.4 for the timeline rows, chips, status pill and end
    card
- **Dark option.** A toggle in the top bar switches to the dark look of the boards. It is an icon
  button (sun or moon) with `aria-label` "Switch to dark mode" or "Switch to light mode" and
  `aria-pressed`.
- **Remembered:** the choice is stored per browser in `localStorage` (`pp402.liveRunTheme`, read
  and written in try/catch) and applied before paint, so the page does not flash.
  - The root layout applies it with an inline `<script>` in `<head>`. That element carries
    `suppressHydrationWarning`, as `<html>` already does.
  - **Why:** some browser extensions insert their own `<script src="chrome-extension://…">` at
    the top of `<head>` before React hydrates. React then pairs that script with this one and
    reports a hydration mismatch in development. The user's Chrome showed this on 2026-10-18;
    the in-app browser, which has no extensions, did not.
  - The script's content and its position are unchanged.
- **Scope:** only this page has the toggle. The landing keeps its own design, and the sidebar
  stays dark everywhere, as on every board.

**Task setup:**

- **Agent:** a select of the agents whose key the session holds (§4.4). `?agent=` preselects one.
  - If there are none, a "Create research-bot" button creates an agent named `research-bot`
    (§4.4).
  - Its key is not displayed; the note reads "The key is kept in this browser session. Create an
    agent on the Agents page to get a key you can keep."
- **Task:** a textarea, 1 to 500 characters. Its default is the web app's own `WEB_DEFAULT_TASK`:
  "Brief me on today's coffee market: current price, top news, and the top headline translated
  into Spanish."
  - The report is then in English, and the agent still buys all three services of the story
    (quote, summary, translate).
  - The agent package's `DEFAULT_TASK` (CLI and demo) is unchanged.
- **Budget:** dollars from $0.01 to $5.00, default $1.00.
- **Static lines:** "Max per call · $X" (`min(caps.perCall, budget)`) and "PayPal link · <status
  label>".
- **"Run" button:** disabled while a run is in progress; the label is then "Running…".

**Run:** "Run" posts `/api/runs` (§14) and reads the stream.

**Timeline:** one row per event, rendered by the table below. The header shows "N steps". While
the run is open, a final "Agent is working…" row pulses.

| Event | Row |
|---|---|
| `catalog` (web frame, §14.2) | none; it provides the endpoints for the rows |
| `started` | none; sets the status pill to "Running", resets the meter to its budget |
| `thinking` | "Thinking": the note |
| `discovered_price` | "Discovered price": service name; "<METHOD> <path> answered 402 Payment required."; chip "402 · $X/call" |
| `decided` | "Decided": the note (the model's reason). With `check` (decision layer): a small chip, `passed` → "Jev · serves task 0.96"; `flagged` → "Jev flagged · <wouldRefuse label> (observed)"; `unavailable` → "Jev unavailable" |
| `paid` | "Paid": service name; "Signed payment promise · <httpStatus> OK"; chip "−$X", second line "total $Y" (from `spentCents`) |
| `refused`, `by: 'agent'` | "Skipped" (grey): service name; the note, plus the detail if any; chip with the price discovered for that `callId`, if any. With `check` (blocked): the Jev chip with its scores. |
| `refused`, `by: 'facilitator'` | "Refused" (red): service name; the note verbatim |
| `failed` | "Problem" (amber, using the "Discovered price" colours): the note; when `charged: 'unknown'`, the extra line "It may still appear as a paid call." |
| `result` | "Result": `completed` → "Answer ready. Spend report written."; `incomplete` → "The run stopped before finishing."; `refused` → "The model declined this task."; `error` → "The run failed." |

**Budget meter:** these values come from the events:

- spent (`paid.spentCents`)
- remaining (the last `remainingCents`)
- paid calls
- Skipped ("N · $total of skipped prices")

The bar's maximum is the run's budget.

Under the meter goes the fixes §2.10 note, with "Charge now" linking to `/app`.

**End of the run:**

- **No blocking refusal:** the spend report card comes from `result.report`:
  - one table row per `lines` entry
  - one struck-through row per `notUsed` service: "<name> · skipped", 0 calls, its price, $0.00
  - the total row
  - the explanation (`report.explanation`) as the quote
  - the "RESULT" box with `result.answer`. The model writes Markdown, so the answer is rendered
    through a small safe Markdown subset, never as raw `**` marks and never as HTML.
    - The renderer is a pure module (`lib/markdown-lite.ts`) that builds React elements. It does
      not use `dangerouslySetInnerHTML` and has no dependency.
    - Supported: paragraphs, line breaks, `**bold**`, `*italic*` / `_italic_`, `` `code` ``,
      bullet lists (`-`, `*`), numbered lists (`1.`), and headings `#` to `###` (rendered as bold
      lines).
    - Links render as their text only. Anything else stays as literal text.
  - The spend explanation quote uses the same renderer.
  - when `report.decisionLayer` exists, a muted line "Decision layer: Jev (<model>) · N passed ·
    N blocked · N flagged · N unavailable"
- **A refusal with a blocking code** (`wallet_revoked`, `wallet_not_linked`, `agent_disabled`,
  `unknown_agent`): the red end card.
  - Its title is "Run stopped. Nothing was charged." when `spentCents` is 0. Otherwise it is "Run
    stopped after $X of paid calls.", and the report card follows.
  - Its body depends on the code:
    - `wallet_revoked`: the board text, with "Re-link PayPal account".
    - `wallet_not_linked`: "The operator has not linked a PayPal account." with "Link PayPal
      account".
    - `agent_disabled`: "This agent is paused." with "Go to Agents".
    - `unknown_agent`: "This agent's key is not registered." with "Go to Agents".

**Leaving the page:** the run is aborted (§14.3).

### 10.11 Seller console `/seller`, `/seller/endpoints`, `/seller/revenue`

**Overview** (board `SellerOverview`): data comes from `GET /v1/seller` and the seller's paid
calls of the last 30 days.

- **KPIs:**
  - Revenue today: `revenueToday`
  - Revenue this week: the sum of the last 7 UTC days, gross
  - Paid calls today
  - Unique agents: `uniqueAgentsToday`
  - Not yet charged: `pending`, with "N paid calls · to be included in upcoming PayPal charges"
    (`pendingCalls`)
- **AG Studio:** Revenue per endpoint (bar), Revenue per day (line), Calls by agent (grid) and
  Recent paid calls (grid), with the seller AI panel (§12).
- **Agent references:** an agent shows as "Agent <agentRef>".

**Endpoints** (board `SellerEndpoints`):

- **Table:** from the catalog, plus the calls and revenue today per endpoint. It is read-only, and
  its columns follow fixes §2.15.
- **Note:** "Prices are set in your middleware config. A new price applies as soon as you deploy
  it."
- **Integration card:** fixes §5.4 (full form) and the route table.
- **"Test it":**
  - A service select and "Send unpaid request" call `GET /api/seller/probe/:serviceId`.
  - The web server sends one unpaid request to `SELLER_URL` with fixed sample params:
    - quote: `symbol=KC`
    - summarize: always the fixed body `{ url: "<SELLER_URL>/news/x" }`. Payment is checked before
      the handler validates, so any body draws the `402`. The probe never makes a paid call to
      find a real article.
    - translate: `text: "Hello"`, `targetLanguage: "Vietnamese"`
    - premium news: `topic=coffee`
  - It answers `{ status, statusText, headers: { 'payment-required', 'content-type',
    'cache-control' }, decoded }`. `decoded` is the base64-decoded `PAYMENT-REQUIRED` JSON.
  - The panel shows the status line, those headers, and "Decoded PAYMENT-REQUIRED".
  - The board's "paid" variant becomes a static block, "Example after payment", with the fixes
    §5.3 `PAYMENT-RESPONSE` sample. A real paid request would need an agent key and would charge an
    operator.

**Settled revenue** (board `SellerCharges`):

- **Table:** `GET /v1/seller/settlements`, with the columns Date, Calls, Amount, PayPal fee, Net and
  Status.
- **Summary card:** "Not yet charged $X · N paid calls, included in upcoming charges" (`pending`,
  `pendingCalls`).
- **Weekly KPIs:** gross, fees and net over the last 7 days of settlements.
- **Footnote:** fixes §2.16.

### 10.12 Settings `/app/settings`, board `Settings` and its variants

- **Layout:** no tabs. The board's "Account" tab is dropped.
- **PayPal link card:** states as on the board and in fixes §2.13, from `GET /v1/operator`. The
  amounts are bound to data: `usage.chargeable` for unlink (what the unlink settlement claims,
  §5.2), and `usage.notCollected` for stopped.
- **Unlink:**
  - **Confirm dialog:** "Unlink your PayPal account?" / "All agents are refused within a minute.
    Paid calls not yet charged ($X) are charged now, one last time." X is `chargeable`.
    - The button reads "Charge $X and unlink". With `chargeable` at 0, it reads "Unlink" and the
      second sentence is left out.
    - While `lastSettlement` is `pending`, the facilitator refuses to unlink (409
      `settlement_in_progress`). The Unlink button is then disabled, with the tooltip "A PayPal
      charge is running. Try again when it finishes."
  - **Outcomes:**
    - 200 `not_linked`: the toast "PayPal account unlinked".
    - 409 `settlement_failed`: the inline declined alert.
    - 409 `settlement_in_progress`: the card switches to Unlinking.
    - An unlink settlement in `needs_review`, with the wallet still `unlinking`: **new copy**,
      "We couldn't confirm the final charge with PayPal. It is under review, and it will not be
      charged twice. Your account unlinks once it clears."
- **Limits form:** §10.4, with the "used" sub-lines from `usage`.
  - "Reset" restores the **saved** caps, not the board's hard-coded defaults.
  - "Save" sends the full caps, then shows "✓ Limits saved. Agents follow them within a minute."
    and the toast "Limits saved".

### 10.13 PayPal return `/link/complete`, board `OnbLinkReturn`

- **The page:** it reads `?status=` and shows the board's single card for that status. The four
  cards on the board are a sheet of variants.
- **`waiting_for_approval`:** the page decides with the same link-state function as §10.3, from
  `GET /v1/operator`.
  - With a pending `relink`, it shows the Collecting card (§10.3), not "Still waiting", and
    refreshes as the Collecting row says, never through `/refresh`.
  - With a `relink` in `needs_review`, it shows the Collecting, needs review card.
  - Otherwise it shows "Still waiting for PayPal" and polls `/refresh` as in the Waiting row,
    including its 409 rule.
  - **"Check again"** calls `/api/operator/wallet/refresh` once, right away, with the same
    outcome rules as a poll:
    - another status, or a 409 `settlement_in_progress`: the page refreshes into the new card
    - still `waiting_for_approval`: the card stays
    - another error: its toast
    
    It also restarts the 10-minute poll window, so it still works after polling has stopped.
    It cancels the pending poll tick, and the next tick runs 3 s after its answer, so the two
    never overlap. While its request is running, the button is disabled. Before draft 5 it only re-read the
    operator and never asked PayPal, so after 10 minutes nothing on the page could finish the
    link.
  - It switches cards when the status changes.
- **`active`:** "Linked", with two buttons: "Set limits" (to `/app/onboarding/limits`) and "Go to
  dashboard".
- **`link_failed`:** the reason, with "Try again".
- **`unknown`:** "This link was already used. Go to your dashboard."
- **Any other value:** the facilitator redirects with the wallet's current status. On a few edge
  paths that is `stopped_by_payer`, `unlinking` or `not_linked`. Any value other than the four
  above is treated as `unknown`.
- **No operator session:** "Open this page in the browser you used to start linking." with a link
  to `/sign-in`.

### 10.14 Global states

From board `States`:

- **Empty states:** where a list or chart has no data.
- **Loading:** skeletons (`loading.tsx`) for KPI rows and widget frames.
- **Error page** (`error.tsx`): "This page hit a toll it couldn't pay.", with "Try again", "Go to
  overview", and `ref <request id>` when known.
- **Offline:** a banner driven by `navigator.onLine`, with fixes §2.17 copy.
- **Not found** (`not-found.tsx`): "No toll booth here." / "This page doesn't exist." with "Go
  home".

## 11. AG Studio

### 11.1 Embedding

- **Packages:** `ag-studio` and `ag-studio-react`, both pinned to 3.0.0.
- **Loading:** one client module, `src/components/studio/`, about 1.5 MB gzipped.
  - Only client components used by the overview, agent detail, charge detail and seller overview
    routes import it. Route-level code splitting keeps it off every other route. The spike needed
    no `dynamic()`.
  - Next refuses `ssr: false` in server components. If `next/dynamic` with `ssr: false` is used,
    the call lives inside a small `'use client'` wrapper.
- **Licence:** `AgStudioProvider` gets `licenseKey` from `AG_STUDIO_LICENSE_KEY`, passed from the
  server, or none.
  - Without a key, Studio prints its licence banner as about 7 `console.error` lines. In
    development the Next dev overlay counts each line as an "issue".
  - So in development only (`process.env.NODE_ENV !== 'production'`), a client filter installed
    before Studio first renders sends the banner's lines to `console.info` instead.
  - It matches only the banner, by its text ("AG Studio", "License Key", "trial license", and the
    asterisk border lines that come with them). Every other `console.error` passes through
    unchanged.
  - Production is untouched: the banner stays as AG Studio prints it (CLAUDE.md: the app works
    without a key, and the sponsor does not penalise the banner).
- **Theme:** `studioTheme.withParams(...)` from the tokens (§8.1), as in the spike:
  - fonts; card background, border, radius 14 and padding 16; title and subtitle typography
  - the chart palette, fills and strokes; grid lines; axis labels in mono
  - grid header and rows; the wrapper and canvas chrome removed
  - `layout.widgetPadding: 7`, which gives a 14px gap
- **Mode:** `view`. Widget toolbars keep Studio's CSV and PNG export.
- **Cell renderers:** grid widgets swap in `GridWidget` with `createCellRenderer`:
  - status fields render `StatusBadge` (§8.4)
  - time, agent, price and endpoint fields render mono
  - the time column gets a fixed width, so it never truncates (spike finding)

### 11.2 Data sources

Each Studio instance gets one source, `paid_calls`. Each row is one paid call:

```ts
{ id: string, time: string /* 'YYYY-MM-DDTHH:MM:SS' UTC, no zone */, day: string /* 'YYYY-MM-DD' */,
  agent: string, service: string, endpoint: string, path: string /* path without query, e.g. '/v1/quote' */,
  price: number /* USD */, status: string /* label */, charge: string /* short settlement id or '' */ }
```

- `id` is always in the source. Grid widgets include it as a hidden or narrow column, so identical
  rows never merge. Milestone 1 checks this.
- Field formats:
  - `price`: `currencyFormat` with `$#,##0.00`
  - `time`: `dateTimeFormat` with `mmm d, hh:mm:ss`. The grids span up to 30 days, so a time
    without its date would read out of order.
  - `day`: `dateFormat` with `mmm d`
- **Descriptions for the AI:**
  - the data `description`: "Paid API calls made by AI agents. Every amount is in US dollars (USD);
    show it with a $ sign. Times are UTC."
  - the source `description`: "One row per paid call. price is the USD price of that call; status
    says whether it is charged yet."
  - The seller variant says "revenue" and "agent references".

### 11.3 Row loading

- **Operator:** `GET /v1/commitments?since=<30 days ago>&limit=500`, paged, up to 5,000 rows.
  Agent detail adds `agentId`. Charge detail uses the settlement's own `commitments`.
- **Seller:** `GET /v1/seller/commitments` with the same paging.
- **Paging:** the facilitator filters `recorded_at < before`, ordered by `recorded_at DESC, id
  DESC`. A page that ends inside one second would therefore skip that second's other rows, and
  parallel tool calls land in the same second. So:
  - the next page uses `before = <last row's recordedAt> + 1`
  - rows are de-duplicated by `id`
  - paging stops when a page adds no new row, or when the cap or the `since` cutoff is reached
- **The cap:** when the cap is reached, a muted note under the section reads "Showing the latest
  5,000 paid calls."

### 11.4 Widgets

| Screen | Widgets (type, mapping) |
|---|---|
| Overview | `line-chart` day → sum(price) "Spend per day"; `bar-chart-grouped` agent → sum(price) "Spend per agent"; `donut-chart` service → sum(price) "Spend per service", with the total label and the legend on the right; `grid` time, agent, service, price, status, sorted by time descending, "Recent paid calls" |
| Agent detail | `grid` time, service, endpoint, price, status, charge |
| Charge detail | `grid` time, agent, service, endpoint, price |
| Seller overview | `bar-chart-grouped` path → sum(price) "Revenue per endpoint" (the path without its query, so each endpoint is one bar and the label has no space to be cut at); `line-chart` day → sum(price) "Revenue per day"; `grid` agent, count(id), sum(price) "Calls by agent"; `grid` time, agent, endpoint, price, status "Recent paid calls" |

Widget states are built in code (`initialState`). They are not saved.

## 12. AI assistant

### 12.1 Panel

- **Placement:** the AG Studio AI panel sits on the right of the Overview and Seller overview
  Studio instances.
- **View mode:** it is shown in view mode through `panels.view.right = ['ai']`, cast past the
  types (spike finding).
  - If a later Studio version refuses the cast at run time, the fallback is `mode: 'edit'` with
    `panels.edit.right = ['ai']` and no other panels.
  - The cast is listed as a Phase 5 risk.
- **Text:** `localeText` sets the panel title ("Ask about your spend", or "Ask about your revenue")
  and the input placeholder (the same text with "…").
- **Prompt starters:**
  - Operator: "Which agent spent the most this week?", "Show spend by service for yesterday", "How
    much is not yet charged?"
  - Seller: "Which endpoint earned the most this week?", "How many paid calls came in today?", "How
    much is not yet charged?"

### 12.2 Agent

- **One read-only agent:** a `directLlmRunner` named "Spend analyst" (or "Revenue analyst"), with
  only these tools:
  - `viewSchema`
  - `viewReport`
  - `viewPage`
  - `viewWidget`
  - `executeQuery`
- **Instructions:** "You answer questions about this dashboard by querying its data. Amounts are
  USD. Times are UTC. Do not change the dashboard."
- **Write tools:** none are given, so the assistant cannot change the dashboard.

### 12.3 `POST /api/ai/turn`

This is the spike's route, hardened.

- **Body:** an `AgLlmRequest`. The session is required.
- **The request to Claude:** the beta Messages API, as the spike's `/api/ai/turn` route calls it.
  It does not use the agent's tool runner, its `thinking-display-updates` beta or its `display:
  'updates'` setting.
  - `model` from `ANTHROPIC_MODEL`
  - `max_tokens` 16000
  - `output_config: { effort: 'low' }` (simple read-only analysis)
  - `betas: ['server-side-fallback-2026-07-01']` with `fallbacks: 'default'`
  - `cache_control: { type: 'ephemeral' }`
  - no `thinking` field (adaptive)
- **Translation:** as in the spike:
  - instructions and system items go to `system`
  - tool schemas become `input_schema` with `type: 'object'`
  - forced tool choice becomes a prompt line (forced `tool_choice` is a 400 on current models)
  - Studio's preflight tool ids are sanitised to `^[a-zA-Z0-9_-]{1,64}$`
  - a trailing assistant turn gets the user nudge "Continue."
  - a JSON `responseFormat` becomes `output_config.format: { type: 'json_schema', schema }`,
    alongside the effort setting. Studio's direct runner sends text today; this keeps a
    structured turn structured.
- **Turn cache:**
  - Claude's original turns are kept in an in-process map keyed by `<sid>:<message id>`, so a
    session can replay only its own turns.
  - At most 50 entries per `sid` and 2,000 in total, oldest evicted first.
  - Turns are replayed unchanged, so thinking blocks survive (spike-verified). After a restart,
    or after eviction, turns are rebuilt without thinking blocks.
- **Limits:** §15.3. The answer to a limit is an `AgLlmResponse` with `status: 'failed'` and the
  error message "The assistant is busy. Try again in a few minutes."
- **Response:** non-streaming. The browser adapter replays the finished turn as AG-UI events. The
  key never reaches the browser.
- **Logging:** each request logs a count line (items, replayed turns) and never the content.
- **Query reliability.** This was added after the first local run.
  - **The bug:** in that run, the Overview assistant's `execute_query` calls failed again and
    again with "Value did not match any of the discriminated types", for example a `max` on a date.
  - **The fix:** the route MUST make Studio's query tool usable by Claude. Find the cause from a
    captured `AgLlmRequest` (its `tools` schemas) and the failing tool inputs, then fix it with any
    of these:
    - a schema normalisation step in the route, for constructs Claude handles poorly or that the
      translation loses (for example Studio's `{ not: {} }` "undefined" markers, `const`
      discriminators, `$defs` and `$ref`). The sponsor boilerplate's OpenAI adapter does this kind
      of transform; read it for the idea only, and never copy it.
    - clearer agent instructions: the field ids, the aggregations allowed per field type (`sum`,
      `avg`, `min`, `max` only on numbers; dates take `first`, `last`, `count`, `countd`), and day
      buckets through `<field>::day`
    - `effort: 'medium'` if `low` proves too weak
  - **Done when:** each of the three prompt starters, plus "Which day had the highest spend?" and
    "When was the last paid call?", gets an answer with no failed query.

### 12.4 "Ask AI" button

- **Opening the panel:** on pages with a panel, the top-bar button opens it. The order of attempts
  is:
  1. through Studio's API (`api.setState` with `panels.ai.collapsed: false`), if Milestone 1 finds
     that this works in view mode
  2. otherwise by scrolling the panel into view and focusing its input
- **`?ai=1`:** does the same on load.

## 13. Live updates

- **`GET /api/events`:** relays the facilitator's `/v1/events` to the browser as SSE. The browser
  never sees the key. Operator pages open it with `?scope=operator`, and seller pages with
  `?scope=seller`.
- **Operator:**
  - Each browser connection opens one upstream stream with the session's operator key.
  - When the browser disconnects (`req.signal` aborts), the upstream fetch MUST be aborted. The
    facilitator allows 5 streams per key and replays nothing, so a leaked upstream ends in 429s.
- **Seller:**
  - All visitors share one seller key. The web server keeps **one** upstream stream per process and
    fans its frames out to every connected seller browser.
  - It opens the upstream on the first subscriber, and closes it 30 s after the last one leaves.
- **Frames:** the relay forwards `event:`/`data:` frames unchanged. It sends its own `: keepalive`
  every 15 s and drops the facilitator's comments.
- **Browser behaviour:**
  - Any event schedules `router.refresh()`, debounced by 800 ms, so the server components refetch.
  - On reconnect, the page refreshes once, because events are not replayed.
  - If the upstream answers 429, the relay answers 429 `too_many_streams`. The browser then polls
    by refreshing every 15 s while the page is visible.
- **Pages that listen:** Overview, Agents, Agent detail, Charges, Charge detail, Settings and the
  seller pages. Live run listens to its own run stream instead.

## 14. Agent runs

### 14.1 `POST /api/runs`

- **Body:** strict `{ agentId, task: string 1–500 chars, budget: string dollars }`. The budget
  parses with `priceToCents` and is between 1 and 500 cents.
- **Checks before the stream starts,** each answered as JSON:
  - **400 `validation_failed`:** the body is invalid.
  - **404 `agent_key_missing`:** no key in the session for `agentId`.
  - **409 `run_in_progress`:** this operator already has a run open (an in-process map keyed by
    operator id).
  - **429 `run_limit`:** a run limit is reached (§15.3).
- **Running:**
  - Read `caps.perCall` from `GET /v1/operator`.
  - Set `maxPerCallCents = min(caps.perCall, budgetCents)`.
  - Open the session with `openSession({ sellerUrl: SELLER_URL, privateKey, budgetCents,
    maxPerCallCents, onEvent, spendCheck? })`. The decision layer goes through
    `setupDecisionLayer(decisionLayerWant(...), createJevSpendCheck)`, unless
    `WEB_DECISION_LAYER=off`.
  - Call `runAgent({ task, session, anthropic, model, signal })`.
- **Errors after the stream started:** a `CatalogError` at `openSession`, or any other thrown
  error, is sent as an `error` frame with `{ message: "The agent couldn't start: <reason>" }`. The
  reason carries no secrets.

### 14.2 Stream

`text/event-stream` with these frames, in order:

1. `event: catalog`, data `{ services: [{ id, name, method, path, priceCents }] }`
2. `event: agent`, data `<AgentEvent JSON>`, for each event as emitted
3. `event: end`, data `{ status }`, or `event: error`, data `{ message }`

- **Keepalive:** a `: keepalive` comment every 15 s.
- **The browser reads the stream** with `fetch` and a stream reader, because the request is a POST.

### 14.3 Abort and time limit

- **The signal:** the run's `AbortSignal` combines `req.signal` (the browser closes the page or
  the stream) with a 180 s limit.
- **When it fires:** `runAgent` stops, as in agent.md §6.3, and the run's slot is released.
- **Paid calls:** calls already made stay in the ledger.
  - The signal aborts only the Anthropic requests. A paid request already in flight finishes
    under the payer's own 20 s timeout (agent.md §4.3), and may still be recorded after the browser
    left.
  - The web app does not try to abort it, because a cut-off paid request is an unknown outcome,
    not a saving.
- **Release:** the run map entry is removed in `finally`, whether the run ends normally or
  through an error or abort.

## 15. Security

### 15.1 Secrets

- **Server-only:** these values exist only in server code:
  - API keys
  - the admin key
  - the session secret
  - the Anthropic and TypeSafe keys
  - agent seeds, except in the creation response to their owner
- **Enforcement:** server modules import `server-only`, so an accidental client import fails the
  build. `NEXT_PUBLIC_*` holds only the repo URL.
- **Logs:** no logs, events, errors or pages carry keys, seeds, vault ids or payment headers.

### 15.2 Requests

- **Same-origin check:** every state-changing route checks `Origin` (or, without it, `Referer`)
  against `WEB_PUBLIC_URL`'s origin, and answers 403 `forbidden` otherwise. This is on top of
  `SameSite=Lax`.
- **Response headers:** `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, and `X-Frame-Options: DENY`. A CSP is a Phase 5 item, because
  AG Studio injects inline styles.
- **Seller content:** agent answers and seller data render as text, never as HTML.

### 15.3 Limits (in process)

- **Client key:** the first `X-Forwarded-For` address when `WEB_TRUST_PROXY=1`, otherwise one
  shared bucket. It keys the "per client" limits.
- **Session key:** the cookie's `sid`. It keys the "per session" limits. Per-operator limits key
  on the operator id.
- **Windows:** sliding windows in memory, reset by a restart. Phase 5 may move them to a shared
  store.

| Limit | Default | Env |
|---|---|---|
| New demo operators per client | 5 per hour | `WEB_LIMIT_OPERATORS_PER_HOUR` |
| New demo operators, all clients | 200 per day | `WEB_LIMIT_OPERATORS_PER_DAY` |
| Concurrent runs per operator | 1 | — |
| Runs per operator | 20 per day | `WEB_LIMIT_RUNS_PER_DAY` |
| Runs, all operators | 60 per hour | `WEB_LIMIT_RUNS_PER_HOUR` |
| AI turns per session | 120 per hour | `WEB_LIMIT_AI_TURNS_PER_HOUR` |
| AI turns, all sessions | 2,000 per day | `WEB_LIMIT_AI_TURNS_PER_DAY` |
| Seller probes per client | 30 per minute | — |

### 15.4 Trademark

- **The official PayPal logo:** it appears only in the landing hero's settlement step (§10.1),
  unaltered, to show PayPal as the payment rail (CLAUDE.md Trademark rule, changed by the user on
  2026-10-17).
- **Nothing else:** no PayPal wordmark styling, no PayPal blue and yellow, no PayPal-style buttons,
  and no use of the logo as PayPer402's own branding.
- "PayPal" appears only in factual text.
- The PayPer402 mark is one asset (`public/logo.png`), so it can be replaced without code changes,
  as the user decided on 2026-10-17.

## 16. Accessibility and motion

- **Contrast:** WCAG AA. Every status pairs colour with a label and a glyph (§8.4).
- **Semantics:** real buttons, links and labelled inputs.
- **Dialogs and drawers:** they trap focus, close on Escape, and return focus.
- **Focus ring:** 2px `#2BE38A`, offset 1. Dark boards keep the same green.
- **Live regions:**
  - The run timeline is an `aria-live="polite"` list.
  - Toasts are `role="status"`.
  - Blocking banners are `role="alert"`.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables every page entry animation, the
  landing ticker and the run row animations. The boards' reduced-motion blocks are kept.

## 17. Risks carried to Phase 5 and 6

- The view-mode AI panel depends on a cast that AG Studio does not support (§12.1).
- Run state, the AI turn cache and the limits live in process memory. One web process is assumed.
- The Anthropic promotional credits expire on 2026-11-11, but the hosted demo must run until
  2026-12-15. Runs and the assistant need a funded key, or they must degrade to the documented
  "busy" answers.
- Judges may share one sandbox Personal account. Settled on 2026-10-18 (facilitator.md §5.1):
  - PayPal keeps **one** agreement per payer and merchant, so every demo operator linked with that
    account shares one payment token.
  - Linking works for all of them.
  - One judge's "Stop paying with PayPal" stops every operator linked with that account, and an
    operator's own Unlink keeps the agreement while others still use it.
  - The Phase 5 testing instructions should offer more than one sandbox Personal account, and say
    what happens when one is shared.
- The PayPer402 mark resembles a two-letter payments monogram. The user will decide on a final
  mark before the video.

## Build notes

Decisions made while building Phase 4 (2026-10-17). The build spec's Findings hold the evidence.

- **Server code:** route handlers are factories in `apps/web/src/lib/handlers/` that take their
  dependencies; the `route.ts` files only wire them. Process-wide state (dependencies, run
  registry, turn cache, seller relay hub, Anthropic clients) lives on `globalThis`, because Next
  bundles each route on its own.
- **"Ask AI" (§9.4, §12.4):** `api.setState` with `panels.ai.collapsed: false` works in view mode,
  so attempt 1 is used. The top-bar button reaches the Studio instance through a window event.
  On pages without a panel, the button is the boards' plain secondary button that links to
  `?ai=1`; in the dark live-run bar it keeps the dark style.
- **Grids (§11.2):** `id` is the last column ("Paid call"), so identical calls never merge. The
  time column has a 136 px minimum width, enough for `mmm d, hh:mm:ss`. On agent and charge detail the Studio grid has no title
  and no frame of its own, because the page card already carries the title. "Calls by agent" has
  no grand-total row.
- **Charge detail:** CSV export is Studio's widget menu (§11.1), with a short hint in the card
  header in place of the board's "Export CSV" button.
- **PayPal charges list:** "Load more" reloads the page with `?pages=N` (50 × N, at most 500), so
  no extra route is needed.
- **Paging (§11.3):** a second holding more paid calls than one page (500) stops the paging,
  because the next page adds no new row. Real traffic is far below that.
- **Detail pages** (agent, charge) use the boards' breadcrumb header, without the demo-account
  switcher.
- **Errors across chunks:** Next bundles a module into each route chunk, so shared singletons
  can throw errors made by another chunk's copy of a class. The web app's error classes carry a
  `Symbol.for` brand and are matched with guards (`isFacilitatorError` and others), never
  `instanceof`. Route files resolve their dependencies inside a try (`withServerDeps`).
- **`next.config.ts`** sets `agentRules: false`, so `next dev` does not write an `AGENTS.md` into
  the app.
- **Known AG Studio limits, accepted as small visual differences:**
  - long category labels in bar charts are cut at the first space ("GET…"). Studio's axis label
    options have no width or wrapping setting, and an AG Charts theme override had no effect.
  - with the AI panel open, the 2 × 2 grids are narrow and their right-hand columns are cut off
    until the panel is collapsed.
  - an aggregated grid column is titled by Studio ("Paid call (count)"); it cannot be renamed.
  - donut colours follow the data order, not the size order.
- **Main session decisions after the build** (the builder's open questions):
  - §6: the `finish` tool's `spend_explanation` description asks for English. In the real demo
    run the paragraph came back in Vietnamese despite the system prompt line.
  - §11.2 and §11.4: rows gain `path`. The seller's "Revenue per endpoint" groups by it, because
    the endpoint with its query split one service into several bars with cut labels. Grid times
    show the date (`mmm d, hh:mm:ss`).
  - Build spec `dev:stack`: on start it checks that ports 3000, 4020 and 4021 are free. If one is
    taken, it names the port and exits 1. A hard kill on Windows skips the exit handler and can
    leave the child processes running.
- **Draft 5 build (2026-10-18):**
  - §10.13 "Check again": the scheduling is `lib/waiting-poll.ts` (`WaitingPoll`), which
    `useWaitingPoll` wraps. A click while a tick's request is running waits for that answer and
    then asks, so two requests never overlap. If that answer already moves the page on, the click
    sends nothing more. When an answer stops the ticks, "Check again" still works. The button keeps
    its label; it is disabled with `aria-busy` while its request runs.
  - Build spec `dev:stack`: an empty or blank `WEB_SESSION_SECRET` (as `.env.example` ships it)
    counts as unset. The kept file holds the hex without a newline.

## Change notes

- **Draft 5 (2026-10-18), after the user's second local run.** This round runs the full review and
  audit loops, at the user's request.
  - **Shared PayPal accounts:** the facilitator now lets several operators hold one PayPal
    payment token (facilitator.md draft 3.3, §5.1). §17 records what that means for judges, and
    §10.3 gives `payment_token_failed` the generic failure copy.
  - **§10.13:** "Check again" asks PayPal through `/refresh` and restarts the poll window.
  - **§10.10:** the theme script carries `suppressHydrationWarning`, because a browser extension
    can insert a script ahead of it.
  - **Build spec `dev:stack`:** without `WEB_SESSION_SECRET`, it keeps a generated secret in
    `data/web-session.key`, so a restart keeps sessions. The user's restart had dropped their
    session and left their linked demo operator out of reach.

- **Draft 4 (2026-10-17), after the user's first local run.** The user chose a quick spec → build
  path for these fixes, without the review and audit loops.
  - §10.10: Live run is light by default, with a light/dark toggle remembered per browser. Its
    default task is English, and the answer and explanation render through a safe Markdown subset.
  - §10.1: the landing's pause control moves into the hero panel's caption bar.
  - §11.1: in development, AG Studio's licence banner is routed to `console.info`, so the Next
    overlay stops counting it.
  - §12.3: the AI assistant's query tool must work, with "Query reliability" as the acceptance
    rule.
  - §10.1 and §15.4: the user changed the CLAUDE.md Trademark rule. The landing hero's settlement
    step now shows the official PayPal logo, unaltered, and nowhere else.
- **Draft 3 (2026-10-17), after the second review:**
  - §10.5: the downloaded `.env` and the snippets use `AGENT_PRIVATE_KEY`, which the repo's agent
    reads, instead of the fixes' `PAYPER402_AGENT_KEY`.
  - §10.13: any unexpected `status` value is treated as `unknown`.
  - §8.6: other codes show the facilitator's message.
  - §12.3: the Claude request follows the spike's route, not the agent's tool runner.
- **Draft 2 (2026-10-17), after the first review:**
  - §5.2: `notYetChargedCalls` counts `unsettled` and `settling`, matching `notYetCharged`. The
    new `chargeable` and `chargeableCalls` count `unsettled` only, and drive "Charge now" and the
    unlink dialog (§10.7, §10.12).
  - §10.3 and §10.13: the Collecting states never poll `/refresh`, which answers 409 while a relink
    is pending. A 409 from `/refresh` in the Waiting state means "now collecting".
  - §4: pages never write cookies. Only `POST /api/session` and `POST /api/operator/agents` do.
    The cookie holds a `sid` and no role. `/api/events` and `/api/ai/turn` take a `scope`.
  - §5.1: the default name "Northwind Research (demo)", so it never matches the seed's operator;
    the audit actor is `system`/`admin`.
  - §5.3: `'perCall'` maps to `null`. §7: a seller-key 401 becomes 503 `seller_unavailable`.
  - §10.8: agent detail loads up to 5,000 rows, as in §11.3. §10.11: the summarize probe uses
    only the fixed URL. §10.12: the Unlink button is disabled while a charge is pending.
  - §11.1: no `ssr: false` in server components. §11.3: paging uses `before = last + 1` with
    de-duplication by id.
  - §12.3: a JSON `responseFormat` maps to `output_config.format`; the turn cache is keyed by
    session. §14.3: an in-flight paid request is not aborted.
- **Draft 1 (2026-10-17):** first version. It follows the AG Studio spike (`spikes/ag-studio`),
  the frozen canvas `1792213018-362b`, and the user's decisions of 2026-10-17: per-visitor demo
  operators, the AI panel in view mode through the cast with a read-only agent, AG Studio's own
  chat UI, AG Studio loaded only on dashboard routes, small visual differences accepted, and the
  logo as one replaceable asset.
