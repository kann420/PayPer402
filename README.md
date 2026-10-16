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

## License

[MIT](LICENSE)
