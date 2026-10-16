# Scheme: `batch-settlement` on `paypal:sandbox`

> Status: draft 1.0.0 (2026-10). Normative keywords follow RFC 2119.

## Summary

The `batch-settlement` scheme on the PayPal network lets a client (typically an AI agent) pay for
HTTP resources with signed payment commitments that are settled later, in batches, by charging a
PayPal account the client's operator linked once.

- **Network identifier:** `paypal:sandbox`. A production binding would use `paypal:live`; it is
  out of scope for this version.
- **Trust model:** credit-backed (see
  [`scheme_batch_settlement.md`](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md#credit-backed)).
  The facilitator underwrites access and is the merchant of record.
- **Asset:** `USD` (ISO 4217). Amounts are integer **cents**, as base-10 strings.
- **Authentication:** an Ed25519 signature over a canonical commitment, made with a key the
  operator registered with the facilitator.

The binding follows the same pattern as `cloudflare:402`: a fiat, credit-backed network where a
registered identity backs every commitment. The difference is the billing identity. Here it is a
PayPal wallet saved with the PayPal Vault v3 API (`usage_type: MERCHANT`,
`usage_pattern: UNSCHEDULED_POSTPAID`) and charged with PayPal Orders v2.

## Roles

| Role | Description |
|---|---|
| **Operator** | Person or business running one or more agents. Links a PayPal wallet once and sets caps. |
| **Agent** (client) | Holds an Ed25519 private key registered to an operator. Signs one commitment per paid request. |
| **Resource server** (seller) | Serves paid HTTP resources. Registered with the facilitator; its id is the `payTo` value. |
| **Facilitator** | Verifies commitments, keeps the commitment ledger, enforces caps, charges the operator's PayPal wallet in batches (redemption), and pays sellers. |

## Setup (out of band, once)

1. The operator signs in to the facilitator and links a PayPal wallet:
   - The facilitator creates a Vault v3 setup token with `payment_source.paypal`,
     `usage_type: MERCHANT` and `usage_pattern: UNSCHEDULED_POSTPAID`.
   - The operator approves it on PayPal.
   - The facilitator exchanges the setup token for a payment token (`vault_id`) and stores it.
     The wallet status becomes `active`.
2. The operator sets caps: per call, per UTC day, unsettled, and (optionally) total.
3. The operator registers one or more agent public keys. Each key's id (`kid`, defined below) is
   derived from the public key.
4. Each seller registers with the facilitator and receives a seller id, used as `payTo`.

## Payment flow (per request)

1. The agent requests a resource.
2. The resource server answers `402 Payment Required` with a `PAYMENT-REQUIRED` header listing a
   `batch-settlement` / `paypal:sandbox` requirement.
3. The agent builds a commitment for that requirement, signs it, and retries with a
   `PAYMENT-SIGNATURE` header.
4. The resource server asks the facilitator to **verify** the payload (`authorization` flow:
   verify before the handler). On failure it answers `402` with the reason.
5. The resource server runs the handler.
6. The resource server asks the facilitator to **settle** with the actual price. The actual
   price is less than or equal to the committed maximum; resource servers set it with settlement
   overrides. In this scheme, settle **records** the commitment in the ledger and moves no money.
7. The resource server returns the response with a `PAYMENT-RESPONSE` header carrying the
   commitment id and the charged amount.
   - If settle fails, the resource server discards the handler output and answers `402`.
     `PAYMENT-RESPONSE.errorReason` carries the settle error.
8. Later, the facilitator **redeems** unsettled commitments by charging the operator's PayPal
   wallet in one order (see [Redemption](#redemption)).

If the handler fails (status 400 or above, or it throws), settle is not called and nothing is
recorded, so the operator is not charged for that request.

## PaymentRequirements

```json
{
  "scheme": "batch-settlement",
  "network": "paypal:sandbox",
  "asset": "USD",
  "amount": "5",
  "payTo": "seller_7Qm2...",
  "maxTimeoutSeconds": 120,
  "extra": {
    "version": "1.0.0"
  }
}
```

| Field | Rule |
|---|---|
| `scheme` | MUST be `"batch-settlement"`. |
| `network` | MUST be `"paypal:sandbox"`. |
| `asset` | MUST be `"USD"`. |
| `amount` | Maximum price for this request, in cents, as a base-10 integer string with no sign, decimal point or leading zeros. MUST be at least `1`. |
| `payTo` | Seller id issued by the facilitator. |
| `maxTimeoutSeconds` | Longest commitment lifetime the server accepts. The reference SDK sets it to `300` when the route omits it. MUST be at most `300`. A value that is not a positive integer counts as absent, that is `300`. |
| `extra.version` | Binding version, semver. Clients SHOULD reject a major version they do not know. |

## PAYMENT-SIGNATURE payload

The standard x402 v2 `PaymentPayload`, base64 encoded, with this `payload`:

```json
{
  "x402Version": 2,
  "resource": { "url": "https://seller.example/api/quote?ticker=ACME" },
  "accepted": { "...": "the PaymentRequirements above" },
  "payload": {
    "commitment": {
      "v": 1,
      "id": "q3V9mJr0Tn6w8dYk2bXo4A",
      "kid": "Wc1t0r...43 chars",
      "network": "paypal:sandbox",
      "asset": "USD",
      "payTo": "seller_7Qm2...",
      "maxAmount": "5",
      "iat": 1760500000,
      "exp": 1760500120
    },
    "signature": "base64url, 64 bytes Ed25519"
  }
}
```

### Commitment fields

| Field | Type | Rule |
|---|---|---|
| `v` | integer | Commitment format version. MUST be `1`. |
| `id` | string | 16 random bytes, base64url without padding (22 chars). Unique per commitment. It is also the commitment identifier. |
| `kid` | string | Key id of the signing agent key: base64url (no padding) of SHA-256 over the raw 32-byte Ed25519 public key (43 chars). |
| `network` | string | MUST equal `PaymentRequirements.network`. |
| `asset` | string | MUST equal `PaymentRequirements.asset`. |
| `payTo` | string | MUST equal `PaymentRequirements.payTo`. |
| `maxAmount` | string | MUST equal `PaymentRequirements.amount`. This is the most the facilitator may record for this commitment. |
| `iat` | integer | Issued-at, Unix seconds. |
| `exp` | integer | Expiry, Unix seconds. `iat < exp <= iat + maxTimeoutSeconds`. Clients SHOULD use a shorter lifetime; the reference client uses 120 seconds. |

The `payload` object carries exactly `commitment` and `signature`. Facilitators ignore any other
key in it (it is not signed and not stored). The `commitment` object, by contrast, is strict: an
unknown field fails verification step 1.

The resource URL is **not** signed. The scheme client interface of the reference SDK does not
receive it, and replay is prevented by `id` alone. The facilitator records
`PaymentPayload.resource.url` for reporting only.

### Signature

```
message   = "payper402/commitment/v1\n" || canonical(commitment)
signature = Ed25519.sign(agentPrivateKey, UTF-8(message))
```

- `canonical()` is the JSON Canonicalization Scheme (RFC 8785). For this commitment, which holds
  only ASCII strings and small non-negative integers, that is equivalent to `JSON.stringify` of an
  object with keys sorted by code point, with no whitespace.
- The domain prefix keeps commitment signatures from being reused as any other kind of signature.
- `signature` is the 64-byte Ed25519 signature, base64url without padding.

## Verification

The facilitator MUST run these checks in order and stop at the first failure. The
`invalidReason` for each check is listed in [Error codes](#error-codes).

1. **Payload shape.**
   - `payload.commitment` and `payload.signature` are present.
   - `v == 1`, every field has the right type and format, and `signature` decodes to 64 bytes.
   - `PaymentRequirements.amount` is a valid cents string of at least `1`. It comes from the
     resource server and MUST be validated, not trusted.
2. **Requirements match.** The requirements name this binding (`scheme` `batch-settlement`, network
   `paypal:sandbox`, asset `USD`); the commitment's `network`, `asset` and `payTo` equal the
   requirements'; and `commitment.maxAmount == requirements.amount`.
3. **Freshness.**
   - `iat <= now + 30` (clock skew allowance).
   - `now < exp`.
   - `exp - iat <= min(requirements.maxTimeoutSeconds || 300, 300)`.
4. **Agent.** `kid` resolves to a registered agent key whose status is `active`.
5. **Signature.** The Ed25519 signature verifies over `message` with that key.
6. **Wallet.** The agent's operator has a linked PayPal wallet with status `active`. Wallets that
   are `revoked` or `unlinked` fail.
7. **Replay.** No commitment with this `id` has been recorded.
8. **Caps.** With `amount = requirements.amount`, all of these hold for the operator:
   - `amount <= perCall`
   - `spentToday + amount <= daily`, counted per UTC day and including both settled and
     unsettled usage
   - `unsettled + amount <= unsettledCap`
   - if a total cap is set, `spentTotal + amount <= total`

   `unsettled` counts recorded commitments in state `unsettled` or `settling`; `spentTotal` counts
   every recorded commitment, in any state. The caps are checked in the order listed, and the
   first one that fails is reported in `extra.cap`.

A successful `/verify` response:

```json
{
  "isValid": true,
  "payer": "agent_3Fz...",
  "extra": { "unsettledAmount": "130", "unsettledCap": "500" }
}
```

## Settlement (commit and accumulate)

`/settle` receives the same payload and the requirements, where `amount` may have been lowered by
settlement overrides to the actual price. The facilitator MUST:

0. **Short-circuit identical retries.** Check the payload shape (the `payload.commitment` and
   `payload.signature` part of step 1), then look up `commitment.id` in the ledger. If a record
   exists with the same `payloadHash`, return the original result at once, before the wallet,
   expiry and amount checks below and whatever the retry's settle `amount` is. This path only
   reads the ledger; it records nothing. Otherwise continue with step 1.
   - Over HTTP, the seller-owns-`payTo` check (see
     [Trust model](#trust-model-and-guarantees)) MUST run before this short-circuit, against the
     `payTo` of the recorded commitment, so that only the seller named in the commitment can read
     its result back.
1. **Re-run verification steps 1 to 6**, because wallet status may have changed since `/verify`.
   - In step 1, the cents-string check applies to `paymentPayload.accepted.amount` (the
     advertised maximum). The settle `amount` (`requirements.amount`) only has to be a base-10
     integer string with no sign, decimal point or leading zeros (`"0"` is allowed here);
     anything else fails with `payload`.
   - In step 2, `commitment.maxAmount` MUST equal `paymentPayload.accepted.amount`.
   - Then the settle `amount` (the actual price) MUST satisfy `1 <= amount <=
     commitment.maxAmount`. Otherwise fail with `amount_exceeds_commitment`. Resource servers
     can set any override, so this check is load-bearing.
   - In step 3, the expiry check becomes `now < exp + 60`. The 60-second grace covers handler
     run time. The ledger, not expiry, is what bounds money.
2. **Atomically, per operator**, decide replay and idempotency, re-check caps, and record:
   - **Same `id`, same `payloadHash`:** it is a retry that raced the first settle past step 0.
     Return the original result (see the note on `extra` below), whatever the retry's settle
     `amount` is.
     `payloadHash` is SHA-256 over `canonical(commitment)` plus the signature; it does not
     include the settle amount.
   - **Same `id`, different `payloadHash`:** fail with `replay`.
   - **New `id`:** re-check the caps (step 8) with the actual `amount`, then insert the
     commitment, keyed by `id`. Store the actual `amount`, `maxAmount`, `kid`, agent, operator,
     `payTo`, resource URL, `iat`, the receive time (`recordedAt`) and `payloadHash`, with state
     `unsettled`.

A successful `/settle` response, which the resource server returns as `PAYMENT-RESPONSE`:

```json
{
  "success": true,
  "transaction": "q3V9mJr0Tn6w8dYk2bXo4A",
  "network": "paypal:sandbox",
  "payer": "agent_3Fz...",
  "amount": "4",
  "extra": { "chargedAmount": "4", "unsettledAmount": "134" }
}
```

- `transaction` is the commitment identifier (`commitment.id`). It is non-empty, as the generic
  scheme requires. No money has moved yet.
- `amount` and `extra.chargedAmount` are the actual charge in cents.
- Clients MUST treat `extra` as informational only. On a retry answered with the original
  result, `success`, `transaction`, `payer`, `amount` and `extra.chargedAmount` are the original
  values, while `extra.unsettledAmount` reflects the ledger at the time of the retry.

### Known limitation: concurrent requests

Verification happens before the handler and recording after it. Several concurrent requests from
one operator can each pass verification, and later fail the cap re-check at settle. The resource
server then discards the handler's output and answers `402` with the settle error. No money is at
risk: the seller has not delivered the response, and the operator has not been charged. The cost
is wasted handler work. Version 1.0.0 accepts this. A later version may reserve the amount at
verify time.

## Commitment expiry

- A commitment is valid for verification from `iat - 30` until `exp`, and for settlement until
  `exp + 60`.
- Its lifetime (`exp - iat`) is at most `maxTimeoutSeconds`, and never more than 300 seconds.
- An expired commitment that was never recorded is invalid. Nothing needs to be stored for it.
- A recorded commitment does not expire. It stays in the ledger until it is redeemed or marked
  uncollectable.

## Daily cap accounting

The daily cap counts the `amount` of every commitment whose `recordedAt` falls in the current UTC
calendar day, whether settled or not.

## Redemption

Redemption is network-defined. In this binding the facilitator triggers it; clients and resource
servers do not.

- **Triggers:**
  - when an operator's unsettled total reaches its unsettled cap
  - once per UTC day for any operator with unsettled commitments
  - when the operator unlinks the wallet
- **Charge:**
  - One PayPal Orders v2 order with `intent: CAPTURE`,
    `payment_source.paypal.vault_id = <operator vault_id>`, and `amount` equal to the **exact sum**
    of the commitments in the batch, converted from cents to a `"D.CC"` string.
  - The order is created, and captured if needed, with a `PayPal-Request-Id` derived from the
    batch id, so a retried redemption cannot charge twice.
- **Bound:** the facilitator MUST NOT charge more than the sum of recorded, unsettled commitments
  for that operator. Each recorded amount is itself at most a signed `maxAmount`.
- **Outcome:**
  - On capture `COMPLETED`, the batch's commitments become `settled`, referencing the PayPal order
    and capture ids.
  - On `PENDING`, they stay `settling` until a webhook or a poll resolves them.
- **Revocation:**
  - The operator can cancel the billing agreement from their PayPal account at any time. PayPal
    then rejects charges with `AGREEMENT_ALREADY_CANCELLED`, and returns `TOKEN_NOT_FOUND` for the
    token.
  - On either error, or on the `VAULT.PAYMENT-TOKEN.DELETED` webhook, the facilitator MUST set the
    wallet to `revoked`. From then on, verification fails at step 6 with `wallet_revoked`.
  - Commitments still unsettled at that point are uncollectable. This is the credit risk the
    unsettled cap bounds.
  - If the operator links a wallet again after revocation, the facilitator MUST settle the
    outstanding uncollectable commitments with the new wallet before it sets the wallet to
    `active` again.
- **Seller payout:** out of band; PayPal Payouts is optional. The facilitator is merchant of
  record.

## Double-spend prevention

- `commitment.id` is unique across the ledger (unique key). A recorded `id` is never recorded
  again: verification step 7 rejects it, and the atomic settle record step either returns the
  original result (identical retry) or fails with `replay`.
- Commitments expire after at most 300 seconds. Unrecorded expired commitments are simply
  invalid, so the ledger only needs to remember ids it actually recorded.
- A commitment is redeemed at most once: a commitment is in exactly one batch, and batch charges
  use idempotent PayPal request ids.

## Trust model and guarantees

- **Seller:** paid by the facilitator for every successfully settled commitment, whether or not
  the facilitator manages to collect from the operator. The facilitator carries the credit risk,
  bounded per operator by the unsettled cap.
- **Operator:** can only be charged in sums of commitments their own agent keys signed, each at
  most its signed `maxAmount`, and within their caps. They can stop all future charges by
  revoking in PayPal.
- **Facilitator:** trusted to keep the ledger honestly, as with any credit-backed network.
- **Resource server authentication:**
  - When the facilitator is reached over HTTP, it MUST authenticate `/verify` and `/settle`
    callers.
  - It MUST reject a settle whose authenticated seller does not own `payTo`.
  - So a leaked `PAYMENT-SIGNATURE` is only usable by the seller named in `payTo`, once, and only
    until it expires.
  - An in-process facilitator, as used in tests, has no network boundary and needs no
    authentication.
- **Audience:** a commitment does not name its facilitator, so `payTo` only means something
  within one facilitator. Version 1.0.0 assumes one facilitator per agent key. A later version
  may add an `aud` field.

## Error codes

`invalidReason` / `errorReason` values:

| Code | Step | Meaning |
|---|---|---|
| `invalid_batch_settlement_paypal_payload` | 1 | Malformed payload or requirements. |
| `invalid_batch_settlement_paypal_requirements_mismatch` | 2 | Commitment does not match the requirements. |
| `invalid_batch_settlement_paypal_expired` | 3 | Expired, not yet valid, or lifetime too long. |
| `invalid_batch_settlement_paypal_unknown_agent` | 4 | `kid` not registered. |
| `invalid_batch_settlement_paypal_agent_disabled` | 4 | Agent key disabled by the operator. |
| `invalid_batch_settlement_paypal_signature` | 5 | Signature does not verify. |
| `invalid_batch_settlement_paypal_wallet_not_linked` | 6 | Operator has no linked PayPal wallet. |
| `invalid_batch_settlement_paypal_wallet_revoked` | 6 | Operator revoked the PayPal billing agreement. |
| `invalid_batch_settlement_paypal_replay` | 7 / settle | Commitment id already used. |
| `invalid_batch_settlement_paypal_cap_exceeded` | 8 / settle | A cap would be exceeded. `extra.cap` names it: `perCall`, `daily`, `unsettled` or `total`. |
| `invalid_batch_settlement_paypal_amount_exceeds_commitment` | settle | Settle amount is above the signed `maxAmount`, or below 1. |

Over HTTP, the reference SDK carries only the code. It puts verify failures in the decoded
`PAYMENT-REQUIRED` header's `error` field, and settle failures in `PAYMENT-RESPONSE.errorReason`.
The `invalidMessage` and `extra` fields (such as `extra.cap`) are visible only to callers of the
facilitator itself.

## Facilitator `/supported`

```json
{
  "kinds": [
    { "x402Version": 2, "scheme": "batch-settlement", "network": "paypal:sandbox", "extra": { "version": "1.0.0" } }
  ],
  "extensions": [],
  "signers": { "paypal:*": [] }
}
```

## Version history

| Version | Date | Changes |
|---|---|---|
| `1.0.0` | 2026-10 | Initial draft. Updated while building the reference implementation. Changes: in settle, step 1 validates `accepted.amount` and only requires the settle amount to be a base-10 integer, so an override of `"0"` fails with `amount_exceeds_commitment` rather than `payload`; settle answers an identical retry from the ledger (step 0) before the wallet, expiry and amount checks. Clarifications: the requirements checked in step 2, the definitions of `unsettled` and `spentTotal`, the cap order, `maxTimeoutSeconds` values that are not positive integers, unknown keys in the outer `payload`, `extra` on retries, re-linking after revocation, and the `/supported` signers shape the reference SDK returns. |
