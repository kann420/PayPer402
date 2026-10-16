# PayPer402 demo seller

"Acme Data", a small seller with four paid APIs behind `@x402/express` and the PayPal
`batch-settlement` scheme. An agent asks for a service, gets `402 Payment Required` with the price,
pays with a signed commitment, and the facilitator records the call; the money is settled later
in one PayPal charge. Behaviour is defined in [docs/spec/agent.md](../../docs/spec/agent.md) §3.

**All data is simulated, and every article is fictional.** Quote, summary and premium responses
carry `source: "Acme Data demo feed (simulated)"` and `simulated: true`.

## Services

| id | Route | Price | Params |
|---|---|---|---|
| `quote` | `GET /v1/quote` | $0.02 | `symbol`: `KC`, `CC`, `SB` or `CT` |
| `summarize` | `POST /v1/summarize` | $0.05 | `url` (a page of this seller's newsroom, at most 300 chars); `maxWords` 30–300 (default 120) |
| `translate` | `POST /v1/translate` | $0.01 | `text` (at most 4000 chars); `targetLanguage` (a name or code, at most 32 chars) |
| `premium_news` | `GET /v1/news/premium` | $0.25 | `topic`: `coffee`, `cocoa`, `sugar` or `cotton` |

One table in `src/services.ts` is the single source of truth: the x402 route config and the free
catalog are both derived from it, so a price cannot differ between them.

Free routes: `GET /v1/catalog` (the services, prices and params, plus the seller's `payTo`),
`GET /news/:slug` (minimal HTML newsroom pages) and `GET /healthz`.

- A quote also returns links to today's related newsroom pages.
- Summarize reads the article from memory. The seller never fetches URLs from the network; any URL
  outside `<SELLER_PUBLIC_URL>/news/<slug>` answers 400 `unsupported_url`.
- Summarize and translate call Claude (`ANTHROPIC_MODEL`, effort `low`, server-side fallbacks).
  The article or text is passed as data in the user message; the system prompt is static.

## The charging rule

A paid call is recorded (and later charged) only when the handler answers below 400, because the
x402 middleware settles only successful responses. So these are never charged:

- params that fail validation (400 `validation_failed`)
- a summarize URL outside the newsroom (400 `unsupported_url`)
- a seller AI failure (503 `ai_unavailable`; not 502, which the middleware uses when its own
  facilitator call fails)

The JSON body parser (limit 32 KB) runs before payment: a malformed body answers 400
`invalid_json` and an oversized one 413 `body_too_large`, both without a `402`. Payment is
verified before the handler validates its params. Other errors answer 404 `not_found` or 500
`internal_error` with no details.

## Configuration

The npm scripts load the root `.env` (see `.env.example`).

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `SELLER_PORT` | no | `4021` | HTTP port |
| `SELLER_PUBLIC_URL` | no | `http://localhost:<SELLER_PORT>` | External base URL: newsroom links and the summarize origin check |
| `FACILITATOR_URL` | no | `http://localhost:4020` | The facilitator |
| `SELLER_API_KEY` | yes | — | The seller's facilitator key (`pp402_sel_…`) |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | Model for summarize and translate |

Anthropic credentials are resolved by the SDK (`ANTHROPIC_API_KEY`, or a profile) and never logged.

## Running against a seeded facilitator

```bash
npm run seed -w apps/facilitator      # prints the seller key once
npm run start -w apps/facilitator
SELLER_API_KEY=pp402_sel_... npm run start -w apps/demo-seller
```

At start-up the seller calls `GET <FACILITATOR_URL>/v1/seller` with its key: the seller id becomes
the `payTo` of every route. It then initializes the x402 resource server against
`<FACILITATOR_URL>/x402` and listens. Any failure stops start-up with a message.

`npm run demo` (see [apps/agent](../agent/README.md)) starts the facilitator, this seller and the
agent in one process, with run-scoped keys.

## Library use

`createSellerApp(deps)` builds the Express app with no I/O; `startSeller(options)` does the
start-up above and returns `{ server, port, url, payTo, close() }`. `url` equals the public URL,
so the catalog, the calls and the newsroom links share one origin.
