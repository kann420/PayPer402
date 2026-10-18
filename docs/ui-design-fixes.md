# PayPer402 prototype: fix list

Changes to make to the PayPer402 prototype so it matches the real backend. Keep the visual
design, layout and brand as they are; this list is about content, data, states and code samples.
All UI copy stays in English.

Decisions this list assumes:

- **Seller code** shows the real x402 SDK (`@x402/express`) plus our PayPal plug-in. There is no
  `@payper402/express` package and no `payper402()` helper.
- **Seller payouts are not part of the product yet.** PayPer402 collects with one PayPal charge
  and records each seller's share. Never show money moving into a separate "seller's PayPal".
- **Endpoint prices are set in the seller's code.** The Endpoints page shows them read-only.

---

## 1. Global rules

### 1.1 x402 wire format (version 2)

Every code panel, HTTP sample and "Test it" output must use x402 **v2**:

- The `402` response carries the price in a **`PAYMENT-REQUIRED` header**: base64 JSON. Show
  that header and its decoded JSON, not a JSON response body.
- The agent retries with a **`PAYMENT-SIGNATURE` header**. Never `X-PAYMENT`.
- The `200` response carries a **`PAYMENT-RESPONSE` header** with the paid call's id.
- Field values:
  - `x402Version: 2`
  - `scheme: "batch-settlement"`, never `"paypal"`
  - `network: "paypal:sandbox"`, with a colon
  - `asset: "USD"`
  - `amount` in **cents** as a string: `"2"` means $0.02. Never `maxAmountRequired`, never
    `"0.02"`.
  - `payTo`: the seller id, e.g. `"sel_Qm2…"`
  - `maxTimeoutSeconds: 300`
  - `extra: { "version": "1.0.0" }`

The exact samples are in section 5.

### 1.2 Status vocabulary

Use these labels everywhere: badges, filters, tables and the design system page. The backend
value is in brackets; never show it in the UI.

**PayPal link:**

| Label | Backend value | Notes |
|---|---|---|
| Not linked | `not_linked` | |
| Waiting for approval | `waiting_for_approval` | |
| Active | `active` | |
| Unlinking… | `unlinking` | **new** |
| Stopped by payer | `stopped_by_payer` | |
| Link failed | `link_failed` | Three reasons: cancelled, expired, or "couldn't collect the earlier balance" (see 3.1) |

**Agent:**

- Badges: Active, Paused.
- **Blocked** is not a separate status. It is shown when the PayPal link is not active or a
  limit is reached, and it applies to all agents of the account at once.
- Show "Blocked" instead of "Active" while it applies.

**Paid call:**

| Label | Backend value | Notes |
|---|---|---|
| Not yet charged | `unsettled` | |
| Charging | `settling` | **new**; included in a PayPal charge that is in progress |
| Charged | `settled` | |
| Not collected | `uncollectable` | Replaces "Uncollectible", because these calls **are** charged when the operator re-links. Helper text: "Charged when you re-link." |

**PayPal charge:**

| Label | Backend value | Notes |
|---|---|---|
| Charging | `pending` | |
| Completed | `completed` | |
| Failed | `failed` | |
| Needs review | `needs_review` | **new** |

**Charge trigger:**

| Label | Backend value | Notes |
|---|---|---|
| Threshold | `threshold` | |
| Daily | `daily` | |
| Manual | `manual` | |
| Unlink | `unlink` | **new**: the final charge when the operator unlinks |
| Re-link | `relink` | **new**: collects earlier usage before a re-linked account goes live |

### 1.3 IDs and references

- Charge (settlement) ids look like `stl_7Hq2…`, never `ch_…`.
- Agent ids look like `agt_…`. Operator ids look like `op_…`. Seller ids look like `sel_…`.
- **Agent key fingerprint:** `ed25519:` plus the first 6 and last 4 characters of the key id.
  - The key id is base64url: mixed case, digits, `-` and `_`. It is not hex.
  - Example: `ed25519:Wc1t0r…X9qA`.
- **Sellers never see agent ids or operator names.** Each agent appears to a seller as an
  8-character lowercase hex reference, shown as "Agent 3f9a1be1". Do not use the `agt_` prefix on
  seller screens.
- PayPal order and capture ids (17 uppercase characters, e.g. `8XK41922LM530214T`) are fine on
  operator screens.

### 1.4 How auto-charge actually works

