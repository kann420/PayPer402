# PayPer402 roadmap

Build plan for the PayPal AI Hackathon. **Submission deadline: 2026-11-12, 12:00 PT. Target: submit
on 2026-11-11** to leave a one-day buffer.

How to use this file:

- Phases run in order. Each phase ends with a **Done when** check. Do not start the next phase
  until that check passes, unless a task is marked *parallel*.
- Tick tasks (`[x]`) as they land and move the **Current phase** marker.
- Anything not listed here is out of scope until Phase 6 is done. Ideas go under **Stretch**.
- The dates are targets. If a phase slips by more than a day, cut scope from Phase 4 polish or
  Stretch, never from Phase 6.

**Current phase: Phase 5**

- Phase 1 passed its final audit on 2026-10-15.
- Phase 2 passed its audit on 2026-10-16, and its sandbox end-to-end run passed the same day.
- Phase 3 passed its audit on 2026-10-16, and `npm run demo -- --link` passed on the real sandbox
  the same day.
- Phase 3.5 was inserted before Phase 4 on 2026-10-16, at the user's request. It passed its
  audit on 2026-10-16, and `npm run demo` passed on the real sandbox the same day, with a Jev check
  on every paid call.
- Phase 4 passed its audit on 2026-10-17. Its Milestone 11 fixes passed audit on 2026-10-18, and
  the browser flow passed on the real sandbox the same day.
- Phase 4.5 (operator CLI) was inserted before Phase 5 on 2026-10-27, at the user's request. It was
  built with Claude Sonnet 5.5 and audited by the main session at the user's request, and the
  audit passed in round 1 on 2026-10-27. The real-sandbox acceptance test passed on 2026-11-05.

## Overview

| Phase | Dates | Goal | Main judging criteria |
|---|---|---|---|
| 0. Foundation | Oct 15–16 | Repo, tooling, PayPal vault proven on sandbox | — |
| 1. x402 binding | Oct 16–20 | Paid HTTP calls work through the official x402 SDK on `paypal:sandbox` | Innovation, Tech |
| 2. Facilitator + PayPal settlement | Oct 20–26 | Signed commitments become real PayPal sandbox charges | Tech, Impact |
| 3. Demo seller + AI agent | Oct 26–Nov 1 | An LLM agent shops for paid APIs within a budget | Tech (AI), Innovation |
| 3.5. Decision layer (Jev) | Oct 16–22 | A calibrated second opinion before each paid call | Tech (AI), Innovation |
| 4. Web app + AG Studio dashboards | Nov 1–6 | Judges can do everything in a browser | Design, AG Studio prize |
| 4.5. Operator CLI | Oct 27–Nov 1 | An agent joins from a terminal with a claim code and pays from any MCP client | Design, Tech, Innovation |
| 5. Hosting + hardening | Nov 6–9 | A public demo that stays up through Dec 15 | Design, Tech |
| 6. Submission | Nov 9–11 | Video, write-up, testing instructions, submit | Presentation |

## Phase 0: Foundation (Oct 15–16)

- [x] Confirm on sandbox that a saved PayPal wallet can be charged again with no payer present
  (`UNSCHEDULED_POSTPAID`), and that payer revocation blocks further charges.
- [x] Project instructions, MIT license, `.gitignore`, sandbox `.env`.
- [x] npm workspaces monorepo: TypeScript, Vitest, shared `tsconfig`.
- [x] Translate the vault spike to English, rename it, and move it to `spikes/vault-charge/`.
- [ ] First commit and a GitHub repository. It may stay private until submission, but it must be
  public by Nov 11.
- [ ] CI (GitHub Actions): typecheck, tests, and a secret scan on every push.

**Done when:** `npm run typecheck` and `npm test` pass in CI on the first commit.

## Phase 1: x402 binding (Oct 16–20)

Goal: the PayPal network plugs into the official x402 SDK, the same way the EVM and Solana
networks do.

