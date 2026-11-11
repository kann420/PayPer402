'use client';

import { useState } from 'react';
import { C, K, S } from '../ui/code';

const SNIPPET = `import { paymentMiddleware } from "@x402/express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { PayPalBatchServerScheme } from "@payper402/scheme-paypal";

const auth = { Authorization: \`Bearer \${process.env.PAYPER402_SELLER_KEY}\` };
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
  "GET /v1/hotels/search":           paid("$0.02", "Hotel Search API"),
  "GET /v1/hotels/rates":            paid("$0.01", "Room Rates API"),
  "POST /v1/hotels/reviews/summary": paid("$0.05", "Review Summary API"),
  "GET /v1/places/walk":             paid("$0.01", "Walking Time API"),
  "GET /v1/hotels/forecast":         paid("$0.25", "Price Forecast API (premium)"),
}, resourceServer));
`;

/** The integration card: the full seller snippet of fixes §5.4, with Copy. */
export function IntegrationCard() {
  const [copied, setCopied] = useState(false);
  return (
    <section className="min-w-0 overflow-hidden rounded-[14px] bg-ink-950 text-dark-text">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-dark-line px-4 py-3">
        <strong className="text-sm">Integration · Express · server.js</strong>
        <span className="font-mono text-xs text-dark-muted">@x402/express + PayPal scheme</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(SNIPPET).then(() => setCopied(true));
          }}
          className="ml-auto h-8 rounded-lg border border-[#34403B] bg-transparent px-3 text-[13px] text-dark-text"
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </header>
      <pre className="m-0 overflow-x-auto p-[18px] font-mono text-[13px] leading-[1.7] text-ink-200">
        <K>import</K> {'{ paymentMiddleware }'} <K>from</K> <S>&quot;@x402/express&quot;</S>;{'\n'}
        <K>import</K> {'{ HTTPFacilitatorClient, x402ResourceServer }'} <K>from</K> <S>&quot;@x402/core/server&quot;</S>;{'\n'}
        <K>import</K> {'{ PayPalBatchServerScheme }'} <K>from</K> <S>&quot;@payper402/scheme-paypal&quot;</S>;{'\n\n'}
        <K>const</K> auth = {'{'} Authorization: <S>{'`Bearer ${process.env.PAYPER402_SELLER_KEY}`'}</S> {'};'}
        {'\n'}
        <K>const</K> facilitator = <K>new</K> <C>HTTPFacilitatorClient</C>
        {'({\n  url: '}
        <S>&quot;https://payper402.example/x402&quot;</S>,{'\n  createAuthHeaders: '}
        <K>async</K> () =&gt; ({'{ verify: auth, settle: auth, supported: auth }'}),{'\n});\n'}
        <K>const</K> resourceServer = <K>new</K> <C>x402ResourceServer</C>(facilitator){'\n  .'}
        <C>register</C>(<S>&quot;paypal:*&quot;</S>, <K>new</K> <C>PayPalBatchServerScheme</C>());{'\n\n'}
        <K>const</K> paid = (price, description) =&gt; {'({\n  accepts: { scheme: '}
        <S>&quot;batch-settlement&quot;</S>, network: <S>&quot;paypal:sandbox&quot;</S>,{'\n             payTo: process.env.PAYPER402_SELLER_ID, price },\n  description,\n  mimeType: '}
        <S>&quot;application/json&quot;</S>,{'\n});\n\n'}
        app.<C>use</C>(<C>paymentMiddleware</C>
        {'({\n  '}
        <S>&quot;GET /v1/hotels/search&quot;</S>:{'           '}
        <C>paid</C>(<S>&quot;$0.02&quot;</S>, <S>&quot;Hotel Search API&quot;</S>),{'\n  '}
        <S>&quot;GET /v1/hotels/rates&quot;</S>:{'            '}
        <C>paid</C>(<S>&quot;$0.01&quot;</S>, <S>&quot;Room Rates API&quot;</S>),{'\n  '}
        <S>&quot;POST /v1/hotels/reviews/summary&quot;</S>:{' '}
        <C>paid</C>(<S>&quot;$0.05&quot;</S>, <S>&quot;Review Summary API&quot;</S>),{'\n  '}
        <S>&quot;GET /v1/places/walk&quot;</S>:{'             '}
        <C>paid</C>(<S>&quot;$0.01&quot;</S>, <S>&quot;Walking Time API&quot;</S>),{'\n  '}
        <S>&quot;GET /v1/hotels/forecast&quot;</S>:{'         '}
        <C>paid</C>(<S>&quot;$0.25&quot;</S>, <S>&quot;Price Forecast API (premium)&quot;</S>),{'\n}, resourceServer));'}
      </pre>
    </section>
  );
}
