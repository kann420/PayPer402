# PayPer402

**Pay-per-call for AI agents. Settled with PayPal.**

PayPer402 lets an AI agent pay for APIs one call at a time over HTTP 402 (the
[x402 protocol](https://github.com/x402-foundation/x402)), while the money moves through PayPal
instead of crypto. Think of it as electronic toll collection for APIs: link once, drive through,
get billed once.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com) (October–November 2026).

- **Live demo:** <https://payper402.xyz> (PayPal sandbox, test money only). The sandbox test
  accounts are in the testing instructions on Devpost.
- **Demo video:** _link coming soon_
- **Proof it settles on PayPal:** [see below](#proof-it-settles-on-paypal)
- **Binding spec:** [docs/spec/scheme_batch_settlement_paypal.md](docs/spec/scheme_batch_settlement_paypal.md)
- **How it meets the judging criteria:** [see below](#judging-criteria)

## The problem

AI agents increasingly need to buy things on their own: a hotel rate, a review summary, a
walking time. Each one is worth a few cents. Today an agent cannot pay a few cents per call:

- API subscriptions and prepaid keys need a human to sign up for every provider in advance.
- Card and wallet checkouts need a human in the loop for every purchase.
- A per-call charge is impossible anyway: a fixed fee per transaction is larger than the call.

x402 solves the first two with `402 Payment Required`, but it settles on a blockchain. Most
operators and API sellers do not want to hold stablecoins; they already have PayPal.

## How it works

1. **Link once (a human is present).** The operator links a PayPal account with the PayPal Vault
   v3 API (`usage_pattern: UNSCHEDULED_POSTPAID`) and sets caps: per call, per day, total, and an
   unsettled cap.
2. **Pay per call (no human).** A paid API answers `402 Payment Required` with a price. The agent
   signs a payment commitment with its Ed25519 key and retries. The facilitator verifies the
   signature, the caps and replay protection, records the commitment, and the API serves the
   response.
3. **Settle in one charge (no human).** Commitments are added up and charged to the saved PayPal
   account in one PayPal Orders v2 capture, when the unsettled cap is reached or once a day. The
   charge is never more than the sum of signed, unsettled commitments.
4. **Stop at any time.** The payer can click "Stop paying with PayPal" in their PayPal account.
   The facilitator notices (webhook, health check or the next charge) and the agent's next paid
   call is refused at once.

## What is in the box

- **An x402 network binding for PayPal.** Network `paypal:sandbox`, asset `USD`, scheme
  `batch-settlement`, written as plug-ins for the official `@x402/core` SDK (client, resource
  server and facilitator). Sellers use the stock `@x402/express` middleware; nothing is forked.
  The protocol is specified in
  [docs/spec/scheme_batch_settlement_paypal.md](docs/spec/scheme_batch_settlement_paypal.md), in
  the style of the x402 scheme specs.
- **A facilitator.** It verifies commitments, keeps the ledger, enforces caps, settles batches with
  PayPal, and handles revocation.
- **A Claude agent as the protagonist.** It reads 402 prices, decides what is worth paying for
  within a budget, pays, finishes the task, and explains what it spent.
- **A decision layer.** Before each payment, Jev (TypeSafe) gives a calibrated second opinion: does
  this call serve the task, and is its result already in hand? Code decides with fixed thresholds.
- **A web app.** Demo sign-in, PayPal onboarding, caps, a live view of the agent spending, and
  operator and seller dashboards built with AG Studio, with a read-only Claude analyst inside.
- **A terminal command and an MCP server.** `payper402 onboard` connects an agent with a claim code
  from the web app. The agent's key is generated locally and never leaves the machine.
  `payper402 mcp` lets Claude Code or Claude Desktop pay per call through PayPer402.
- **A demo seller.** "Acme Data" sells five paid travel APIs, priced from 1 to 25 cents. Its hotel data
  and reviews are simulated and labelled as such in every response; the payments for them are real
  sandbox payments.

## Judging criteria

Every feature was checked against the hackathon's five criteria before it was built.

| Criterion | Where PayPer402 does it |
|---|---|
| **Technological implementation** | **PayPal:** five APIs work together: OAuth, a one-time Vault v3 link (`UNSCHEDULED_POSTPAID`), Orders v2 captures with no payer present (idempotent with `PayPal-Request-Id`) that can be read back from Payments v2 to verify them, and Webhooks plus PayPal's own error codes for revocation ([`packages/paypal-client`](packages/paypal-client/src/client.ts), [`apps/facilitator`](apps/facilitator/src/services/settlements.ts)). **AI:** a Claude agent with tool use decides what to buy ([`agent.ts`](apps/agent/src/agent.ts)), Jev checks every payment ([`jev.ts`](apps/agent/src/jev.ts)), Claude analyses the AG Studio dashboards, and Claude powers the seller's paid APIs. **x402:** plug-ins for the official `@x402/core` SDK, no fork ([`packages/scheme-paypal`](packages/scheme-paypal/src)). The full flow passed end to end on the real PayPal sandbox; more than 1,000 tests. |
| **Design** | One product for three people: the **operator** (web app: link PayPal, set caps, manage agents, watch spending, charge, see a stopped link), the **seller** (revenue per endpoint, settlement status) and the **developer** (the `payper402` command and an MCP server for Claude Code and Claude Desktop). The unhappy paths are designed too: empty states, declined charges, a link stopped by the payer, paused and blocked agents. Live run shows each step and ends with a plain-English spend report whose numbers come from the ledger, never from the model ([`apps/web`](apps/web/src/components)). |
| **Potential impact** | **Who:** teams whose AI agents need to buy data and tools on their own, and API sellers who want per-call revenue without crypto or a sign-up wall. **Why:** with a fixed fee of about $0.49 per US PayPal checkout transaction, charging a 2-cent call on its own would cost about 25 times the call. Batching signed commitments into one charge pays that fee once per batch. **Control:** caps per call, per day and in total, an unsettled cap that bounds credit, and "Stop paying with PayPal" blocking the agent on its next call, shown in the demo. |
| **Innovation** | **A PayPal rail for x402.** x402 normally settles on a blockchain, and existing fiat approaches charge cards. PayPer402 defines an open x402 network binding for the PayPal wallet (`paypal:sandbox`, scheme `batch-settlement`), written in the style of the x402 scheme specs ([binding spec](docs/spec/scheme_batch_settlement_paypal.md)). **Postpaid micro-commitments** make cent-level pricing work on a rail with fixed fees, with credit risk bounded by design. **A second opinion before paying:** a separate calibrated model checks each call, and code makes the final decision. |
| **Presentation** | **Demo video:** _link coming soon_. One story: the problem, link once, the agent pays per call, one PayPal charge, the dashboards, and "Stop paying with PayPal" blocking the agent. Judges can try it on the hosted demo at <https://payper402.xyz>, or replay the same story locally in seven steps ([Run it locally](#run-it-locally)). |

## Sponsor prize

| Prize | Requirement | Status | Where PayPer402 does it |
|---|---|---|---|
| **Best Use of AG Grid** | Use AG Grid's tools in a project that meaningfully uses PayPal and AI | Entered | **AG Studio** (`ag-studio` and `ag-studio-react` 3.0.0) is the analytics layer of the product, not a side page. It powers the operator Overview (spend per agent, per API and per day), agent detail, the calls behind each PayPal charge, and the seller console (revenue per endpoint and settlement status) ([`paid-calls-studio.tsx`](apps/web/src/components/studio/paid-calls-studio.tsx)). It is themed from PayPer402's design tokens, and grid cells use React renderers for the status badges. Its **AI assistant runs on Claude** through a custom `AgLlmAdapter` ([`llm-adapter.ts`](apps/web/src/components/studio/llm-adapter.ts)) that calls a server route ([`api/ai/turn`](apps/web/src/app/api/ai/turn)), so the Anthropic key never reaches the browser; it is a read-only analyst over the operator's or seller's own data. |

## Use of PayPal

All calls go to the PayPal **sandbox**. The PayPal client refuses the live API host.

| PayPal API | What PayPer402 uses it for |
|---|---|
| OAuth 2.0 | Client-credentials token, cached |
| Vault v3 setup tokens | Start the one-time link (`payment_source.paypal`, `usage_type: MERCHANT`, `usage_pattern: UNSCHEDULED_POSTPAID`) |
| Vault v3 payment tokens | Exchange the approved setup token for a saved `vault_id`; check it; delete it on unlink |
| Orders v2 | Create and capture one order per batch with `payment_source.paypal.vault_id`, with `PayPal-Request-Id` for idempotency |
| Payments v2 captures | Read a capture back from PayPal for "Verify with PayPal" (`GET /v2/payments/captures/{id}`) |
| Webhooks | `VAULT.PAYMENT-TOKEN.DELETED`, verified with the webhook signature API, for instant revocation |

Revocation is handled as PayPal reports it: `422 AGREEMENT_ALREADY_CANCELLED` on a charge and
`404 TOKEN_NOT_FOUND` on the token both mark the wallet as stopped. PayPal keeps one agreement per
payer and merchant, so a revocation stops every operator that shares that payment token.

## Proof it settles on PayPal

PayPal has no public explorer like a blockchain does: every transaction is private to the two
accounts involved, sandbox included. PayPer402 makes each charge checkable instead, in three
independent ways.

1. **The ids match on both sides.** Every PayPal charge is one Orders v2 capture, and PayPer402
   sends its own charge id to PayPal as the order's `invoice_id`. So the charge page in PayPer402
   and the payment in the payer's PayPal account show the same values:

   | PayPer402 charge page | Payer's PayPal account (Activity → the payment) |
   |---|---|
   | Charge id `stl_…` | Invoice ID `stl_…` |
   | PayPal capture id | Transaction ID |
   | Amount and paid calls | Amount, and "PayPer402 usage: N paid calls" |

2. **Verify with PayPal.** On any completed charge (PayPal charges → a charge), the button reads the
   capture straight from the PayPal API and compares it with the ledger: capture found, status
   `COMPLETED`, amount, currency, invoice id and order id. It writes nothing.
3. **Log in and look.** With the sandbox test accounts from the Devpost testing instructions, open
   <https://www.sandbox.paypal.com>. The Personal account shows each charge under Activity, and the
   PayPer402 agreement under Settings → Payments → Automatic payments, where "Stop paying with
   PayPal" revokes it. The Business account shows the same payments received.

The demo video shows all three: a charge of $0.08 for three paid calls, its transaction in the
payer's PayPal account, and the agreement being stopped.

## Use of AI

| Where | Model | What it does |
|---|---|---|
| Demo agent | Claude (Anthropic SDK, tool use, adaptive thinking) | Plans within a budget, discovers 402 prices, pays, answers, explains its spending |
| Decision layer | Jev `jev-1.14.0` (TypeSafe) | Probabilities that a call serves the task and that its result is already covered; thresholds come from a labelled evaluation |
| Dashboards | Claude behind a server route, in AG Studio | A read-only analyst over spend, settlements and revenue |
| Demo seller | Claude | The paid review summary API |

Payment tools never accept free-form amounts, URLs or recipients from the model: services are
named by catalog ids, and every price is checked against the catalog, the per-call limit and the
remaining budget before anything is signed.

## Architecture

```mermaid
flowchart LR
  subgraph Operator
    W[Web app<br/>Next.js + AG Studio]
    CLI[payper402 CLI / MCP]
  end
  A[Claude agent] -- "1. request" --> S[Demo seller<br/>@x402/express]
  S -- "2. 402 + price" --> A
  A -- "3. retry with signed commitment" --> S
  S -- "verify / settle" --> F[Facilitator<br/>Express + SQLite]
  F -- "batch: Orders v2 capture with vault_id" --> P[(PayPal sandbox)]
  P -- "VAULT.PAYMENT-TOKEN.DELETED" --> F
  W -- "link, caps, dashboards" --> F
  W -- "Vault v3 link" --> P
  A -. "Jev check before paying" .-> J[TypeSafe Jev]
  CLI -- "claim code, status" --> F
```

| Path | What it is |
|---|---|
| `packages/scheme-paypal` | The x402 binding: client, server and facilitator plug-ins for `paypal:sandbox` |
| `packages/paypal-client` | Typed PayPal REST client (OAuth, Vault v3, Orders v2, Webhooks), sandbox only |
| `apps/facilitator` | Verify, settle, ledger, caps, settlement job, revocation, webhooks |
| `apps/demo-seller` | Five paid APIs behind `@x402/express` |
| `apps/agent` | The Claude agent, the decision layer, the MCP server and the `payper402` command |
| `apps/web` | Landing, onboarding, operator and seller consoles |
| `docs/spec` | The PayPal binding spec |
| `spikes/` | The feasibility checks run at the start: vault charging, Jev, AG Studio |

## Run it locally

Requirements: Node.js 22 or later (24 recommended), a PayPal developer account with a sandbox REST
app, and an Anthropic API key.

**1. Install.**

```bash
git clone https://github.com/kann420/PayPer402.git
cd PayPer402
npm install
cp .env.example .env
```

**2. Fill `.env`.** The minimum for the full browser demo:

| Variable | Where it comes from |
|---|---|
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | developer.paypal.com → Apps & Credentials → Sandbox. The app's sandbox Business account must have "Save payment methods" enabled |
| `ANTHROPIC_API_KEY` | console.anthropic.com |
| `DATA_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `API_KEY_PEPPER` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |

Optional: `TYPESAFE_API_KEY` turns the decision layer on, `ANTHROPIC_MODEL` picks the Claude model,
and `AG_STUDIO_LICENSE_KEY` removes the AG Studio watermark. Every other variable is listed with
its default in [.env.example](.env.example).

**3. Start everything.**

```bash
npm run dev:stack
```

This starts the facilitator (`:4020`), the demo seller (`:4021`) and the web app (`:3000`), seeds
the demo seller, and keeps its data in `data/`. Open <http://localhost:3000>.

**4. Walk through the story.**

The hosted demo at <https://payper402.xyz> runs the same story with nothing to install.

1. **Sign in** with a demo account. Each visitor gets their own demo operator.
2. **Link PayPal.** Approve the link with a PayPal sandbox **Personal** account (on the hosted
   demo, use the one from the Devpost testing instructions).
3. **Set limits** and create an agent.
4. **Live run.** Give the agent a task and watch it read prices, pay per call and explain its
   spending. The ledger fills up on the Overview.
5. **Charge now** (or wait for the unsettled cap). One PayPal capture settles exactly the sum of the
   calls. It shows in both sandbox accounts. Open the charge and press **Verify with PayPal** to
   check it against PayPal directly ([proof](#proof-it-settles-on-paypal)).
6. **Stop paying with PayPal.** In the sandbox Personal account, stop the PayPer402 automatic
   payment. The Overview shows "Stopped by payer", and the agent's next paid call is refused.
7. Switch to the **demo seller** to see revenue per endpoint and settlement status.

PayPal webhooks need a public HTTPS URL and `PAYPAL_WEBHOOK_ID`. Without them, revocation is still
noticed by the facilitator's wallet health check (every 30 seconds) and at the next charge.

### The terminal demo

The same story in one command, without the browser:

```bash
npm run demo -- --link
```

The first run prints a PayPal sandbox approval link. Later runs need no `--link`.

### Connect your own agent from a terminal

The `payper402` command is on npm, so there is nothing to clone or install first (Node.js 22 or
later). In the web app, open Agents → New agent → "Connect from a terminal". It shows a ready-made
command with a one-time claim code (valid for 15 minutes); copy it and run it on the agent's
machine. It looks like this:

```bash
npx -y payper402 onboard --claim <your-claim-code> --api https://api.payper402.xyz
```

Running it again with a new claim code switches the machine to the new agent; the previous config
is moved aside, not deleted. In Windows PowerShell, use `npx.cmd` if `npx` is blocked by the
execution policy. Then:

```bash
npx payper402 status
```

To let Claude Code pay per call through PayPer402 (optional, after onboarding):

```bash
claude mcp add -s user payper402 -- npx -y payper402 mcp
```

On Windows (not WSL):

```bash
claude mcp add -s user payper402 -- cmd /c npx -y payper402 mcp
```

To run the built-in Claude agent on a task instead (needs `ANTHROPIC_API_KEY`):

```bash
npx payper402 run --budget 0.50 "Find a quiet hotel in Kyoto near Gion for March 30 to April 2, 2027"
```

The agent's private key lives in `~/.payper402/config.json` (`PAYPER402_HOME` changes the folder).
Treat it like a `.env` file.

From a clone, `npm link` gives the same command as `payper402`, running the repository sources,
and `npm run build:npm -w apps/agent` builds the npm package into `apps/agent/dist/npm`.

## Tests

```bash
npm run typecheck
```

```bash
npm test
```

More than 1,000 Vitest tests. Every PayPal, Anthropic and TypeSafe call is mocked, so the suite
needs no credentials. The real sandbox is exercised only by explicit scripts, such as
`npm run sandbox-e2e -w apps/facilitator`.

## Safety rules

- **Sandbox only.** The PayPal client refuses `api-m.paypal.com`.
- **Never charge more than the payer signed for.** A settlement is exactly the sum of signed,
  unsettled commitments, and never more than the caps.
- **Bounded credit.** The postpaid model extends credit until settlement, so every operator has an
  unsettled cap. When it is reached the facilitator settles at once, and stops serving if that
  fails.
- **Keys stay where they belong.** Agent keys are generated on the agent's machine; the Anthropic
  key stays on the server; the stored PayPal vault ids are encrypted at rest.

## Status

A working hackathon build on the PayPal sandbox. The full flow (link, pay per call, one batch
charge, revocation) has passed end to end against the real sandbox. Not production-ready: live
PayPal credentials, payouts to many sellers and a PYUSD path are out of scope.

## License

[MIT](LICENSE)