- [x] **Plug-in spike:** a fake-settle scheme on `paypal:sandbox`, run end to end through
  `@x402/express` (server) and `@x402/fetch` (client). Closes the "x402 plug-in" gate in
  `CLAUDE.md`.
- [x] Commitment format, as defined in `docs/spec/scheme_batch_settlement_paypal.md`:
  - The agent signs with Ed25519 over a canonical commitment: id (nonce), key id, network, asset,
    payTo, max amount in cents, issued-at, and expiry.
  - Replay protection uses the unique id; the expiry bounds how long a commitment can be used.
- [x] `packages/scheme-paypal`:
  - **Client:** `createPaymentPayload` signs commitments.
  - **Server:** builds `PaymentRequirements` with the price in USD cents.
  - **Facilitator:**
    - `verify` checks the signature, expiry, nonce and caps.
    - `settle` records the commitment in a ledger interface and moves no money yet.
- [x] Binding spec draft, `docs/spec/scheme_batch_settlement_paypal.md`, in the style of the x402
  scheme specs: purpose, payload, verification, settlement, and error codes.
- [x] Unit tests: valid payment, bad signature, expired, replayed, over cap.

**Done when:** a local Express route answers `402`, a fetch client pays it automatically, the
route serves the data, and the in-memory ledger shows the commitment. Tests cover the failure
cases.

## Phase 2: Facilitator + PayPal settlement (Oct 20–26)

Goal: commitments turn into real PayPal sandbox charges, safely.

- [x] `packages/paypal-client`:
  - OAuth with a cached token.
  - Vault v3: create a setup token, exchange it for a payment token, get and delete tokens.
  - Orders v2: create and capture with `vault_id`. Use `PayPal-Request-Id` for idempotency.
  - Typed errors for `AGREEMENT_ALREADY_CANCELLED` and `TOKEN_NOT_FOUND`.
  - Webhook signature verification.
- [x] `apps/facilitator` (Express + SQLite):
  - Data model: operators, agents (public keys), wallets (`vault_id`, status), caps, commitments,
    settlements, audit log.
  - x402 facilitator HTTP endpoints (`/verify`, `/settle`, `/supported`) backed by
    `scheme-paypal`.
  - Link flow: start → PayPal approval URL → return → payment token stored.
  - Caps: per call, per day, total, and the **unsettled cap**.
  - Settlement job: settle when the unsettled cap is reached, and once a day. Charge exactly the
    sum of unsettled commitments, never more.
  - Revocation:
    - On `AGREEMENT_ALREADY_CANCELLED` or `TOKEN_NOT_FOUND`, the wallet becomes revoked and all of
      its agents get `402`.
    - The `VAULT.PAYMENT-TOKEN.DELETED` webhook does the same immediately.
  - Port the earlier event bus, webhook signer, and audit helpers where they save time.
- [x] Sandbox integration script (`apps/facilitator/scripts/sandbox-e2e.ts`): link a wallet, make N
  paid calls, check that settlement creates one PayPal order equal to their sum, revoke, then
  check the next call is refused.
  - **PASS on the real sandbox, 2026-10-16:** 3 × 5-cent calls were settled as one 15-cent capture.
  - After the payer stopped the agreement in Autopay, the health check marked the wallet
    `stopped_by_payer`, and the next call got `402 invalid_batch_settlement_paypal_wallet_revoked`.

**Done when:** the integration script passes against the real sandbox, and the PayPal sandbox
Business account shows the settlement capture.

## Phase 3: Demo seller + AI agent (Oct 26–Nov 1)

Goal: the story the judges will watch. An AI agent finds paid APIs, decides what is worth paying
for, pays, and explains its spending.

- [x] `apps/demo-seller`: four paid APIs that are genuinely useful to an agent, priced in
  cents.
  - Candidates: a market-data lookup, a web page summary, a translation or extraction endpoint.
  - Pick the ones that make the clearest story.
  - Each one is a small Express route behind `@x402/express` with the PayPal scheme.
