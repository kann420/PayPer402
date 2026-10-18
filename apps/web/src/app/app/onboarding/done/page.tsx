import Link from 'next/link';
import { formatUsd } from '@/lib/money';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Set up · PayPer402' };

export default async function OnbDonePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { api } = await operatorPage();
  const [view, { agents }] = await load(() => Promise.all([api.get(), api.agents()]));
  const params = await searchParams;
  const named = typeof params['agent'] === 'string' ? params['agent'] : undefined;
  const agent = agents.find((a) => a.name === named) ?? agents[0];
  const linked = view.wallet.status === 'active' ? (view.wallet.payerEmailMasked ?? 'Linked') : 'Not linked yet';
  const cell = 'bg-white p-3.5';
  const dt = 'font-sans text-ink-500';
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <section className="pg-enter flex w-full max-w-[620px] flex-col items-start gap-6 rounded-[22px] border border-line-200 bg-white p-11 max-sm:p-7">
        <span className="inline-flex size-[60px] items-center justify-center rounded-2xl bg-meter-400">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#0C0F0E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m5 12 5 5L20 7" />
          </svg>
        </span>
        <div className="flex flex-col gap-2">
          <h1 className="m-0 text-[34px] tracking-[-0.02em]">You&apos;re set up.</h1>
          <p className="m-0 text-[17px] text-ink-800">{agent === undefined ? 'Your agents' : agent.name} can now pay per call, within your limits.</p>
        </div>
        <dl className="m-0 grid w-full grid-cols-2 gap-px overflow-hidden rounded-xl border border-line-200 bg-line-200 font-mono text-sm max-sm:grid-cols-1">
          <div className={cell}>
            <dt className={dt}>PayPal link</dt>
            <dd className="m-0 mt-0.5">{linked}</dd>
          </div>
          <div className={cell}>
            <dt className={dt}>Daily limit</dt>
            <dd className="m-0 mt-0.5">{formatUsd(view.caps.daily)}</dd>
          </div>
          <div className={cell}>
            <dt className={dt}>Auto-charge at</dt>
            <dd className="m-0 mt-0.5">{formatUsd(view.caps.unsettled)}</dd>
          </div>
          <div className={cell}>
            <dt className={dt}>Agent</dt>
            <dd className="m-0 mt-0.5">{agent?.name ?? '—'}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/app/live-run"
            className="inline-flex items-center gap-2 rounded-xl bg-meter-400 px-[22px] py-3.5 text-base font-semibold text-ink-950 hover:text-ink-950"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 4v16l13-8z" />
            </svg>
            Run the demo agent
          </Link>
          <Link href="/app" className="rounded-xl border-[1.5px] border-ink-950 px-[22px] py-[13px] text-base font-semibold text-ink-950 hover:text-ink-950">
            Go to dashboard
          </Link>
        </div>
      </section>
    </main>
  );
}
