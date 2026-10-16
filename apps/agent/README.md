# PayPer402 agent

A Claude agent, an MCP server and the demo command, over one payment core. Behaviour is defined in
[docs/spec/agent.md](../../docs/spec/agent.md).

## The payment core

A **session** is one catalog and one budget. It loads the seller's free catalog and validates it
strictly. For each paid call it makes one unpaid request, reads the `402` price, and checks it
against the catalog price, the per-call limit and the remaining budget. It reserves the amount,
signs one Ed25519 commitment with the x402 client (`@x402/core`, with a policy that pins the
checked requirement and a spend control at that price), and repeats the request with the payment
header. Every outcome becomes an event; refusals by the facilitator (a stopped PayPal link, a
paused agent) block the session, so later calls are answered locally. The spend report's numbers
come from the recorded payments, never from the model. Tool inputs never contain a URL, an
amount or a recipient: services are named by catalog ids.

## CLI

```bash
npm run agent -w apps/agent -- [--budget 1.00] [--max-per-call 0.10] [--no-spend-check] "<task>"
```

The seller and the facilitator must already be running (or use `npm run demo`).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `AGENT_PRIVATE_KEY` | yes | — | The agent's Ed25519 key: the raw 32-byte seed in base64url (a JWK's `d`), or a JSON JWK |
| `SELLER_URL` | no | `http://localhost:4021` | The seller to shop at |
| `AGENT_BUDGET` | no | `1.00` | Dollars; `--budget` overrides it |
| `AGENT_MAX_PER_CALL` | no | `0.10` | Dollars; `--max-per-call` overrides it |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | Model |

The default task is "Brief me on today's coffee market: current price, top news, and a summary
in Vietnamese." Each event prints as one line with an ASCII tag (`[start]`, `[think]`, `[402]`,
`[decide]`, `[paid]`, `[refused]`, `[failed]`), followed by the answer and the spend report. The
exit code is 0 when the run completed, 1 otherwise.

The agent uses the SDK's tool runner with adaptive thinking (`display: "updates"`, so the notes
between tool calls become `[think]` rows), effort `medium`, server-side fallbacks and prompt
caching. It stops itself at 12 model messages, before any tool of the last message runs.

## Decision layer

Before the agent signs a payment, Jev (TypeSafe's System One model, pinned to `jev-1.14.0`) gives a
calibrated second opinion: does this call serve the task, and is its result already in hand? Code
turns the two probabilities into pass, flag or refuse with fixed thresholds, while the budget and
the caps stay the hard guards and any Jev failure lets the call proceed.

The design is in [docs/spec/decision-layer.md](../../docs/spec/decision-layer.md).

- `TYPESAFE_API_KEY` (root `.env`) enables it for the CLI and the demo command; `--no-spend-check`
  turns it off. The MCP server never runs it (it has no task).
- **What is sent to TypeSafe:** the task text, the proposed call's catalog description and params,
  and bounded excerpts (at most 600 characters each) of this run's earlier seller responses. Never
  keys, payment headers or operator data.
- With the layer on, an exact repeat of a paid, in-flight or uncertain call is refused locally
  (`duplicate_call`), and an exact retry of a call Jev refused gets the same refusal.

Start-up line, then the check on each `[decide]` or `[refused]` line, then a summary after the
spend report:

```
Decision layer: Jev (jev-1.14.0) on
Decision layer: off (no TYPESAFE_API_KEY)
[decide] call_2 pay $0.05 for Page Summary API: <reason> (left after this: $0.93) | Jev: serves task 0.78, covered 0.03
[decide] ... | Jev would refuse (not_needed, serves task 0.12), observe-only
[decide] ... | Jev unavailable (timed out)
[refused] call_3 Market Quote API: The decision layer judged this call not needed for the task (not_needed, by agent) | Jev: serves task 0.12
Decision layer: Jev (jev-1.14.0): 3 passed, 1 blocked, 0 flagged, 0 unavailable
```

The thresholds and modes come from a labelled evaluation against the real Jev (about $0.01 per
run, needs `TYPESAFE_API_KEY`):

```bash
npm run eval:spend-check -w apps/agent [-- --holdout]
```

Without `--holdout` it runs the tuning cases only; `--holdout` also scores the hold-out cases and
decides the pin. The cases are in `scripts/spend-check-cases.ts`.

## MCP server

```bash
npm run --silent mcp -w apps/agent
```

A stdio MCP server named `payper402` with three tools: `list_services`, `call_service` (spends
money) and `get_budget`. It uses the CLI's environment, with `AGENT_BUDGET` as the budget for the
whole server process. Events are logged to stderr; stdout carries only the protocol. Use
`--silent`: without it `npm run` prints its own banner to stdout, which breaks the protocol.

Claude Code (placeholders):

```bash
claude mcp add payper402 --env AGENT_PRIVATE_KEY=<agent-key> --env SELLER_URL=http://localhost:4021 \
  --env AGENT_BUDGET=1.00 -- npm run --silent --prefix <path-to-repo>/apps/agent mcp
```

Claude Desktop (`claude_desktop_config.json`; placeholders):

```json
{
  "mcpServers": {
    "payper402": {
      "command": "npm",
      "args": ["run", "--silent", "--prefix", "<path-to-repo>/apps/agent", "mcp"],
      "env": {
        "AGENT_PRIVATE_KEY": "<agent-key>",
        "SELLER_URL": "http://localhost:4021",
        "AGENT_BUDGET": "1.00"
      }
    }
  }
}
```

## The demo command

```bash
npm run demo -- [--link] [--no-settle] [--no-spend-check] [--budget 1.00] ["<task>"]
```

One process runs the whole story against the real PayPal sandbox and the real Anthropic API: the
facilitator (database `DEMO_DATABASE_PATH`, default `<repo>/data/demo.db`), the seeded accounts
with run-scoped API keys (revoked at exit), the agent `research-bot` (key from
`AGENT_PRIVATE_KEY` or the key file next to the database, created on the first run), the demo
seller, the agent run, a ledger check against the facilitator, and a PayPal settlement. It prints
`RESULT: PASS` or `RESULT: FAIL. <reason>`.

Required: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DATA_ENCRYPTION_KEY` and `API_KEY_PEPPER`
(both stable, because the database persists), and Anthropic credentials. Optional: `PORT` (4020),
`SELLER_PORT` (4021), `PUBLIC_BASE_URL`, `ANTHROPIC_MODEL`, `LOG_LEVEL` (default `warn`).

Two scenes:

- **Linked.** `npm run demo -- --link` prints a PayPal approval link (open it in a private window
  and approve with the US Personal sandbox account) and waits until the wallet is active. The
  agent then pays for a quote and a summary, the ledger matches, and one Orders v2 charge settles
  exactly the sum. Later runs need no `--link`.
- **Stopped.** Stop the agreement in the sandbox account ("Stop paying with PayPal"), then run
  `npm run demo` again. The first paid call is refused with "Payment required: the operator's
  PayPal link was stopped.", later calls are blocked locally, and the agent explains why.

## Events

The event schema (`started`, `thinking`, `discovered_price`, `decided`, `paid`, `refused`,
`failed`, `result`) is the Phase 4 contract: see design spec §4.6 and `src/events.ts`.
