# PayPer402

**Pay-per-call for AI agents. Settled with PayPal.**

PayPer402 lets an AI agent pay for APIs one call at a time over HTTP 402, using the
[x402 protocol](https://github.com/x402-foundation/x402), while the money moves through PayPal.

1. **Link once.** The operator of an agent links a PayPal account and sets spending caps.
2. **Pay per call.** A paid API answers `402 Payment Required` with a price. The agent signs a
   payment commitment and retries, and the call goes through. No human is involved.
3. **Settle in one charge.** Commitments are added up and charged to the linked PayPal account in
   one batch, so per-call fees stay small.

The operator can stop at any time from their PayPal account, and the agent is refused on its next
call.

> Status: early development for the PayPal AI Hackathon. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Repository layout

```
packages/scheme-paypal   x402 batch-settlement binding for the PayPal network
packages/paypal-client   typed PayPal REST client (sandbox only)
apps/facilitator         verifies and records commitments, links PayPal, settles batches
apps/demo-seller         four paid APIs behind @x402/express (simulated data)
apps/agent               Claude agent, CLI, MCP server and the demo command
docs/                    roadmap, binding spec, architecture
```

## Development

Requirements: Node.js 22 or later (24 recommended, see `.nvmrc`).

```bash
npm install
```

```bash
cp .env.example .env
```

Fill `.env` with the PayPal sandbox app credentials.

```bash
npm run typecheck
```

```bash
npm test
```

PayPer402 talks to the **PayPal sandbox only**. The PayPal client refuses the live API host.

## Run the demo

One command runs the whole story locally: the facilitator, the demo seller and a Claude agent that
shops for paid APIs within a budget, pays per call, and explains what it spent. The calls are
checked against the ledger and settled in one PayPal sandbox charge.

```bash
npm run demo -- --link
```

The first run prints a PayPal sandbox approval link; later runs need no `--link`. It needs the
PayPal sandbox credentials, `DATA_ENCRYPTION_KEY`, `API_KEY_PEPPER` and Anthropic credentials in
`.env`. See [apps/agent/README.md](apps/agent/README.md) for the options, the MCP server and the
"Stop paying with PayPal" scene.

## Use PayPer402 from a terminal

The `payper402` command connects an agent to your account with a claim code, shows what the agent
may spend, and runs the MCP server and the Claude agent. It runs from a clone of this repository
(it is not published to npm). Linking PayPal, setting limits and pausing agents stay in the web
app; the command never holds an operator key.

Install it once, from the repository root:

```bash
npm install
npm link
```

`npm link` puts `payper402` on your PATH; the link points at your clone. Without it, use either of
these instead (replace `<repo>` with the path of your clone):

```bash
npm run --silent payper402 -- <command>
node <repo>/apps/agent/bin/payper402.mjs <command>
```

Do not use `npx payper402`: the command is not on the npm registry, and `npx` could fetch a
stranger's package of that name.

**Connect an agent.** In the web app, open Agents, then "New agent", type a name and choose
"Connect from a terminal" (the onboarding's last step has the same button). It shows a command like
this, valid for 15 minutes and usable once:

```bash
payper402 onboard --claim K7QM-2XRD-9VHT --api http://localhost:4020
```

The command generates the agent's key on your machine and sends only the public key. Then:

```bash
payper402 status
```

shows the agent, the limits, today's spend and the PayPal link, and says why the agent is blocked
when it is. `payper402 status --json` prints the raw answer.

**Run the Claude agent** on a task (it needs Anthropic credentials in the environment; `--budget`
and `--max-per-call` are in dollars):

```bash
payper402 run --budget 0.50 "Brief me on today's coffee market"
```

**Use it from Claude Code.** `payper402 mcp` runs the MCP server with the agent's identity, so
Claude Code can call paid APIs within your limits:

```bash
# macOS and Linux, with npm link
claude mcp add payper402 -- payper402 mcp

# Windows, with npm link
claude mcp add payper402 -- cmd /c payper402 mcp

# Any system, without npm link
claude mcp add payper402 -- node <repo>/apps/agent/bin/payper402.mjs mcp
```

**The config file** is `~/.payper402/config.json` (set `PAYPER402_HOME` to use another
directory). It holds the agent's private key, so treat it like a `.env` file: do not commit it or
share it. On Windows its permissions are not restricted. `payper402 onboard --force` replaces it,
and the old key is deleted. `payper402` takes the key and the seller URL only from this file; an
`AGENT_PRIVATE_KEY` in the environment is ignored. `npm run agent` and `npm run mcp` still read
only the environment.

The design is in [docs/spec/operator-cli.md](docs/spec/operator-cli.md).

## License

[MIT](LICENSE)