- [x] `apps/agent`: a Claude agent (load the `claude-api` skill first) using tool use.
  - Tools: list services and their prices, call a paid API with the x402 client (`@x402/core`),
    seeing the price before paying, check the remaining budget.
  - It plans within a budget, pays, finishes the task, and returns a spend report.
  - CLI first.
- [x] MCP server so any MCP client can pay through PayPer402. Check `@x402/mcp` before writing our
  own. Keep pay tools injection-safe: they accept server-issued ids only, never free-form amounts
  or recipients.

**Done when:** one command runs the full story against local services. The transcript shows the
agent choosing within its budget, the ledger matches the calls, and a settlement charges the
sandbox wallet.

- **PASS on the real sandbox, 2026-10-16** (`npm run demo -- --link`, Claude Sonnet 5.5):
  - The agent paid for a quote, a summary and a translation (3 calls, $0.08) and skipped
    Premium News ($0.25, above the $0.10 per-call limit).
  - The ledger matched the 3 commitments, and one PayPal order captured exactly $0.08.
- Carried into Phase 4: tune the agent's system prompt (design spec §6.2), so the timeline gets
  a short "thinking" note before the first call and the spend explanation stays in English
  whatever the task's language. This is a spec change and goes through review.

## Phase 3.5: Decision layer with Jev (Oct 16–22)

