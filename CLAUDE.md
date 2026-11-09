# PayPer402

**Pay-per-call for AI agents. Settled with PayPal.**

PayPer402 lets an AI agent pay for APIs one call at a time over HTTP 402 (the x402 protocol) while
the money moves through PayPal instead of crypto. The agent's operator links a PayPal account once
and sets a spending cap. After that the agent can call any PayPer402-enabled API: the API answers
`402 Payment Required` with a price, the agent signs a payment commitment, and the call goes
through. Commitments are summed and charged to the saved PayPal account in one batch (for example
daily), because PayPal's fixed per-transaction fee makes per-cent charges impossible. Sellers add
middleware to their API and get paid in PayPal without touching crypto.

Think of it as electronic toll collection for APIs: link once, drive through, get billed once.

This is an entry for the **PayPal AI Hackathon** (paypalaihackathon.devpost.com). Every decision
should serve that brief. Read the constraints below before proposing features.

## Hackathon constraints (non-negotiable)

- **Deadline: 2026-11-12, 12:00 PT** (about 03:00 on 2026-11-13 in Vietnam). Sources disagree
  between 12:00 and 14:00 PT, so plan for 12:00.
- The project must **meaningfully use PayPal** (APIs/SDKs on the **sandbox**) **and AI**.
- It must **work**. Judges must be able to run it or use a hosted version. Mockups and slides
  do not count. The hosted demo must stay free and accessible through **Dec 15, 2026** (end
  of judging).
- Submission needs:
  - a public GitHub repo with an OSS license and setup instructions
  - a demo video under 3 minutes on YouTube
  - a written description
  - testing instructions, including sandbox test accounts. These go in the Devpost form, never
    in the repo.
- Judging uses five equally weighted criteria. Check every feature against them:
  1. **Technological implementation:** real, non-trivial use of PayPal and AI.
  2. **Design:** a complete, coherent product, not just a tech demo.
  3. **Potential impact:** it matters to users or businesses.
  4. **Innovation:** originality.
  5. **Presentation:** a clear explanation and demo.

## Scope guardrails

In scope:

- An **x402 v2 network binding for PayPal**: network id `paypal:sandbox`, asset `USD`, scheme
  `batch-settlement` (credit-backed), implemented as plug-ins for the official `@x402/core` SDK
  (client, resource server, and facilitator scheme interfaces).
- A facilitator service. It verifies signed commitments, keeps the commitment ledger, enforces
  caps, settles batches by charging the saved PayPal account, and handles webhooks.
- Operator onboarding: link PayPal once (Vault v3 setup token, then payment token) and set caps.
- A demo seller: two or three paid APIs behind `@x402/express` middleware.
- **An LLM agent as the protagonist of the demo.** It reads 402 prices, picks paid APIs within a
  budget, pays, finishes the task, and explains what it spent.
