# Vault spike: save a PayPal wallet once, charge it later

This spike answers one question: **on the PayPal sandbox, can a merchant save a payer's PayPal
wallet once and later charge it with no payer approving each charge?**

- If yes, an AI agent can pay per use behind an HTTP 402 gateway, and the PayPer402 premise holds.
- If no, the fallback is a prepaid balance that the ledger draws down.

## Result (2026-10-15): PASS

| Test | Result |
|---|---|
| Save once, charge several times (`IMMEDIATE`) | ✓ $1.00, $2.50 |
| Use first, pay later (`UNSCHEDULED_POSTPAID`) | ✓ $1.00, $2.50, $0.75, with and without `stored_credential` |
| Payer revokes ("Stop paying with PayPal" in their Autopay settings) | ✓ the next charge fails with `422 AGREEMENT_ALREADY_CANCELLED`, and `status` returns `404 TOKEN_NOT_FOUND` |

In the revocation test the script prints "FAIL", because it treats every failed charge as a
failure. Here the refusal is the expected outcome.

What this means for the design:

- Treat `AGREEMENT_ALREADY_CANCELLED` and `TOKEN_NOT_FOUND` as "wallet revoked": answer `402` to
  every further request from that operator's agents.
- Listen to the `VAULT.PAYMENT-TOKEN.DELETED` webhook to learn about revocation immediately.
- With postpaid usage, anything not yet settled when the payer revokes cannot be collected. Cap
  unsettled usage per operator; the same threshold drives batching.

## Flow

```
1. POST /v1/oauth2/token          get an access token (client credentials)
2. POST /v3/vault/setup-tokens    create a setup token (save the wallet, buy nothing)
3. Payer opens the approve link   signs in with the Personal sandbox account and approves  ← the only step with a human
4. GET  /v3/vault/setup-tokens/…  wait for status APPROVED
5. POST /v3/vault/payment-tokens  exchange the setup token for a payment token (vault_id)
6. POST /v2/checkout/orders       charge with vault_id, merchant-initiated               ← no payer
```

Requirements: Node.js 18 or later. No dependencies.

---

## Step 1: Create sandbox accounts

All sandbox accounts are test accounts and involve no real money. Do these steps in a browser.

### 1.1 Sign in to the Developer Dashboard

Go to <https://developer.paypal.com> and sign in with your real PayPal account. This is only the
developer portal; nothing is charged.

### 1.2 Create a US Business account (the merchant)

Under **Testing Tools → Sandbox Accounts → Create account**, choose:

- **Account type:** Business
- **Country/Region:** **United States**

Choose the US explicitly. Sandbox accounts default to your own country, and not every country
supports saving payment methods.

### 1.3 Create a US Personal account (the payer, i.e. the agent's operator)

Still under **Create account**, choose:

- **Account type:** Personal
- **Country/Region:** United States

To set the balance yourself, use **Create custom account** and set a high **PayPal balance**, for
example `5000`. That is how you "top up" in the sandbox; if you need more money, create another
account instead.

Note the Personal account's email and password, shown under **⋮ → View/Edit account**.

### 1.4 Create a REST app linked to the Business account

1. Open **Apps & Credentials**, select the **Sandbox** tab, and click **Create App**.
2. In **Sandbox Account**, pick the **US Business account** from step 1.2, not the default
   account.
3. Copy the **Client ID** and **Secret**.

### 1.5 Enable saving payment methods for the app

Open the app. Under **Features** (called **App Feature Options** in the older UI):

- Tick **Accept payments**.
- Open **Advanced options** and tick **Vault** / **Save payment methods**.

Click **Save**.

> PayPal's docs say that saving PayPal wallets requires the merchant to be approved for billing
> agreements. On the sandbox this is usually already enabled or approved automatically. If step 3
> below fails with a permission error, see "Troubleshooting".

---

## Step 2: Configure

```bash
cp .env.example .env
```

Fill `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` (Sandbox) in `.env`. `.env` is gitignored;
**never commit it**.

---

## Step 3: Run the spike

```bash
node vault-spike.mjs
```

The script prints a `https://www.sandbox.paypal.com/...` link. Open it and **sign in with the
Personal sandbox account** (step 1.3), not your real account, then approve.

> Use a **private window**. If the browser is still signed in to sandbox.paypal.com as the
> Business account, PayPal shows the approval page as the merchant and fails with a confusing
> error.

PayPal redirects to `http://localhost:8787/return` and the script charges the wallet. A
successful run looks like this:

