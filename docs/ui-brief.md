# PayPer402: UI design brief

Design brief for the PayPer402 web app: a landing page, an operator console, and a seller console.
Hand this whole file to the design tool. All UI copy is in **English**.

---

## 1. The product in one minute

**PayPer402: pay-per-call for AI agents, settled with PayPal.**

AI agents increasingly need to pay for things on their own: data APIs, search, translation,
summaries. Today every paid API wants its own account, card, API key and monthly plan. An agent
cannot sign up for 30 services, and its owner does not want 30 subscriptions.

PayPer402 works like electronic toll collection for APIs:

1. **Link once.** The person or company that runs an agent (the **operator**) links a PayPal
   account one time and sets spending limits.
2. **Pay per call.** When the agent calls a paid API, the API answers `402 Payment Required` with
   a price, for example $0.02. The agent signs a payment promise and retries, and the call goes
   through. Nobody clicks "approve".
3. **One charge later.** All the small calls add up. PayPer402 charges the linked PayPal account
   **once** when the amount reaches a threshold (for example $5) or once a day, so fees stay
   small.
4. **Stop anytime.** The operator can cancel from their PayPal account ("Stop paying with
   PayPal"), and their agents are refused on the very next call.

**Sellers** (API owners) add a small piece of middleware to their API and get paid through PayPal
without handling any crypto or accounts.

Under the hood this is the open **x402** standard for HTTP payments (the `402 Payment Required`
status code), with PayPal as the payment rail. That is the innovation story: PayPer402 is the
first PayPal rail for x402.

This is a hackathon entry (PayPal AI Hackathon). Judges will open the hosted app and the demo
video. Design for a **clear, credible, complete product**, not a tech demo.

---

## 2. Hard constraints

1. **No PayPal branding.**
   - Do not use the PayPal logo, wordmark styling or PayPal's blue and yellow color scheme, and do
     not imitate PayPal's look.
   - "PayPal" may only appear as plain text in factual phrases: "Settled with PayPal", "Link your
     PayPal account", "Charged to your PayPal account".
   - The "link" step redirects to PayPal's own approval page, so we do not draw a PayPal button.
     Use our own button style with the text "Link PayPal account".
2. **Charts and tables inside dashboards are rendered by AG Studio**, an embedded dashboard
   library.
   - Design the **page layout, KPI cards, filters and the frames** that hold widgets, plus a
     color theme for the charts.
   - Do not design custom chart types; use standard ones (line, bar, stacked bar, donut, table).
   - AG Studio also has a built-in **AI chat panel** ("Ask about your spend"). Give it a docked
     right-side panel.
3. **Sandbox notice.** The app runs on PayPal's sandbox (test money). Show a slim, persistent
   banner: "Sandbox: test money only. No real charges."
4. **Tech target:** Next.js + React + **Tailwind CSS**. Use a simple component vocabulary (cards,
   tables, badges, tabs, steppers, drawers, toasts) so the design maps directly to Tailwind.
5. **Desktop-first** for the consoles (1280–1440 px). The landing page must also work on mobile.
6. **Accessibility:** WCAG AA contrast. Status must never be shown by color alone; always pair
   color with a label or icon.
7. **Money format:** USD with two decimals (`$0.02`, `$4.87`). Prices per call are typically
   $0.01–$0.05. Use tabular numbers in tables.
8. **Out of scope.** No credit or virtual card UIs, no crypto wallets, tokens or seed phrases, no
   sign-up or password flows. Sign-in is a demo account picker.

### Brand direction (suggestions, not rules)

- Name: **PayPer402**. Tagline: **"Pay-per-call for AI agents. Settled with PayPal."**
- Metaphors to play with: a toll gate or turnstile, a meter, a receipt, the `402` status code.
- Feel: precise, trustworthy, developer-friendly, a bit playful about "402".
- Pick an accent color that is clearly **not** PayPal blue. Ideas: electric green, amber, or
  violet on a neutral, near-black or off-white base.
- Monospace for amounts, ids, HTTP codes and code snippets.

---

## 3. Glossary (UI labels for technical terms)

| Concept | UI label | Meaning |
|---|---|---|
| Operator | Operator / "You" | Person or company running AI agents, who pays |
| Seller | Seller / API owner | Owner of a paid API, who gets paid |
| Agent | Agent | One AI agent with its own key, e.g. "research-bot" |
| Commitment | **Paid call** | One API call the agent promised to pay for (signed) |
| Unsettled | **Not yet charged** | Paid calls that are not yet charged to PayPal |
| Settlement | **PayPal charge** | One PayPal charge covering many paid calls |
| Unsettled cap | **Auto-charge at** | When unsettled usage reaches this amount, charge now |
| Wallet | **PayPal link** | The operator's linked PayPal account (saved agreement) |
| Revoked | **Stopped by payer** | The operator cancelled the agreement in PayPal; agents are blocked |
| 402 | "Payment required" | What a paid API answers before it is paid |

---

## 4. Data model (fields each screen can show)

Field names are indicative. Sample values are in section 7.

**Operator**
- `name`, `email`, `createdAt`

**PayPal link (wallet)**
- `status`: `not_linked` | `waiting_for_approval` | `active` | `stopped_by_payer` | `link_failed`
- `payerEmail`, masked (`al***@example.com`)
- `linkedAt`, `stoppedAt`
- `lastChargeAt`, `lastChargeAmount`

**Limits (caps)**
- `perCallMax`, e.g. $0.10. The largest price an agent may accept for a single call.
- `dailyMax`, e.g. $10.00. Today's usage against it is `spentToday`.
- `totalMax`, e.g. $50.00. Lifetime or this-month usage against it is `spentTotal`.
- `autoChargeAt`, e.g. $5.00, the unsettled cap. Current usage against it is `notYetCharged`.

**Agent**
- `name`, `id`
- `keyFingerprint`, short, e.g. `ed25519:7f3a…c91b`
- `status`: `active` | `paused` | `blocked`. An agent is blocked when the PayPal link is stopped
  or a limit is reached.
- `budget`, optional per-agent cap
- `spentToday`, `spentTotal`, `callsToday`, `lastCallAt`
- `createdAt`

**Paid call (commitment)**
- `id`, `time`
- `agent`
- `service`, e.g. "Market Quote API"
- `endpoint`, e.g. `GET /v1/quote?symbol=KC`
- `price`
- `status`: `not_yet_charged` | `charged` | `uncollectible`. A call is uncollectible when the payer
  stopped the agreement before it was charged.
- `chargeId`, if charged
- `httpStatus` of the response, e.g. 200

**PayPal charge (settlement)**
- `id`, `createdAt`
- `trigger`: `threshold` | `daily` | `manual`
- `amount`, which always equals the sum of the included paid calls
- `callsCount`
- `status`: `pending` | `completed` | `failed`
- `failureReason`, e.g. "Payer stopped the agreement"
- `paypalOrderId`, `paypalCaptureId`, shown as small monospace references
- Seller view only: `paypalFee`, `netAmount`

**Service and endpoint (seller side)**
- `serviceName`, `description`
- `endpoint` (method + path)
- `pricePerCall`
- `callsToday`, `revenueToday`, `revenueTotal`
- `uniqueAgents`
- `status`: `live` | `paused`

**Agent run (live demo)**
- `task` (text), `budget` (e.g. $1.00)
- `steps[]`, each with:
  - `type`: `thinking` | `discovered_price` | `decided` | `paid` | `result` | `refused`
  - `service`, `price`, `note`, `time`
- `totalSpent`, `remainingBudget`
- `spendReport`: per service, calls × price, plus a one-paragraph explanation from the agent

---

## 5. Screens

### 5.0 Landing page (public)

Goal: a judge understands the product in 10 seconds and clicks "Try the live demo".

Sections:

1. **Hero**
   - Headline, for example: "Let your AI agent pay per API call. Settle once with PayPal."
   - Sub-line: link once, pay per call, one charge.
   - Primary CTA: **Try the live demo**. Secondary CTA: **For API sellers**.
   - Visual idea: an animated sequence showing an agent request, then `402 · $0.02`, then signed,
     then `200 OK`. Below it, small "paid call" receipts stacking into one "PayPal charge
     $4.87".
2. **The problem.** Three short cards: "Agents can't sign up", "30 subscriptions for 30 APIs",
   "Per-call card fees eat the price".
3. **How it works.** A 4-step strip: Link once → Agent calls a paid API → Signs a payment promise
   → One PayPal charge later. Add a note: "Stop anytime from your PayPal account."
4. **For operators / for sellers.** Two columns of benefits.
   - Operators: limits, one charge, stop anytime, a spend report written by the agent.
   - Sellers: price any endpoint per call, three lines of middleware, paid through PayPal.
5. **Built on an open standard.** One paragraph on x402 and `402 Payment Required`, with a link to
   our binding spec, plus a small code snippet showing the seller middleware.
6. **Trust.**
   - Never charged more than you approved.
   - Limits per call, per day and in total.
   - Sandbox demo, no real money.
7. **FAQ** (4–5 items): "Do I need crypto?" (no), "What does the agent need?", "How are fees
   kept low?", "Can I stop it?", "Who holds my PayPal details?" (PayPal does; we keep a token).
8. **Footer**: "Settled with PayPal" (text), GitHub link, spec link, "Hackathon project" note.

### 5.1 Sign in (demo account picker)

- Two large cards: **Operator demo** ("I run AI agents") and **Seller demo** ("I sell an API").
- No passwords. A small line: "Demo accounts on PayPal sandbox."

### 5.2 Operator onboarding (3-step wizard)

**Step 1: Link PayPal**
- An explanation: "You approve once on PayPal's page. After that, your agents can pay per call
  within your limits. You can stop anytime from your PayPal account."
- Button: "Link PayPal account". It redirects to PayPal; design the leaving and returning states.
- States: `not_linked`, `waiting_for_approval` (spinner plus "Finish on the PayPal tab"), `active`
  (check plus masked email), `link_failed` or cancelled (retry).

**Step 2: Set limits**
- Inputs: Max per call, Daily limit, Total limit, Auto-charge at, each with helper text.
- Show a sentence that previews the effect: "Your agents can spend up to $10.00 a day. We charge
  your PayPal account whenever unpaid usage reaches $5.00, and at least once a day."

**Step 3: Create your first agent**
- Fields: agent name, and an optional budget.
- Output: the agent key, shown **once**. Offer "Copy" and "Download", a warning "You won't see
  this again", and a code snippet with environment variables for the agent.

**Done** screen: "Run the demo agent" CTA and "Go to dashboard".

### 5.3 Operator dashboard (overview)

**Top KPI row:**
- Spent today, against the daily limit, as a progress bar.
- Not yet charged, against "Auto-charge at", as a progress bar with "next charge at $5.00".
- Last PayPal charge: amount and time.
- Active agents: count.

**PayPal link card:** status badge, masked email, "linked since", and a "Manage" link.

**AG Studio area** (2×2 grid of widget frames):
- Spend per day (line chart, last 14 days)
- Spend per agent (bar chart)
- Spend per service (donut chart)
- Recent paid calls (table: time, agent, service, endpoint, price, status)

**Docked right panel:** the AG Studio AI chat, "Ask about your spend". Example prompts: "Which
agent spent the most this week?", "Show spend by service for yesterday".

**Banners** (design all):
- Stopped by payer: red. "Your PayPal agreement was stopped. Agents are blocked. Re-link to
  resume."
- Daily limit reached: amber.
- Last charge failed.

### 5.4 Agents

- **List** (table): name, status badge, spent today, spent total, calls today, last call, and
  actions (pause or resume, rotate key).
- **Agent detail:**
  - header with name, status and key fingerprint
  - optional budget
  - mini KPIs
  - recent paid calls (AG Studio table)
  - button "Run this agent"

### 5.5 PayPal charges (settlements)

- **List** (table): date, trigger, amount, number of calls, status, and the PayPal order id in
  small monospace.
- **Charge detail:**
  - summary: amount, status, trigger, time
  - PayPal references
  - the list of included paid calls, with the sum shown equal to the amount
  - failure reason if it failed
- Copy idea: "Every charge equals the exact sum of the calls it covers."

### 5.6 Live agent run (the demo centerpiece)

The screen judges will remember. It shows an AI agent paying for APIs live.

- **Left: Task setup.**
  - Task text area, prefilled, e.g. "Brief me on today's coffee market: current price, top news,
    and a summary in Vietnamese."
  - Budget input ($1.00) and a Run button.
- **Center: Live timeline.** One row per step, streaming in:
  - 🧠 Thinking: "I need a price quote, recent news and a translation."
  - `402` Discovered price: Market Quote API, $0.02 per call.
  - ✓ Decided: "Within budget, calling it."
  - 💳 Paid: $0.02, signed payment promise, `200 OK`.
  - Refused (when relevant): "Over per-call limit" or "PayPal link stopped".
  - Each paid row shows the price chip and a running total.
- **Right: Budget meter.** Spent against budget, plus the remaining amount, updating live.
- **Final card: Spend report.**
  - A table of service × calls × price.
  - Total.
  - The agent's one-paragraph explanation, e.g. "I skipped the premium news API ($0.25) because
    the standard one covered the question."
  - The result text.
- Also design the **blocked** variant, used after the operator stops the agreement in PayPal: the
  first paid call is refused with "Payment required: the operator's PayPal link was stopped."

### 5.7 Settings: PayPal link and limits

- PayPal link: status, masked email, linked since, the last charge.
- Buttons: "Unlink" (with a confirmation) and "Re-link" when stopped.
- Note: "You can also stop at any time from your PayPal account (Settings → Automatic payments)."
- Limits form (the same fields as onboarding step 2), with "Save".

### 5.8 Seller dashboard

**KPI row:** revenue today, revenue this week, paid calls today, unique agents, and pending (not
yet charged to payers).

**AG Studio area:**
- Revenue per endpoint (bar chart)
- Revenue per day (line chart)
- Calls by agent (table)
- Recent paid calls (table: time, agent (anonymized id), endpoint, price, status)

**Charges received** (table): date, amount, PayPal fee, net amount, status.

The same docked AI chat panel: "Ask about your revenue".

### 5.9 Seller endpoints and pricing

- Table of endpoints: method and path, description, price per call (inline edit), status
  (live or paused), calls today, revenue today.
- "Add endpoint" drawer: path, method, description, price.
- **Integration snippet** card: a code block showing the 3–5 lines of Express middleware, with a
  Copy button.
- A "Test it" panel: shows the raw `402` response for an endpoint (status, price, headers), in
  monospace.

### 5.10 Global states to design

- Empty states:
  - no agents yet
  - no paid calls yet
  - no charges yet ("Your first PayPal charge appears when usage reaches $5.00 or at the end of
    the day")
- Loading skeletons for KPI cards and widget frames.
- Toasts: "Limits saved", "Agent paused", "Key copied".
- Error page and offline state.

---

## 6. Navigation

- **Operator console:** sidebar with Overview, Agents, Live run, PayPal charges, Settings. The top
  bar has the sandbox banner, the account switcher (Operator or Seller demo), and "Ask AI".
- **Seller console:** sidebar with Overview, Endpoints, Charges received, Settings.
- The landing page has a top nav: How it works, For sellers, Spec, GitHub, and "Try the live
  demo".

---

## 7. Sample data (use for realistic mocks)

**Operator:** "Northwind Research", operator@example.com

**PayPal link:**
- status `active`
- payer `al***@example.com`
- linked Oct 28, 2026
- last charge $5.00, Nov 2, 2026 09:14

**Limits:** per call $0.10, daily $10.00, total $50.00, auto-charge at $5.00

**Agents:**

| Name | Status | Spent today | Spent total | Calls today |
|---|---|---|---|---|
| research-bot | active | $1.84 | $23.40 | 61 |
| price-watcher | active | $0.62 | $8.15 | 31 |
| translator-01 | paused | $0.00 | $2.07 | 0 |

**Services** (seller "Acme Data"):

| Service | Endpoint | Price |
|---|---|---|
| Market Quote API | `GET /v1/quote` | $0.02 |
| Page Summary API | `POST /v1/summarize` | $0.05 |
| Translate API | `POST /v1/translate` | $0.01 |
| Premium News API | `GET /v1/news/premium` | $0.25, shown being skipped by the agent |

**Recent paid calls** (operator view):
- 10:42:07 · research-bot · Market Quote API · `GET /v1/quote?symbol=KC` · $0.02 · not yet charged
- 10:42:09 · research-bot · Page Summary API · `POST /v1/summarize` · $0.05 · not yet charged
- 10:42:12 · research-bot · Translate API · `POST /v1/translate` · $0.01 · not yet charged
- 09:58:31 · price-watcher · Market Quote API · `GET /v1/quote?symbol=CC` · $0.02 · charged

**PayPal charges:**

| Date | Trigger | Amount | Calls | Status |
|---|---|---|---|---|
| Nov 2, 09:14 | threshold | $5.00 | 143 | completed |
| Nov 1, 23:59 | daily | $3.27 | 98 | completed |
| Oct 31, 16:02 | threshold | $5.00 | 151 | completed |

Show the fee only in the seller view, e.g. $5.00 charge, $0.66 fee, $4.34 net.

**Live run example:**
- Task: "Brief me on today's coffee market…"
- Budget $1.00, spent $0.08 (quote $0.02 + summary $0.05 + translate $0.01), skipped Premium News
  ($0.25)
- Remaining $0.92

---

## 8. Demo video story (under 3 minutes)

These screens appear in the video, so make each of them readable at video resolution.

1. **0:00–0:20, the problem.** Landing hero and the problem cards: agents can't pay for APIs
   without accounts and subscriptions.
2. **0:20–0:45, link once.** Onboarding step 1: click "Link PayPal account", approve on PayPal's
   page, return to "Linked". Step 2: set limits.
3. **0:45–1:35, the agent pays per call.** Live agent run:
   - the timeline streams `402` prices, decisions and payments
   - the agent skips the expensive API
   - the budget meter moves
   - the spend report appears
4. **1:35–2:00, one charge.** Dashboard: "Not yet charged" crosses $5.00, and one PayPal charge
   appears in PayPal charges, with the detail showing that it equals the sum of the calls.
5. **2:00–2:25, stop anytime.** In the PayPal sandbox, click "Stop paying with PayPal". Back in
   PayPer402 the red "Stopped by payer" banner appears, and a new run is refused on the first
   paid call.
6. **2:25–2:50, sellers and the open standard.** Seller dashboard with revenue per endpoint,
   the middleware snippet, and the `402` response. Close on: "PayPer402: the PayPal rail for
   x402."

---

## 9. Deliverables wanted from the design

1. Landing page (desktop and mobile).
2. Sign-in picker.
3. Onboarding wizard (3 steps plus done, including the link states).
4. Operator overview (normal, stopped-by-payer, and empty variants).
5. Agents list and agent detail.
6. PayPal charges list and charge detail.
7. Live agent run (running, finished with spend report, and blocked variants).
8. Settings (PayPal link and limits).
9. Seller overview, endpoints and pricing, charges received.
10. A small design system: colors (light and dark if possible), typography, status badges, money
    and code styles, KPI card, widget frame, table, stepper, banner, toast. Include the chart
    color palette for AG Studio.