The backend starts a PayPal charge a little before the "Auto-charge at" amount: at "Auto-charge
at" minus "Max per call". With the defaults ($5.00 and $0.10) that is $4.90. "Auto-charge at" is
also a hard stop: if a charge is still running or has failed, agents are refused once unpaid usage
reaches it.

- **Helper text for "Auto-charge at":** "When usage not yet charged nears this amount, we charge
  your PayPal account. Agents pause at this amount until the charge goes through."
- **Preview sentence:** "Your agents can spend up to $10.00 a day. We charge your PayPal account
  when unpaid usage nears $5.00, and at least once a day."
- **Threshold amounts:** in mock data, threshold charges are between $4.90 and $5.00, for example
  $4.93 or $5.00. Daily and manual charges can be any amount.

### 1.5 Timing copy

- **Revocation:** stopping in PayPal is detected within about a minute, not instantly. Use
  "Agents are refused within a minute", not "at once" or "on the very next call".
- **After a declined charge:** the next attempt is after **15 minutes**, not 1 hour.
- **Daily charge:** runs once a day, after midnight UTC.

---

## 2. Screen by screen

### 2.1 Landing

**Hero animation (8 stages).** Replace captions 7 and 8 and the right-hand boxes:

- Caption 7: "Near $5.00, PayPer402 charges your PayPal account once…"
- Caption 8: "…and settles the seller's share. One fee for 143 calls."
- Rename the box "Seller's PayPal · Acme Data" to **"Seller revenue · Acme Data"**. Keep
  "+$4.34 net".
- The middle box says "PayPal" and "settles in the middle". Change it to **"PayPer402 · settled
  with PayPal"**, so it is clear the charge is made by PayPer402 through PayPal.

**How it works, step 2 panel** ("agent hits a paid API"). Replace the JSON with the v2 sample in
5.1, short form.

**How it works, step 3 panel** ("signs and retries"). Use `PAYMENT-SIGNATURE` and
`PAYMENT-RESPONSE`, as in 5.2.

**For sellers column:**

- "Paid through PayPal. No crypto, no customer accounts" becomes "Settled with PayPal. No
  crypto, no customer accounts".
- "Received via PayPal $4.34 net" becomes "Settled revenue $4.34 net".
- "Three lines of middleware" becomes **"A few lines of standard x402 middleware"**.

**Open standard section:**

- Replace the `server.js` snippet with the short seller snippet in 5.4.
- Keep "Read the binding spec" and "View on GitHub".

**FAQ:**

- **"What does the agent need?"** "An agent key from your console and the standard x402 fetch
  client with our PayPal plug-in. It handles the 402, signs and retries."
- **"Can I stop it?"** "Yes. Unlink here, or stop from your PayPal account. Agents are refused
  within a minute."
- **Add a question: "Who receives the money?"** "Each PayPal charge is made by PayPer402. Sellers
  see their share of every charge, after PayPal's fee."

**Logo:**

- The current mark (a slanted P stroke with a coin, "two layers") reads as close to a well-known
  payments monogram.
- Replace it with a mark built from "402", a turnstile, or a meter dial.
- Keep the green and near-black palette.

### 2.2 Sign in

No changes.

### 2.3 Onboarding step 1: Link PayPal

**Link failed state.** Show the reason:

- Cancelled: "You cancelled on PayPal."
- Expired: "The approval link expired after 3 days."
- Couldn't collect: "We couldn't collect the $3.12 left from before you stopped. Try again, or
  link a different PayPal account."

**New state: Collecting earlier usage.**

- When: shown after approval when earlier usage was never collected.
- Text: "Linked. Collecting $3.12 of usage from before you stopped… Agents can pay again once
  this charge completes."
- Visual: a spinner and the amount.

**Return page.** The browser comes back from PayPal to `/link/complete?status=<status>`. Design
that landing state for each of these statuses:

- active
- still waiting
- link failed
- unknown: "This link was already used. Go to your dashboard."

### 2.4 Onboarding step 2: Set limits

**Copy.** Use the helper text and preview sentence from 1.4.

**Total limit:**

- Make it optional, with a "No total limit" checkbox.
- When it is checked, the field is disabled.

**Inline validation errors:**

