# @payper402/scheme-paypal

x402 v2 binding for PayPal: the `batch-settlement` scheme on network `paypal:sandbox`, asset
`USD`, amounts in integer cents.

It plugs into the official x402 SDK (`@x402/core` 2.28.0) the same way the EVM schemes do, with
one plug-in per role:

| Role | Class | SDK interface |
|---|---|---|
| Agent (client) | `PayPalBatchClientScheme` | `SchemeNetworkClient` |
| Seller (resource server) | `PayPalBatchServerScheme` | `SchemeNetworkServer` |
| Facilitator | `PayPalBatchFacilitatorScheme` | `SchemeNetworkFacilitator` |

An agent signs one Ed25519 commitment per paid request. The facilitator verifies it, checks the
operator's caps and records it in a ledger. Recorded commitments are charged to the operator's
PayPal account later, in batches. This package moves no money: it contains the protocol logic,
storage interfaces (`AgentRegistry`, `CommitmentLedger`) and in-memory implementations of them.

The protocol rules are in the binding spec:
[`docs/spec/scheme_batch_settlement_paypal.md`](../../docs/spec/scheme_batch_settlement_paypal.md).

## Agent (client)

```ts
import { x402Client } from '@x402/core/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { PAYPAL_NETWORK_FAMILY, PayPalBatchClientScheme, generateAgentKey } from '@payper402/scheme-paypal';

const agentKey = generateAgentKey(); // register agentKey.kid and agentKey.publicKeyX with the facilitator

const client = new x402Client().register(
  PAYPAL_NETWORK_FAMILY,
  new PayPalBatchClientScheme({ privateKey: agentKey.privateKey }),
);
const payingFetch = wrapFetchWithPayment(fetch, client);

const res = await payingFetch('https://seller.example/api/quote');
```

Keys can be stored and restored with `exportPrivateKeyJwk` / `importPrivateKeyJwk` (or the raw
base64url seed with `exportPrivateKeyRaw` / `importPrivateKeyRaw`). Treat them as secrets.

### Client spend cap: $1 per payment by default

The SDK's `x402Client` refuses any single payment above **$1 (100 cents)** unless told otherwise.
The client scheme reports `USD` on `paypal:*` as a default asset, so this cap applies. To pay
more per call, raise it:

```ts
client.setSpendControls({ maxAmountPerPayment: '$5' });
```

The facilitator still enforces the operator's own caps (per call, per day, unsettled, total).

## Seller (resource server)

```ts
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentOption } from '@x402/core/http';
import { x402ResourceServer } from '@x402/core/server';
import { paymentMiddleware, setSettlementOverrides } from '@x402/express';
import {
  PAYPAL_NETWORK_FAMILY,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchServerScheme,
  localFacilitatorClient,
} from '@payper402/scheme-paypal';

const facilitator = new x402Facilitator(); // see the next section
const resourceServer = new x402ResourceServer(localFacilitatorClient(facilitator)).register(
  PAYPAL_NETWORK_FAMILY,
  new PayPalBatchServerScheme(),
);
await resourceServer.initialize();

// The annotation keeps `network` typed as a Network rather than widening it to string.
const accepts = (price: string): PaymentOption => ({
  scheme: 'batch-settlement',
  network: PAYPAL_SANDBOX_NETWORK,
  payTo: 'seller_7Qm2', // seller id issued by the facilitator
  price,
});

const app = express();
app.use(
  paymentMiddleware(
    {
      'GET /api/quote': { accepts: accepts('$0.05') },
      'GET /api/summary': { accepts: accepts('$0.10') }, // advertised maximum
    },
    resourceServer,
  ),
);
app.get('/api/quote', (_req, res) => {
  res.json({ quote: 42 });
});
app.get('/api/summary', (_req, res) => {
  setSettlementOverrides(res, { amount: '4' }); // actual price in cents, at most the maximum
  res.json({ summary: '...' });
});
```

Prices may be `"$0.05"`, `"0.05"`, `0.05` or `{ asset: "USD", amount: "5" }` (cents). The server
scheme adds `extra.version` and caps `maxTimeoutSeconds` at 300.

Settlement overrides may also be given as `"$0.04"` (converted to cents with the scheme's
`getAssetDecimals`; extra decimals are dropped, so `"$0.049"` settles 4 cents: truncated, not
rounded) or `"40%"` (of the advertised maximum, floored). The SDK does not
bound overrides itself; the facilitator rejects any settle amount below 1 cent or above the
signed `maxAmount` with `amount_exceeds_commitment`.

## Facilitator

```ts
import { x402Facilitator } from '@x402/core/facilitator';
import {
  InMemoryAgentRegistry,
  InMemoryCommitmentLedger,
  PAYPAL_SANDBOX_NETWORK,
  PayPalBatchFacilitatorScheme,
} from '@payper402/scheme-paypal';

const agents = new InMemoryAgentRegistry()
  .addOperator({ operatorId: 'op_1', walletStatus: 'active', caps: { perCall: 25, daily: 100, unsettled: 50 } })
  .addAgent({ agentId: 'agent_1', kid: agentKey.kid, publicKeyX: agentKey.publicKeyX, operatorId: 'op_1', status: 'active' });
const ledger = new InMemoryCommitmentLedger();

// Register on the concrete network: the resource server matches supported kinds exactly.
const facilitator = new x402Facilitator().register(
  PAYPAL_SANDBOX_NETWORK,
  new PayPalBatchFacilitatorScheme({ agents, ledger }),
);
```

`localFacilitatorClient(facilitator)` calls it in process. It has no caller authentication, so
use it only for tests and single-process setups; a facilitator reached over HTTP must
authenticate sellers (see the binding spec).

## Errors over HTTP

Through `@x402/express`, a verify failure reaches the client as the `error` field of the decoded
`PAYMENT-REQUIRED` header, and a settle failure as `errorReason` in the decoded
`PAYMENT-RESPONSE` header. Only the code travels; `invalidMessage` and `extra` (such as
`extra.cap`) are visible only to direct callers of the facilitator. The codes are exported as
`ErrorCode`.

## Tests

`npm test` from the repository root runs unit tests for every module, `src/plumbing.test.ts`
(SDK wiring with a fake scheme) and `src/e2e.test.ts` (Express + fetch end to end).