Goal: before the agent signs a payment, Jev (TypeSafe's System One model) judges whether the
call serves the task and whether its result is already in hand. Code decides with fixed
thresholds. This is a supporting feature, never the headline; the budget and caps stay the hard
guards. The design is in `docs/spec/decision-layer.md`.

- [x] **Jev spike (`spikes/jev-check/`, 2026-10-16).** `@typesafe-ai/sdk` 0.7.0 and `jev-1.14.0`
  work as the spec needs. Its findings are folded into draft 2 of the design spec.
- [x] Design spec `docs/spec/decision-layer.md` passes review. It passed in round 3 (draft 4) on
  2026-10-16.
- [x] Build spec `docs/phase-3.5/BUILD_SPEC.md` passes review. It passed in round 2 (draft 2) on
  2026-10-16, with the design review's two notes folded into Milestone 5.
- [x] `apps/agent`:
  - the `SpendCheck` interface and its Jev implementation, pinned to `jev-1.14.0`
  - the call registry, with the exact-duplicate and repeat rules
  - the policy with per-rule modes, the payer-owned deadline, and fail-open
- [x] Events, report, CLI and demo changes; the agent.md amendments (design spec §9).
- [x] The evaluation script (`npm run eval:spend-check -w apps/agent`) on both `jev-1.14.0` and
  `jev-1.13.0`. The wording, thresholds, modes and pin are recorded in the spec.

**Done when:**

- The evaluation procedure (design spec §7.3) has run on both models, and its results are recorded.
  If no rule meets the bar, the layer ships with both rules in observe mode, as the spec allows.
- `npm run demo` against the real sandbox shows a Jev check on every paid call.
- With the layer off (no key, or `--no-spend-check`), every Phase 3 test and behaviour is
  unchanged.
- The audit passes.

- **PASS on the real sandbox, 2026-10-16** (`npm run demo`, Claude Sonnet 5.5, `jev-1.14.0`):
  - Three paid calls: quote, summary and the Vietnamese translation. Their Jev checks passed with
    serves task 0.96, 0.93 and 0.91, and covered 0.01, 0.03 and 0.03.
  - Nothing was blocked, flagged or unavailable.
  - The ledger matched the 3 commitments, and one PayPal order captured exactly $0.08.
- The eval's recorded run enforces both rules at 0.50, and the audit passed in round 2. There are
  707 tests (586 in Phase 3).

## Phase 4: Web app + AG Studio dashboards (Nov 1–6)

Goal: a complete product a judge can use without a terminal.

- [x] **AG Studio spike (`spikes/ag-studio/`, 2026-10-17).** The Overview mockup was rebuilt with
  Next 16 and AG Studio 3.0.0, with the theme taken from the design tokens and Claude behind a
  server route. The findings are in the spike README.
- [x] The UI design is frozen in `docs/design/` (canvas version `1792213018-362b`).
- [x] Design spec `docs/spec/web-app.md` passes review. It passed in round 3 (draft 3) on
  2026-10-17.
- [x] Build spec `docs/phase-4/BUILD_SPEC.md` passes review. It passed in round 3 (draft 3) on
  2026-10-17.
- [x] Facilitator additions: a demo-operator admin route, usage counts and a block reason. Agent
  prompt: a plan note before the first call, and an English spend explanation (the Phase 3
  carry-over).
- [x] `npm run dev:stack` runs the facilitator, the demo seller and the web app with one command.
- [x] `apps/web` (Next.js). The build passed audit in round 2 (2026-10-17):
  - Landing page that explains PayPer402 in one screen.
  - Operator onboarding: demo sign-in (each visitor gets their own demo operator), link PayPal,
    set caps, create an agent key.
  - Operator dashboard (AG Studio): spend per agent, per API and per day; settlements; wallet
    status, including revoked.
  - Seller dashboard (AG Studio): revenue per endpoint and settlement status.
  - AG Studio AI assistant through an Anthropic adapter. It calls a server route, and the key
    never reaches the browser.
  - A "run the demo agent" button, so judges can watch the agent spend live.
- [x] Fixes after the second local run (build spec Milestone 11, 2026-10-18). The specs passed
  review in round 2, and the build passed audit in round 1:
  - several operators can share one PayPal payment token
  - a link resumes from `VAULTED`
  - "Check again" asks PayPal
  - `dev:stack` keeps its session secret across restarts
- [x] Fixes after the first local run (design spec draft 4, 2026-10-17), on the quick spec → build
  path the user chose:
  - a light/dark toggle on Live run
  - the AG Studio licence banner in development
  - assistant query reliability
  - an English default task and Markdown in reports
  - the hero pause control
  - the PayPal logo in the hero
- [ ] *Optional, parallel:* request the AG Studio 45-day trial between Nov 1 and 3 for a
  watermark-free video. It is not required for judging, and it carries over.

**Done when:** the whole flow works in a browser with a sandbox Personal account: link, cap, run
the agent, see spend, revoke, and see the agent blocked.

- **PASS on the real sandbox, 2026-10-18** (`npm run dev:stack`, Claude Sonnet 5.5), run in the
  user's browser:
  - **First operator (2026-10-17):** linked, capped and ran the agent. "Charge now" captured
    exactly $0.23 for its 8 paid calls, and the payment shows in both sandbox accounts.
  - **Second demo operator (2026-10-18):** linked with the same sandbox Personal account and
    shares its payment token. It ran research-bot for 2 paid calls ($0.07).
  - **Revocation:** after "Stop paying with PayPal", the health check revoked both operators in
    the same second. The Overview showed "Stopped by payer" and the agent as blocked.
  - **Not collected:** the second operator's 2 uncharged calls became `uncollectable` ($0.07),
    as the credit-risk design expects.

## Phase 4.5: Operator CLI (Oct 27–Nov 1)

Goal: an operator connects an agent from a terminal in one step, and any MCP client (Claude Code,
Claude Desktop) can then pay per call through PayPer402. The agent's private key is generated on
the agent's machine and never leaves it. The design is in `docs/spec/operator-cli.md`.

Inserted on 2026-10-27, at the user's request. It must not delay Phase 5: if it slips past Nov 1,
cut `run` and the web polish first.

- [x] Design spec `docs/spec/operator-cli.md` passes review, with its amendments to
  `facilitator.md`, `web-app.md` and `agent.md`. It passed in round 2 (draft 2) on 2026-10-27.
- [x] Build spec `docs/phase-4.5/BUILD_SPEC.md` passes review. It passed in round 2 (draft 2) on
  2026-10-27, with the review's notes folded in.
- [x] Facilitator: claim codes (issue and redeem), the agent-signed status endpoint, and
  migration 3.
- [x] Web: "Connect from a terminal" in onboarding step 3 and in the Agents drawer.
- [x] `apps/agent`: the `payper402` command with `onboard`, `status`, `mcp`, `run`, `help` and
  `version`, and the local config file.
- [x] README section: link the command from the clone (`npm link`) and add it to Claude Code.

**Done when:**

1. The web app issues a claim code and shows the full `payper402 onboard` command.
2. `payper402 onboard --claim <code>` registers a new agent. Only its public key reaches the
   facilitator.
3. `payper402 status` shows the agent, the caps, today's spend and the wallet status.
4. A Claude Code session with `payper402 mcp` makes a paid call that appears on the dashboard
   under the new agent.
5. After "Stop paying with PayPal", `payper402 status` shows the wallet stopped and the next paid
   call is refused.
6. `npm run typecheck`, `npm test` and the private pre-commit checks pass. Every existing test
   passes without being edited, except the schema-version literals in
   `apps/facilitator/src/foundation.test.ts` named in the build spec.
7. The audit passes.

**PASS on the real sandbox, 2026-11-05.** The operator onboarded `testcli` with a web claim
code. Claude Code called the Market Quote API for `KC` over MCP. The dashboard showed one
paid call for $0.02 awaiting settlement. After the payer stopped the agreement in PayPal,
`payper402 status` showed "PayPal stopped by the payer" and the next quote (`CC`) returned
`wallet_revoked`. The agent's recorded spend stayed at $0.02 in one call.

## Phase 5: Hosting + hardening (Nov 6–9)

Goal: a public demo that keeps working through judging (Dec 1–15) with nobody watching it.

- [ ] Choose a host and deploy the facilitator, web app, demo seller and agent runner with public
  HTTPS.
- [ ] Register the PayPal sandbox webhook URL and verify signatures in production.
- [ ] Seed demo data so dashboards are never empty.
- [ ] Rate limits, input validation, and friendly error and empty states.
- [ ] Security pass: secrets only in env, sandbox guard, and no key in the browser. Set
  `FACILITATOR_TRUST_PROXY=1` behind the host's proxy (operator-cli.md §9.3).
- [ ] README: what it is, architecture diagram, local setup, and how to run the demo.
- [ ] Uptime check that keeps the demo alive until Dec 15. It includes one Jev request, so a
  withdrawn model or an exhausted key shows up (decision-layer spec §5).
- [ ] A TypeSafe API key of PayPer402's own for the hosted demo.

**Done when:** a fresh browser session on the public URL completes the Phase 4 flow, and the
README setup works from a clean clone.

## Phase 6: Submission (Nov 9–11)

- [ ] Demo video under 3 minutes:
  - the problem
  - link once
  - the agent pays per call
  - one PayPal charge
  - the dashboards
  - **"Stop paying with PayPal" blocks the agent**
  - the binding spec
- [ ] Devpost write-up: features, PayPal APIs used, AI usage, architecture, and the x402 binding
  story. Disclose reused components if the rules require it.
- [ ] Testing instructions with sandbox test accounts. These go in the Devpost form only, never in
  the repo.
- [ ] Final checks:
  - the repo is public
  - the license is present
  - no secrets in git history
  - the private pre-commit checks pass
  - the hosted demo is up
- [ ] Submit on Nov 11.

**Done when:** Devpost shows the submission as complete.

## Stretch (only after Phase 6 is submittable)

- PayPal Payouts to several sellers.
- An `auth-capture` binding mapped to Orders `intent=AUTHORIZE`.
- A PYUSD on-chain path as a second network.
- AP2 mandate support on top of the x402 flow.

## Open questions

- Official rules text: the reuse of existing code, and the AG Studio prize criteria.
- Hosting provider: it needs HTTPS, a persistent disk for SQLite, and must stay free through
  Dec 15.
