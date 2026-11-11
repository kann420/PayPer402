# Proof it settles on PayPal

PayPal has no public explorer like a blockchain does: every transaction is private to the two
accounts involved, sandbox included. PayPer402 makes each charge checkable instead, in three
independent ways.

## The charge in the demo video

| | Value |
|---|---|
| PayPer402 charge id (PayPal invoice ID) | `stl_r9w3BstpesahF-tzV_zDaA` |
| PayPal transaction (capture) ID | `4M443028VK142725B` |
| Amount | $0.17 USD, for 8 paid calls |
| Date | November 11, 2026 (PayPal sandbox) |

The video shows this charge on the PayPer402 dashboard, then the same payment in the payer's
PayPal sandbox account, and then the payer stopping the agreement.

## 1. The ids match on both sides

Every PayPal charge is one Orders v2 capture, and PayPer402 sends its own charge id to PayPal as the
order's `invoice_id`. So the charge page in PayPer402 and the payment in the payer's PayPal account
show the same values:

| PayPer402 charge page | Payer's PayPal account (Activity → the payment) |
|---|---|
| Charge id `stl_…` | Invoice ID `stl_…` |
| PayPal capture id | Transaction ID |
| Amount and paid calls | Amount, and "PayPer402 usage: N paid calls" |

## 2. Verify with PayPal

On any completed charge (PayPal charges → a charge), the **Verify with PayPal** button reads the
capture straight from the PayPal API (`GET /v2/payments/captures/{id}`) and compares it with the
ledger: capture found, status `COMPLETED`, amount, currency, invoice id and order id. It writes
nothing. The code is in
[`apps/facilitator/src/services/verify.ts`](../apps/facilitator/src/services/verify.ts).

## 3. Log in and look

With the sandbox test accounts from the Devpost testing instructions, open
<https://www.sandbox.paypal.com>.

- The **Personal** account shows each charge under Activity. The PayPer402 agreement is under
  Settings → Payments → Automatic payments, where "Stop paying with PayPal" revokes it.
- The **Business** account shows the same payments received.