```
✓ Got access token
✓ Created setup token 4G49... (status PAYER_ACTION_REQUIRED, usage_pattern IMMEDIATE)
→ Open this link in a browser ...
✓ Payer approved saving their PayPal wallet
✓ Wallet saved: payment token jwgvx42 (customer customer_..., buyer@...)

— From here on, NO payer is involved —

✓ Created order 5O19...: status COMPLETED
  capture 3C67...: COMPLETED 1.00 USD
  PayPal fee: ..., merchant receives: ...

RESULT: PASS. The merchant charged the saved wallet with no payer approval.
```

### Charge again, with no payer

This shows that an agent can pay many times:

```bash
node vault-spike.mjs charge 2.50
```

### Other commands

```bash
node vault-spike.mjs status
```

```bash
node vault-spike.mjs delete
```

`status` shows the saved payment token. `delete` deletes the token and `.vault-state.json`.

### Cross-checking

- Sign in to <https://www.sandbox.paypal.com> with the **Business account** and open **Activity**
  to see the payments received.
- Sign in with the **Personal account** to see the balance go down. The saved agreement usually
  appears under automatic payments (Autopay) in the settings.
- On the Developer Dashboard, the API call log (Event Logs / API Calls) shows each request with
  its debug id.

---

## Try "use first, pay later"

PayPer402 batches many calls into one charge, so `UNSCHEDULED_POSTPAID` (or
`THRESHOLD_POSTPAID`) fits better than `IMMEDIATE`. Once the default run passes, run it again with
that pattern:

```bash
node vault-spike.mjs delete
```

```bash
USAGE_PATTERN=UNSCHEDULED_POSTPAID node vault-spike.mjs
```

In PowerShell, set the variable first: `$env:USAGE_PATTERN="UNSCHEDULED_POSTPAID"; node
vault-spike.mjs`. Or simply change `USAGE_PATTERN` in `.env`.

---

## Reading the result

| Result | Meaning for PayPer402 |
|---|---|
| **PASS** | The premise holds: approve once, then the agent pays per use. Build the 402 gateway. |
| **CONDITIONAL PASS** (capture `PENDING`) | The charge went through but is on hold. Check `status_details.reason`; it is usually the Business account's configuration. |
| **FAIL: `PAYER_ACTION_REQUIRED`** when creating the order | The saved token does not let the merchant charge on its own. Try `STORED_CREDENTIAL=on` (marks the charge as merchant-initiated) and run `node vault-spike.mjs charge`, or save the wallet again with a different `USAGE_PATTERN`. If it still fails, switch to the prepaid fallback. |
| **FAIL at the setup token step** | The app does not have saving payment methods enabled, or the account is not eligible. See "Troubleshooting". |

---

## Troubleshooting

Every error the script prints includes a `paypal-debug-id`. Look it up under **Event Logs** in the
dashboard, or send it to PayPal support.

| Error | Fix |
|---|---|
| `401 invalid_client` | Wrong Client ID/Secret, or Live credentials instead of Sandbox. |
| `403 NOT_AUTHORIZED` / `PERMISSION_DENIED` when creating the setup token | The app does not have **Vault / Save payment methods** enabled (step 1.5), or it is linked to a non-US Business account (step 1.4). If it still fails, sign in to `https://www.sandbox.paypal.com/bizsignup/entry/product/ppcp` with the Business sandbox account to enable the feature; PayPal's docs say sandbox requests are approved automatically. |
| `422 ... return_url` | PayPal rejected the `localhost` URL. Set `RETURN_BASE_URL` in `.env` to any https URL, such as an ngrok tunnel. The script polls the status, so the redirect does not need to reach your machine. |
| `422 ... stored_credential` when creating the order | Only happens with `STORED_CREDENTIAL=on`. Set it back to `off` in `.env` and run `node vault-spike.mjs charge`. |
| `422 ... usage_pattern` | That pattern is not supported for this account. Go back to `IMMEDIATE`. |
| Cannot listen on port 8787 | Change `PORT` in `.env`. |
| Timed out after 10 minutes | Start again. Setup tokens expire on their own after 3 days, so there is nothing to clean up. |

---

## Safety

- The script **only runs against the sandbox**: a `PAYPAL_API_BASE` pointing at the live host is
  refused.
- Never commit `.env` or `.vault-state.json` (both gitignored).
- Sandbox accounts and passwords are test values. For the submission, put them in the Devpost
  testing instructions, not in the repo.

## References

- [Save PayPal with the Payment Method Tokens API](https://developer.paypal.com/docs/checkout/save-payment-methods/purchase-later/payment-tokens-api/paypal/)
- [Payment Method Tokens API v3 reference](https://developer.paypal.com/docs/api/payment-tokens/v3/)
- [Orders API v2 reference](https://developer.paypal.com/docs/api/orders/v2/)
- [Sandbox accounts](https://developer.paypal.com/api/rest/sandbox/accounts)
