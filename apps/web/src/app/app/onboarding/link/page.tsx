import Link from 'next/link';
import { LinkPanel } from '@/components/onboarding/link-panel';
import { OnbHeader, Stepper } from '@/components/onboarding/onboarding';
import { linkState } from '@/lib/link-state';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Link PayPal · PayPer402' };

export default async function OnbLinkPage() {
  const { api } = await operatorPage();
  const view = await load(() => api.get());
  const state = linkState(view);
  return (
    <>
      <OnbHeader name={view.operator.name} />
      <main className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 pt-4 pb-12">
        <Stepper current={1} />
        <section className="pg-enter flex flex-col gap-[22px] rounded-[20px] border border-line-200 bg-white p-9 max-sm:p-6">
          <div className="flex flex-col gap-2">
            <div className="font-mono text-[13px] text-ink-500">STEP 1 OF 3</div>
            <h1 className="m-0 text-[30px] tracking-[-0.02em]">Link your PayPal account</h1>
            <p className="m-0 text-base text-ink-800">
              You approve once on PayPal&apos;s page. After that, your agents can pay per call within your limits. You can stop anytime from your PayPal
              account.
            </p>
          </div>
          <ul className="m-0 grid list-none gap-3 p-0 text-sm text-ink-800 [grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr))]">
            <li className="rounded-xl bg-ground-50 p-3.5">Charged to your PayPal account only in batches</li>
            <li className="rounded-xl bg-ground-50 p-3.5">PayPal keeps your details. We keep a token</li>
            <li className="rounded-xl bg-ground-50 p-3.5">Never more than the limits you set next</li>
          </ul>
          <LinkPanel state={state} />
        </section>
        {state.kind === 'linked' ? null : (
          <div className="flex justify-end">
            <Link href="/app/onboarding/limits" className="px-1 py-2 text-sm text-ink-700">
              Skip for now →
            </Link>
          </div>
        )}
      </main>
    </>
  );
}
