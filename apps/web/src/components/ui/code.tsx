import type { ReactNode } from 'react';

/** Code colours of the DesignSystem board. */
export const K = ({ children }: { children: ReactNode }) => <span className="text-code-keyword">{children}</span>;
export const S = ({ children }: { children: ReactNode }) => <span className="text-code-string">{children}</span>;
export const C = ({ children }: { children: ReactNode }) => <span className="text-code-call">{children}</span>;
export const M = ({ children }: { children: ReactNode }) => <span className="text-code-comment">{children}</span>;

/** A dark code block, as on the boards. Text only; never HTML from data. */
export function CodeBlock({ children, size = 13.5, label }: { children: ReactNode; size?: number; label?: string }) {
  return (
    <pre
      aria-label={label}
      className="m-0 overflow-x-auto rounded-xl bg-ink-950 p-[18px] font-mono leading-[1.7] text-ink-200"
      style={{ fontSize: size }}
    >
      {children}
    </pre>
  );
}

/** The `.env` snippet after creating an agent (fixes §5.5, with `AGENT_PRIVATE_KEY`). */
export function EnvSnippet({ name, seed }: { name: string; seed: string }) {
  return (
    <CodeBlock label={`.env for ${name}`}>
      <M># .env for {name}</M>
      {'\n'}AGENT_PRIVATE_KEY=<S>{seed}</S>
    </CodeBlock>
  );
}

/** "Use it in your agent" (fixes §5.5, with `AGENT_PRIVATE_KEY`). */
export function AgentSnippet() {
  return (
    <CodeBlock size={12.5} label="Use it in your agent">
      <K>import</K> {'{ x402Client }'} <K>from</K> <S>&quot;@x402/core/client&quot;</S>;{'\n'}
      <K>import</K> {'{ wrapFetchWithPayment }'} <K>from</K> <S>&quot;@x402/fetch&quot;</S>;{'\n'}
      <K>import</K> {'{ PayPalBatchClientScheme, importPrivateKeyRaw }'} <K>from</K> <S>&quot;@payper402/scheme-paypal&quot;</S>;{'\n\n'}
      <K>const</K> client = <K>new</K> <C>x402Client</C>().<C>register</C>(<S>&quot;paypal:*&quot;</S>, <K>new</K> <C>PayPalBatchClientScheme</C>
      {'({'}
      {'\n'}
      {'  '}privateKey: <C>importPrivateKeyRaw</C>(process.env.AGENT_PRIVATE_KEY),{'\n'}
      {'}));'}
      {'\n'}
      <K>const</K> payingFetch = <C>wrapFetchWithPayment</C>(fetch, client);{'\n\n'}
      <K>const</K> res = <K>await</K> <C>payingFetch</C>(<S>&quot;https://api.acme.example/v1/hotels/search?city=kyoto&amp;checkIn=2027-03-30&amp;checkOut=2027-04-02&quot;</S>);
    </CodeBlock>
  );
}