- A **decision layer** (Phase 3.5, added at the user's request on 2026-10-16). Before the agent
  pays, Jev (TypeSafe) gives a calibrated second opinion on the call, and code decides. It is a
  supporting feature, never the headline. See `docs/spec/decision-layer.md`.
- An **operator CLI** (Phase 4.5, added at the user's request on 2026-10-27): the `payper402`
  command. It joins an agent with a claim code from the web app (the key is generated locally),
  shows the agent's status, and runs the MCP server and the agent. Operator powers (linking,
  caps, unlinking) stay in the web app. See `docs/spec/operator-cli.md`.
- Dashboards (AG Studio):
  - operator view: spend per agent, per API, and per day
  - seller view: revenue per endpoint and settlement status
- A spec document for the PayPal binding, written in the style of the x402 scheme specs.

Out of scope (do not drift here):

- Crypto rails as the core. A PYUSD on-chain path is a stretch goal only, after everything above
  works.
- Virtual or simulated cards.
- A spend-policy or guardrails engine as the headline. Caps and approvals are supporting
  features; other entries already lead with them.
- Live PayPal (production) credentials. **Sandbox only.**
- Building our own LLM, wallet, or blockchain.

## Payment design

1. **Link (once, human present).**
   - `POST /v3/vault/setup-tokens` with `payment_source.paypal`, `usage_type: MERCHANT` and
     `usage_pattern: UNSCHEDULED_POSTPAID` (verified on sandbox).
   - The payer approves the link. Then `POST /v3/vault/payment-tokens` returns a `vault_id`.
   - The operator sets caps (per call, per day, total).
2. **Call (many times, no human).**
   - The API returns 402 with `PaymentRequirements`: scheme `batch-settlement`, network
     `paypal:sandbox`, asset `USD`, and an amount.
   - The agent signs a commitment with its Ed25519 key and retries with the `PAYMENT-SIGNATURE`
     header.
   - The facilitator verifies the signature, the caps and replay protection, and records the
     commitment. The API serves the response.
3. **Settle (batched, no human).**
   - On a schedule or a threshold, the facilitator creates one Orders v2 order with
     `payment_source.paypal.vault_id`, captures it, and marks the covered commitments as settled.
   - **Never charge more than the sum of signed, unsettled commitments, and never more than the
     caps.** x402 forbids moving funds beyond the payer's intent.
   - Passing `stored_credential` (`payment_initiator: MERCHANT`) is optional: charges succeeded
     with and without it.
4. **Revocation (the payer can stop at any time).**
   - The payer can cancel the agreement from their PayPal account ("Stop paying with PayPal").
     After that, a charge returns `422 AGREEMENT_ALREADY_CANCELLED`, and the payment token is
     deleted (`404 TOKEN_NOT_FOUND`).
   - On either error, mark the operator's wallet as revoked, and answer every further request from
     their agents with `402`.
   - PayPal keeps one agreement per payer and merchant. Linking the same PayPal account to a
     second operator returns the same payment token (seen on sandbox, 2026-10-18). So a
     revocation stops every operator holding that token, and an unlink deletes the token only
     when no other operator still uses it.
   - Subscribe to the `VAULT.PAYMENT-TOKEN.DELETED` webhook, so revocation is noticed immediately
     and not at the next settlement.
5. **Credit risk and the unsettled cap.**
   - The postpaid model means the facilitator extends credit. Usage that is not yet settled when
     the payer revokes cannot be collected.
   - So every operator or agent has an **unsettled cap** (for example $5). When unsettled
     commitments reach it, settle immediately; if settlement fails, stop serving.
   - The same threshold drives batching. It keeps the fee per charge reasonable and bounds the
     loss.
6. **Pay out (optional).** Use PayPal Payouts to pay sellers if the demo has more than one seller.

Demo scene worth filming: the operator clicks "Stop paying with PayPal" in their PayPal account,
and the agent's next paid call is refused at once.

Why batch: US PayPal fees are about 3.49% + $0.49 per checkout transaction, and micropayment
pricing (4.99% + $0.09) needs approval. One charge per call is not viable; one charge per day is.

The vault spike passed, so the prepaid-balance fallback is not needed. It remains an option
(prepay through a normal Checkout order, and draw the ledger down per call) if live-account
eligibility ever becomes an issue.

## Roadmap

The phased build plan is in `docs/ROADMAP.md`. Read it at the start of each session, work on the
**Current phase**, tick tasks as they land, and move the marker when a phase's "Done when" check
passes. Do not start work from a later phase without asking.

## Development process (every phase)

1. **Spec.** The main session writes the specs:
   - a protocol or design spec under `docs/spec/`, if the phase has one
   - a build spec at `docs/phase-N/BUILD_SPEC.md`
2. **Review loop.** An independent reviewer (Claude Fable 5.1) reviews the specs against the
   code, the SDKs and this file.
   - If the verdict is anything other than a clean **PASS**, rewrite the specs and send them back
     to review.
   - **Repeat until the reviewer returns PASS.** Fixing the findings yourself and going straight
     to build is not allowed.
3. **Build.** A builder (Claude Opus 5.5, high effort) implements the passed build spec. It does
   not commit or push.
4. **Audit loop.** The reviewer audits the implementation.
   - If the verdict is anything other than a clean **PASS**, the builder fixes the findings and
     the work goes back to audit.
   - **Repeat until the auditor returns PASS.** Fixes made after an audit are always re-audited.
5. **Verify and commit.**
   - The main session re-runs typecheck, tests and the private pre-commit checks itself.
   - It proposes commits grouped by concern, and commits only when the user says so.
6. **Close the phase.** Move the roadmap marker only after the audit has passed.

## Status and open gates

Update this section as gates close.

- [x] **Vault spike (passed on sandbox, 2026-10-15).** The script is in `spikes/vault-charge/`.
  - Save once, then charge many times with no payer present, under `IMMEDIATE`: $1.00 and $2.50.
  - The same under `UNSCHEDULED_POSTPAID`: $1.00, $2.50 and $0.75, with and without
    `stored_credential`.
  - Payer revocation: after revoking, charges fail with `AGREEMENT_ALREADY_CANCELLED` and the token
    with `TOKEN_NOT_FOUND`. This is the expected outcome, even though the script prints "FAIL".
  - The app's token has the `vault/payment-tokens/readwrite` and `billing-agreements` scopes.
  - Sandbox credentials live in the root `.env`, which is gitignored and shared by all apps.
- [x] **x402 plug-in spike (passed, 2026-10-15).** A fake-settle scheme on network
  `paypal:sandbox` runs end to end through `@x402/express` and `@x402/fetch` (2.28.0). The test
  is `packages/scheme-paypal/src/plumbing.test.ts`; findings are in `docs/phase-1/BUILD_SPEC.md`.
- [x] **Jev spike (passed, 2026-10-16).** The script is in `spikes/jev-check/`.
  - `@typesafe-ai/sdk` 0.7.0 works with `jev-1.14.0`. That is the `jev-preview` build; `jev-latest`
    is still `jev-1.13.0`.
  - From Vietnam, a check takes about 300 ms at the median and 1.1–1.6 s at p95, and costs about
    $0.00004.
  - No false blocks on the demo sequence. The draft 1 thresholds catch nothing on 1.14, so the
    thresholds must come from the Phase 3.5 eval.
  - SDK timeouts apply per attempt, with no total budget. The findings are in the spike README
    and in `docs/spec/decision-layer.md`.
- [x] **AG Studio spike (passed, 2026-10-17).** The app is in `spikes/ag-studio/`, and its README
  holds the findings.
  - Next 16.4.2 with `ag-studio` 3.0.0 works in one `'use client'` file and builds for
    production. The client bundle is about 1.5 MB gzipped, so load Studio only on dashboard
    routes.
  - Theme params set from the design tokens get close to the mockup. Grid cells take React
    renderers, which is how the status badges are drawn.
  - The AI panel works in view mode only through a cast that the types do not allow
    (`panels.view.right = ['ai']`). Use it with a read-only analyst agent. The fallback is edit
    mode with only the AI panel.
  - Claude runs behind a server route that replays Claude's own turns, so thinking blocks
    survive. Each turn took 0.9 to 2.7 s on the spike's sample data.
- [x] **AG Studio license (not a blocker).**
  - The sponsor answered on the hackathon Discord (Oct 2026): without a key AG Studio shows a
    watermark and a console error, and this is **not penalised in judging**.
  - Build without a key. Optionally request the 45-day trial around Nov 1–3, only for a
    watermark-free demo video.
  - Read the key from `AG_STUDIO_LICENSE_KEY` if one is set. Never commit it. The app must work
    with no key.
- [ ] **Official rules text.** Confirm the rules on reused or pre-existing code and the sponsor
  prize criteria.
- [ ] **Hosting** for the facilitator, web app, and demo seller, with public HTTPS for PayPal
  webhooks.

## Tech stack

- **TypeScript** everywhere, on Node.js 24 LTS (22+ supported), in an npm workspaces monorepo.
  - Workspace packages export their TypeScript sources directly (`"exports": "./src/index.ts"`),
    and apps run them with `tsx`.
  - Commands: `npm run typecheck` and `npm test` (Vitest, root `vitest.config.ts`).
  - x402 types come from subpaths, for example `import type { Network } from '@x402/core/types'`.
- **x402:** `@x402/core`, `@x402/express`, `@x402/fetch` (Apache-2.0). Check `@x402/mcp` before
  writing our own MCP server.
- **PayPal:** REST APIs called with plain `fetch` through a small typed client: OAuth, Vault v3,
  Orders v2, Webhooks, and optionally Payouts. `@paypal/agent-toolkit` and `@paypal/mcp` are
  optional.
- **AI:** `@anthropic-ai/sdk`. The model comes from `ANTHROPIC_MODEL` (default
  `claude-opus-5-5`). Load the `claude-api` skill before writing any Claude code; current API
  details differ from older patterns.
- **Decision layer:** `@typesafe-ai/sdk`, pinned at `0.7.0`, with the model pinned by id
  (`jev-1.14.0`). Load the `typesafe:typesafe-ai` skill and read the live TypeSafe docs before
  writing Jev code.
- **Backend:** Express, SQLite via `better-sqlite3`, and `zod` for validation.
- **Web:** Next.js with React and Tailwind CSS v4.
- **Dashboards:** `ag-studio` with `ag-studio-react` (v3). The key goes in through
  `<AgStudioProvider licenseKey={...}>`.
  - AG Studio API reference: `https://www.ag-grid.com/studio/llms.txt`. Fetch it before writing
    AG Studio code.
  - The `ag-mcp` MCP server, if configured, covers only the underlying AG Grid and AG Charts APIs,
    not AG Studio.
  - The in-app AI assistant should use Anthropic, through the same key as the agent. AG Studio
    calls the LLM through an `AgLlmAdapter` (type from `ag-studio`) in the browser. Point it at
    our own server route, which adds the API key; never ship the key to the browser.
  - Reference implementation: `github.com/paypaldev/hackathon-paypal-ag-grid-boilerplate` (the
    official sponsor boilerplate, with Next.js 16, `ag-studio` 3.0.0 and an OpenAI adapter). It has
    **no license**, so read it for patterns only and do not copy its code. The adapter example in
    the AG Studio docs is meant to be copied.
- **Tests:** `vitest`. Every PayPal call is mockable; the real sandbox is exercised by explicit
  integration scripts only.

Planned layout (create packages as they are needed, not up front):

```
packages/scheme-paypal   x402 binding: client, server and facilitator plug-ins for paypal:sandbox
packages/paypal-client   typed PayPal REST client (OAuth, Vault v3, Orders v2, Webhooks)
apps/facilitator         verify, settle, ledger, caps, webhooks, settlement job
apps/web                 onboarding, operator and seller dashboards (AG Studio)
apps/demo-seller         sample paid APIs behind @x402/express
apps/agent               demo LLM agent (Claude) paying through @x402/fetch, plus an MCP server
docs/                    binding spec, architecture, demo script
```

## Conventions

- **English only in the repo:** code, identifiers, comments, log and error messages, UI copy,
  docs, and commit messages. Talk to the user in **Vietnamese**.
- **Commits** follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`), with
  short imperative English titles. Commit only when asked.
- **Sandbox only.** Any PayPal client must refuse the live API host
  (`api-m.paypal.com`).
- **Secrets** live in environment variables. Never commit `.env*` (except `.env.example`), keys,
  `*.db`, vault state files, or sandbox account credentials.
- **Trademark.** The product is PayPer402. Mention "PayPal" only factually (for example "settled
  with PayPal").
  - The official PayPal logo may appear only to show PayPal as the payment rail, for example the
    settlement step in the landing hero (user decision, 2026-10-17).
  - Use it unaltered: no recolouring, cropping or distortion, and with clear space.
  - Never use it as PayPer402's own branding, never in a way that implies PayPal endorses the
    product, and never imitate PayPal's visual identity (its colours, wordmark styling or
    buttons).
- **No dead weight.** Do not add chain-specific code, unused dependencies, or features outside
  the scope above. If something seems worth adding, ask first.
- Before declaring a change done: run typecheck and tests, and run the pre-commit checks listed
  in `CLAUDE.local.md`, if present (untracked, holds the developer's private notes).

