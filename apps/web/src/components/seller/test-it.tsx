'use client';

import { useState } from 'react';
import { errorCopy } from '@/lib/copy';

interface Service {
  id: string;
  name: string;
  method: string;
  path: string;
}

interface ProbeResult {
  status: number;
  statusText: string;
  headers: Record<string, string | null>;
  decoded: unknown;
  request: string;
  ms: number;
}

const PAID_EXAMPLE = `{
  "success": true,
  "transaction": "q3V9mJr0Tn6w8dYk2bXo4A",
  "network": "paypal:sandbox",
  "amount": "2"
}`;

function truncate(value: string, n = 32): string {
  return value.length > n ? `${value.slice(0, n)}…` : value;
}

/** "Test it" (design spec §10.11): a real unpaid request, plus a static "Example after payment". */
export function TestIt({ services }: { services: Service[] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? '');
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const service = services.find((s) => s.id === serviceId);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/seller/probe/${encodeURIComponent(serviceId)}`, { cache: 'no-store' });
      const body = (await res.json()) as ProbeResult & { error?: string; message?: string };
      if (!res.ok) {
        setResult(null);
        setError(errorCopy(body.error ?? 'error', body.message ?? 'The request failed.'));
      } else {
        setResult(body);
      }
    } catch {
      setError("We couldn't reach PayPer402. Check your connection.");
    } finally {
      setBusy(false);
    }
  };

  const decoded = result?.decoded;
  const amount = (() => {
    const accepts = (decoded as { accepts?: { amount?: string }[] } | undefined)?.accepts;
    const cents = Number(accepts?.[0]?.amount);
    return Number.isFinite(cents) ? `$${(cents / 100).toFixed(2)}` : undefined;
  })();

  return (
    <section className="min-w-0 overflow-hidden rounded-[14px] border border-line-200 bg-white">
      <header className="flex flex-wrap items-center gap-2.5 border-b border-ground-100 px-4 py-3">
        <strong className="text-sm">Test it</strong>
        <label htmlFor="probe-service" className="sr-only">
          Endpoint
        </label>
        <select id="probe-service" value={serviceId} onChange={(e) => setServiceId(e.target.value)} className="h-[34px] rounded-lg border border-line-300 bg-white px-2 font-mono text-[13px]">
          {services.map((s) => (
            <option key={s.id} value={s.id}>
              {s.method} {s.path}
            </option>
          ))}
        </select>
        <span className="text-[13px] text-ink-700">{service?.name}</span>
        <button
          type="button"
          disabled={busy || service === undefined}
          onClick={() => void send()}
          className="ml-auto h-[34px] rounded-lg border-0 bg-ink-950 px-3 text-[13px] font-semibold text-white disabled:opacity-70"
        >
          {busy ? 'Sending…' : 'Send unpaid request'}
        </button>
      </header>
      {error === null ? null : (
        <p role="alert" className="m-0 border-b border-ground-100 px-4 py-3 text-sm text-red-800">
          {error}
        </p>
      )}
      {result === null ? (
        <p className="m-0 px-4 py-4 text-sm text-ink-700">Send an unpaid request to see the real 402 answer and its decoded PAYMENT-REQUIRED header.</p>
      ) : (
        <div aria-live="polite" className="grid gap-3.5 px-4 py-3.5 [grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr))]">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-[13px] font-semibold ${result.status === 402 ? 'border-amber-300 bg-amber-100 text-amber-800' : 'border-line-300 bg-ground-50 text-ink-800'}`}
              >
                {result.status}
              </span>
              <span className="text-sm">{result.statusText || 'Payment Required'}</span>
              <span className="ml-auto font-mono text-xs text-ink-500">{result.ms} ms</span>
            </div>
            <pre className="m-0 overflow-x-auto rounded-[10px] bg-ground-50 p-3.5 font-mono text-[12.5px] leading-[1.65]">
              <span className="text-ink-500"># {result.request}</span>
              {'\n'}
              <span className="text-ink-500">HTTP/1.1</span> {result.status} {result.statusText}
              {result.headers['payment-required'] === null || result.headers['payment-required'] === undefined ? null : (
                <>
                  {'\n'}
                  <span className="text-ink-500">PAYMENT-REQUIRED:</span> {truncate(result.headers['payment-required'])}
                </>
              )}
              {result.headers['content-type'] ? (
                <>
                  {'\n'}
                  <span className="text-ink-500">content-type:</span> {result.headers['content-type']}
                </>
              ) : null}
              {result.headers['cache-control'] ? (
                <>
                  {'\n'}
                  <span className="text-ink-500">cache-control:</span> {result.headers['cache-control']}
                </>
              ) : null}
            </pre>
          </div>
          <div className="flex min-w-0 flex-col gap-2">
            <span className="text-[13px] font-semibold text-ink-800">Decoded PAYMENT-REQUIRED</span>
            <pre className="m-0 overflow-x-auto rounded-[10px] bg-ground-50 p-3.5 font-mono text-[12.5px] leading-[1.6]">
              {decoded === undefined ? '(no PAYMENT-REQUIRED header)' : JSON.stringify(decoded, null, 2)}
            </pre>
            {amount === undefined ? null : (
              <span className="text-xs text-ink-500">
                amount is in cents: <span className="font-mono">{amount}</span>
              </span>
            )}
          </div>
        </div>
      )}
      <div className="flex flex-col gap-2 border-t border-ground-100 px-4 py-3.5">
        <span className="text-[13px] font-semibold text-ink-800">Example after payment</span>
        <p className="m-0 text-[13px] text-ink-700">
          The agent retries with a PAYMENT-SIGNATURE header. The 200 answer carries a PAYMENT-RESPONSE header with the paid call&apos;s id; decoded, it looks like this:
        </p>
        <pre className="m-0 overflow-x-auto rounded-[10px] bg-ground-50 p-3.5 font-mono text-[12.5px] leading-[1.6]">{PAID_EXAMPLE}</pre>
      </div>
    </section>
  );
}
