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

**Current phase: Phase 3**

- Phase 1 passed its final audit on 2026-10-15.
- Phase 2 passed its audit on 2026-10-16, and its sandbox end-to-end run passed the same day.

## Overview

| Phase | Dates | Goal | Main judging criteria |
|---|---|---|---|
| 0. Foundation | Oct 15–16 | Repo, tooling, PayPal vault proven on sandbox | — |
| 1. x402 binding | Oct 16–20 | Paid HTTP calls work through the official x402 SDK on `paypal:sandbox` | Innovation, Tech |
| 2. Facilitator + PayPal settlement | Oct 20–26 | Signed commitments become real PayPal sandbox charges | Tech, Impact |
| 3. Demo seller + AI agent | Oct 26–Nov 1 | An LLM agent shops for paid APIs within a budget | Tech (AI), Innovation |
| 4. Web app + AG Studio dashboards | Nov 1–6 | Judges can do everything in a browser | Design, AG Studio prize |
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

## Phase 4: Web app + AG Studio dashboards (Nov 1–6)

Goal: a complete product a judge can use without a terminal.

- [ ] `apps/web` (Next.js):
  - Landing page that explains PayPer402 in one screen.
  - Operator onboarding: demo sign-in, link PayPal, set caps, create an agent key.
  - Operator dashboard (AG Studio): spend per agent, per API and per day; settlements; wallet
    status, including revoked.
  - Seller dashboard (AG Studio): revenue per endpoint and settlement status.
  - AG Studio AI assistant through an Anthropic adapter. It calls a server route, and the key
    never reaches the browser.
  - A "run the demo agent" button, so judges can watch the agent spend live.
- [ ] *Optional, parallel:* request the AG Studio 45-day trial between Nov 1 and 3 for a
  watermark-free video. It is not required for judging.

**Done when:** the whole flow works in a browser with a sandbox Personal account: link, cap, run
the agent, see spend, revoke, and see the agent blocked.

## Phase 5: Hosting + hardening (Nov 6–9)

Goal: a public demo that keeps working through judging (Dec 1–15) with nobody watching it.

- [ ] Choose a host and deploy the facilitator, web app, demo seller and agent runner with public
  HTTPS.
- [ ] Register the PayPal sandbox webhook URL and verify signatures in production.
- [ ] Seed demo data so dashboards are never empty.
- [ ] Rate limits, input validation, and friendly error and empty states.
- [ ] Security pass: secrets only in env, sandbox guard, and no key in the browser.
- [ ] README: what it is, architecture diagram, local setup, and how to run the demo.
- [ ] Uptime check that keeps the demo alive until Dec 15.

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
