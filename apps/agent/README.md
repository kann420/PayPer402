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
npm run agent -w apps/agent -- [--budget 1.00] [--max-per-call 0.10] "<task>"
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
npm run demo -- [--link] [--no-settle] [--budget 1.00] ["<task>"]
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
