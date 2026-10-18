# @payper402/web

The PayPer402 web app (Next.js 16, React 19, Tailwind CSS v4, AG Studio). It has:

- the landing page
- the demo sign-in: each visitor gets their own demo operator, or the shared demo seller
- operator onboarding: link PayPal (sandbox Vault), set limits, create the first agent
- the operator console: Overview, Agents, Live run, PayPal charges and Settings
- the seller console: Overview, Endpoints and Settled revenue
- an AI assistant (Claude) inside the AG Studio dashboards, read-only

The design spec is [`docs/spec/web-app.md`](../../docs/spec/web-app.md). The browser never talks to
the facilitator, the seller or Anthropic directly: every call goes through this app's server routes,
which hold the keys.

## Run it

Everything runs from the repository root with one command:

```bash
npm install
npm run dev:stack            # facilitator :4020, demo seller :4021, web app (next dev) :3000
npm run dev:stack -- --prod  # the same with next start; run `npm run build -w apps/web` first
```

`dev:stack` reads the root `.env` (see [`.env.example`](../../.env.example)). It needs
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DATA_ENCRYPTION_KEY`, `API_KEY_PEPPER` and Anthropic
credentials. For its own run it:

- first checks that ports 3000, 4020 and 4021 are free, and exits with "Port <n> is in use…" if
  one is taken
- starts the facilitator with the database `data/stack.db` and seeds the demo seller
- uses `ADMIN_API_KEY` if set, or a random admin key for this run
- issues a seller key for this run, and revokes it on exit
- starts the demo seller and Next, with the web variables below filled in
- uses `WEB_SESSION_SECRET` if set, and then never touches `data/web-session.key`. Otherwise it
  keeps a generated secret in `data/web-session.key` (created on the first run, ignored by git),
  so sessions survive restarts. If that file is not 64 hex characters it stops with "Fix or
  delete it, then try again." before anything starts. Delete the file to end every session.

Open <http://localhost:3000>. Stop it with Ctrl+C, which also stops Next. A hard kill (closing
the terminal, or killing the process on Windows) skips the clean-up and can leave the facilitator
and Next running; the next `dev:stack` then names the busy port. Stop that process and try again.

PayPal webhooks (the instant "Stop paying with PayPal" signal) need a public HTTPS URL and
`PAYPAL_WEBHOOK_ID`. Without them, revocation is still noticed by the facilitator's wallet check
and at the next charge.

## Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `WEB_PUBLIC_URL` | no | `http://localhost:3000` | The app's own origin, for the same-origin check |
| `FACILITATOR_URL` | no | `http://localhost:4020` | Facilitator base URL |
| `FACILITATOR_ADMIN_KEY` | for the operator demo | | Equals the facilitator's `ADMIN_API_KEY` |
| `WEB_SELLER_API_KEY` | for the seller demo | | The demo seller's facilitator key (`pp402_sel_…`) |
| `SELLER_URL` | no | `http://localhost:4021` | The demo seller |
| `WEB_SESSION_SECRET` | yes | | 64 hex characters; seals the session cookie. `dev:stack` keeps one in `data/web-session.key` when unset |
| `ANTHROPIC_MODEL` | no | `claude-opus-5-5` | Model for agent runs and the AI assistant |
| `TYPESAFE_API_KEY` | no | | Turns the decision layer (Jev) on for runs |
| `WEB_DECISION_LAYER` | no | `on` | `off` turns the decision layer off even with a key |
| `AG_STUDIO_LICENSE_KEY` | no | | AG Studio license; without it Studio shows a watermark |
| `NEXT_PUBLIC_REPO_URL` | no | | Repository URL for the landing page links |
| `WEB_TRUST_PROXY` | no | `0` | `1` keys rate limits on the first `X-Forwarded-For` address |
| `WEB_LIMIT_OPERATORS_PER_HOUR` | no | 5 | New demo operators per client address per hour |
| `WEB_LIMIT_OPERATORS_PER_DAY` | no | 200 | New demo operators per day, all clients together |
| `WEB_LIMIT_RUNS_PER_DAY` | no | 20 | Agent runs per demo operator per day |
| `WEB_LIMIT_RUNS_PER_HOUR` | no | 60 | Agent runs per hour, all operators together |
| `WEB_LIMIT_AI_TURNS_PER_HOUR` | no | 120 | AI assistant turns per browser session per hour |
| `WEB_LIMIT_AI_TURNS_PER_DAY` | no | 2000 | AI assistant turns per day, all sessions together |

A missing required variable makes the routes that need it answer 503, with a log line that names
the variable and never its value.

## Routes

**Pages**

| Path | Screen |
|---|---|
| `/` | Landing |
| `/sign-in` | Demo account picker |
| `/link/complete?status=…` | Return from PayPal |
| `/app/onboarding/link`, `/limits`, `/agent`, `/done` | Onboarding |
| `/app` | Operator overview (`?ai=1` opens the AI panel) |
| `/app/agents`, `/app/agents/[id]` | Agents (`?new=1` opens the drawer) and agent detail |
| `/app/live-run` | Live run (`?agent=<id>`) |
| `/app/charges`, `/app/charges/[id]` | PayPal charges and charge detail |
| `/app/settings` | PayPal link and limits |
| `/seller`, `/seller/endpoints`, `/seller/revenue` | Seller console |

**Server routes**

| Route | What it does |
|---|---|
| `POST /api/session` | Signs in as a demo operator or the demo seller (also "Start over" and the account switcher) |
| `GET /api/events?scope=operator\|seller` | Live updates (SSE relay of the facilitator's events) |
| `POST /api/operator/wallet/link`, `/refresh`, `/unlink` | PayPal link flow |
| `PUT /api/operator/caps` | Limits |
| `POST /api/operator/settlements` | "Charge now" |
| `POST /api/operator/agents`, `PATCH /api/operator/agents/[id]` | Create, pause and resume agents |
| `POST /api/runs` | Runs the demo agent and streams its timeline (SSE) |
| `POST /api/ai/turn?scope=…` | One AI assistant turn (AG Studio's LLM adapter) |
| `GET /api/seller/probe/[serviceId]` | "Test it": one unpaid request to the demo seller |

## Development

```bash
npm run typecheck    # whole repo, including this app
npm test             # Vitest; nothing calls a real API
npm run build -w apps/web
```

Route handlers live in `src/lib/handlers/` as factories that take their dependencies, so the tests
drive them against the facilitator's test harness (fake PayPal) and the real demo seller app
(fake AI). The `route.ts` files only wire the real dependencies.