- Max per call: at least $0.01.
- Max per call: no more than the daily limit ("Max per call can't be higher than the daily
  limit").
- Max per call: no more than Auto-charge at ("Max per call can't be higher than Auto-charge at").
- Total limit, when set: at least Max per call.

### 2.5 Onboarding step 3: First agent

**Remove** the "Budget (optional)" field. There is no per-agent budget; a budget belongs to each
run (see Live run).

**Key display:**

- Label: "Agent private key". Show a 43-character base64url string, for example
  `PAYPER402_AGENT_KEY=k3Jx0v…`.
- No `pp402_sk_test_` prefix.
- Fingerprint as in 1.3.

**Buttons:**

- "Copy"
- "Download .env"
- "Download key (JWK)"

**Environment snippet.** Use 5.5. Remove `PAYPER402_URL` and `PAYPER402_MAX_PER_CALL`.

**Under the snippet,** add a small code block "Use it in your agent" with the agent snippet in
5.5.

### 2.6 Onboarding done

No changes.

### 2.7 Operator overview

**"Not yet charged" KPI:**

- The sub-line becomes "auto-charge near $5.00".
- Add a small secondary button **"Charge now"** on the card. It charges the current not-yet-charged
  amount.
- The button is disabled when the amount is $0.00, when a charge is already running, or when the
  PayPal link is not active.
- Confirm dialog: "Charge $3.12 to your PayPal account now?"

**Stopped-by-payer variant:**

- "Not yet charged" shows **$0.00**.
- Add a line under it: "Not collected $3.12 · charged when you re-link".
- The red banner says: "Your PayPal agreement was stopped. Agents are blocked. Re-link to resume.
  $3.12 of earlier usage will be charged first."
- "Active agents" shows "2 · blocked", not "0".
- The recent-calls badges say "Not collected", not "Uncollectible".

**"Last PayPal charge failed" banner.** Two variants:

- Declined: "PayPal declined the $5.00 charge on Nov 2, 10:40. The calls went back to Not yet
  charged; we try again in 15 minutes."
- Needs review: "We couldn't confirm the $5.00 charge on Nov 2, 10:40 with PayPal. It is under
  review, and those calls will not be charged twice."

**New banner: Unlinking.**

- Style: neutral or amber.
- Text: "Unlinking… The final charge of $3.12 is still processing. Your account unlinks when it
  completes."

**New banner: Not linked.**

- Shown after an unlink, or when the account was never linked.
- Text: "No PayPal account linked. Agents can't pay until you link one."
- Button: "Link PayPal account".

**AI panel prompts.**

- Keep the examples that can be answered from the data on screen.
- Replace "When will the next PayPal charge happen?" with "How much is not yet charged?"

### 2.8 Agents list

- **Remove "Rotate key".** The actions are Pause or Resume, plus "View".
- **Blocked badge.** When the account is blocked, each agent row shows the Blocked badge, with a
  tooltip that gives the reason. The reasons are:
  - "PayPal link not active"
  - "Daily limit reached"
  - "Total limit reached"
  - "Waiting for the PayPal charge" (unpaid usage is at Auto-charge at)
- **"New agent"** opens a drawer with a name field only, then shows the key once, exactly like
  onboarding step 3.
- **Fingerprints** follow 1.3.

### 2.9 Agent detail

- **Remove the "Agent budget" card** ("$23.40 used of $30.00 / Edit budget").
- **Remove "Rotate key"** from the header.
- **Recent paid calls table:**
  - Remove the "Response" column.
  - Charge references look like `stl_9f2a…`.
  - Add the "Charging" status.

### 2.10 Live run

**Spend report explanation.** Make it consistent with the timeline: "I spent $0.08 of the $1.00
budget. I skipped the Premium News API because its $0.25 price is above your $0.10 per-call
limit; the page summary covered the news. $0.92 is left."

**Timeline:** keep the steps as they are.

**Under the budget meter,** add a note: "These paid calls are now Not yet charged. Use Charge now
on the overview to see a PayPal charge right away."

**Blocked variant:**

- Refused row text: "Payment required: the operator's PayPal link was stopped."
- End card: "Run stopped. Nothing was charged."

### 2.11 PayPal charges list

- **Header:**
  - Add a **"Charge now"** button next to the "Not yet charged $3.12 / $5.00" meter.
  - Change the meter's caption to "auto-charge near $5.00".
- **Trigger legend:** add Unlink ("final charge when you unlinked") and Re-link ("earlier usage
  collected when you re-linked").
- **Statuses:** show at least one row of each status: Charging, Failed and Needs review.

### 2.12 Charge detail

**Failed variant, reason "payer stopped":**

- "Failure reason: You stopped the agreement in your PayPal account."
- "These 143 paid calls were not charged. They are marked Not collected and are charged first
  when you re-link."
- **Delete** "Re-linking does not charge them again"; it is wrong.

**Failed variant, reason "declined"** (new):

- "Failure reason: PayPal declined the charge."
- "These 143 paid calls went back to Not yet charged and will be part of the next charge."

**Needs-review variant** (new):

- "We couldn't confirm this charge with PayPal. It is under review. The calls in it will not be
  charged twice."

**Charging variant** (new):

- "Charging… PayPal is processing this charge."
- The capture id shows "pending".

**Unchanged:**

- the "Sum of 143 paid calls = charge amount" block
- the "By service" breakdown

### 2.13 Settings

**PayPal link card, states:**

- Active: the Unlink button.
- Stopped by payer: "Re-link PayPal account". The sub-text adds "$3.12 of earlier usage will be
  charged first."
- Unlinking: "Unlinking…", with the Unlink button disabled.
- Not linked: "Link PayPal account".

**Unlink results:**

- Declined: a toast or inline error, "The final charge was declined, so your PayPal account stays
  linked. Try again later."
- Still processing: the card switches to "Unlinking…", with "Your account unlinks when the final
  charge completes."

**Limits form:**

- The same validation, optional total limit and helper text as onboarding step 2.
- The "used" sub-lines are already right.

**Note:** keep "You can also stop at any time from your PayPal account (Settings → Automatic
payments)." Add: "Agents are refused within a minute."

### 2.14 Seller overview

- **Agent references:** "Calls by agent" and "Recent paid calls" use the format in 1.3, e.g.
  "Agent 3f9a1be1".
- **Status labels:** use 1.2. Replace "Pending" with "Not yet charged", and add "Charging" and
  "Not collected".
- **"Pending" KPI:** rename it to "Not yet charged". Sub-line: "to be included in upcoming PayPal
  charges".
- **"Charges received" table:**
  - Rename it "Settled revenue".
  - Columns: Date, Calls, Amount, PayPal fee, Net, Status.
- **AI panel:** keep it.

### 2.15 Seller endpoints and pricing

**Remove:**

- the inline price editing ("Click a price to edit it…")
- the "Add endpoint" button and the drawer screen
- the Live/Paused status

**Table:** columns are Endpoint (method and path), Service, Description, Price per call, Calls
today, Revenue today. Everything is read-only.

**Note above the table:** "Prices are set in your middleware config. A new price applies as soon
as you deploy it."

**Integration card:**

- Title: "Integration · Express · server.js".
- Use the full seller snippet in 5.4.
- Show the route table for all four endpoints.

**"Test it" panel:**

- "Send unpaid request" shows the real response from 5.3: status line, headers, and the decoded
  `PAYMENT-REQUIRED` JSON in a second block labelled "Decoded PAYMENT-REQUIRED".
- Remove the old v1 JSON body.

### 2.16 Seller charges ("Settled revenue")

- **Remove the "Payer" column** (`op_northwind`). Sellers never see who paid.
- **Remove the "PayPal capture" column.**
- **Columns:** Date, Calls, Amount, PayPal fee, Net, Status.
- **The "Nov 2, now · Pending $2.94" row:** take it out of the table. Show it as a summary card
  above the table: "Not yet charged $2.94 · 104 paid calls, included in upcoming charges".
- **Footnote:** "Amounts are your share of each PayPal charge, after PayPal's fee. Batching paid
  calls keeps the fee small."
- **Weekly KPI cards:** keep them.

### 2.17 Global states

- **Offline state:** change "Agents keep running on the server" to "Your agents keep running;
  this page will catch up when you're back online."
- Everything else is fine.

### 2.18 Design system page

- **PayPal link badges:** add "Unlinking…".
- **Paid call badges:**
  - Add "Charging".
  - Rename "Uncollectible" to "Not collected".
- **PayPal charge badges:** add "Needs review".
- **Endpoint badge group:** remove it.
- **Banner examples:** update "We retry in 1 hour" to the declined copy in 2.7, and add the
  Unlinking and Not linked banners.
- **Amber accent:** the "402 amber" `#FFC24D` is very close to a well-known payments brand's
  button yellow. Shift it toward orange, e.g. `#FFB020` or `#F5A524`, and keep AA contrast on
  dark.

---

## 3. New states to design (summary)

1. **Link:**
   - collecting earlier usage, after re-link approval
   - link failed with reason "couldn't collect earlier usage"
   - the return page for the four statuses
2. **Overview banners:** Unlinking, Not linked, Needs review, and a declined charge that retries
   in 15 minutes.
3. **Charge detail:** Charging, Declined, Payer stopped, Needs review.
4. **Settings:** Unlinking, Not linked, and the unlink-declined error.
5. **Badges:** Charging (paid call and charge), Not collected, Needs review, and Unlinking….
6. **Buttons:** "Charge now" on the overview and charges list, with its confirm dialog and a toast
   ("PayPal charge started").

## 4. Remove (summary)

- Per-agent budget (onboarding field, agent detail card)
- Rotate key (agents list, agent detail)
- Response column (agent detail)
- Payer and PayPal capture columns (seller charges)
- Endpoint price editing, Add endpoint drawer, Live/Paused (seller endpoints)
- `pp402_sk_test_…` keys, `PAYPER402_URL`, `PAYPER402_MAX_PER_CALL`
- Every x402 v1 sample: `X-PAYMENT`, `maxAmountRequired`, `"scheme": "paypal"`,
  `"paypal-sandbox"`, `x402Version: 1`
- `@payper402/express` and `payper402()`

---

## 5. Exact samples

### 5.1 The 402 response

Short form for the landing panel:

```
# research-bot calls a paid API
GET /v1/quote?symbol=KC

HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwicmVz…

# decoded
{ "x402Version": 2,
  "accepts": [{ "scheme": "batch-settlement", "network": "paypal:sandbox",
                "asset": "USD", "amount": "2", "payTo": "sel_Qm2…" }] }
# amount is in cents: $0.02
```

### 5.2 The paid retry

```
# signs a payment promise and retries
GET /v1/quote?symbol=KC
PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6MiwicmVz…

HTTP/1.1 200 OK
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0cmFu…
{ "symbol": "KC", "price": "…" }
# paid $0.02 · not yet charged
```

### 5.3 "Test it" panel, full form

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwicmVz…
cache-control: no-store
```

Decoded `PAYMENT-REQUIRED`:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.acme.example/v1/quote?symbol=KC",
    "description": "Market Quote API",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "paypal:sandbox",
      "asset": "USD",
      "amount": "2",
      "payTo": "sel_Qm2…",
      "maxTimeoutSeconds": 300,
      "extra": { "version": "1.0.0" }
    }
  ]
}
```

Decoded `PAYMENT-RESPONSE`, after a paid call:

```json
{
  "success": true,
  "transaction": "q3V9mJr0Tn6w8dYk2bXo4A",
  "network": "paypal:sandbox",
  "amount": "2"
}
```

### 5.4 Seller middleware

Short form for the landing:

```js
import { paymentMiddleware } from "@x402/express";

// $0.02 per call, settled with PayPal
app.use(paymentMiddleware({
  "GET /v1/quote": { accepts: { scheme: "batch-settlement", network: "paypal:sandbox",
                                payTo: SELLER_ID, price: "$0.02" } },
}, resourceServer));
app.get("/v1/quote", quoteHandler);
```

Full form for the Endpoints integration card:

```js
import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { PayPalBatchServerScheme } from "@payper402/scheme-paypal";

const auth = { Authorization: `Bearer ${process.env.PAYPER402_SELLER_KEY}` };
const facilitator = new HTTPFacilitatorClient({
  url: "https://payper402.example/x402",
  createAuthHeaders: async () => ({ verify: auth, settle: auth, supported: auth }),
});
const resourceServer = new x402ResourceServer(facilitator)
  .register("paypal:*", new PayPalBatchServerScheme());

const paid = (price, description) => ({
  accepts: { scheme: "batch-settlement", network: "paypal:sandbox",
             payTo: process.env.PAYPER402_SELLER_ID, price },
  description,
  mimeType: "application/json",
});

app.use(paymentMiddleware({
  "GET /v1/quote":        paid("$0.02", "Market Quote API"),
  "POST /v1/summarize":   paid("$0.05", "Page Summary API"),
  "POST /v1/translate":   paid("$0.01", "Translate API"),
  "GET /v1/news/premium": paid("$0.25", "Premium News API"),
}, resourceServer));
```

### 5.5 Agent setup

The `.env` shown after creating an agent:

```
# .env for research-bot
PAYPER402_AGENT_KEY=k3Jx0vQ…43 characters…
```

"Use it in your agent":

```js
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { PayPalBatchClientScheme, importPrivateKeyRaw } from "@payper402/scheme-paypal";

const client = new x402Client().register("paypal:*", new PayPalBatchClientScheme({
  privateKey: importPrivateKeyRaw(process.env.PAYPER402_AGENT_KEY),
}));
const payingFetch = wrapFetchWithPayment(fetch, client);

const res = await payingFetch("https://api.acme.example/v1/quote?symbol=KC");
```
