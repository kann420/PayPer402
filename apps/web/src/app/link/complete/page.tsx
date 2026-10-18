import Link from 'next/link';
import { SandboxStrip } from '@/components/shell/sandbox-strip';
import { ToastProvider } from '@/components/ui/toast';
import { serverDeps } from '@/lib/deps';
import { isFacilitatorError } from '@/lib/facilitator';
import { failText, linkState, returnCard } from '@/lib/link-state';
import { pageSession } from '@/lib/page';
import { ReturnWaiting, type ReturnWaitingState } from './return-waiting';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Back from PayPal · PayPer402' };

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="pg-enter flex w-full max-w-[460px] flex-col gap-3.5 rounded-[20px] border border-line-200 bg-white p-6">
      {icon}
      <strong className="text-[19px]">{title}</strong>
      {children}
    </section>
  );
}

const ICON = 'inline-flex size-12 items-center justify-center rounded-[14px]';

function NoSession() {
  return (
    <Card
      title="Open this page in the browser you used to start linking."
      icon={
        <span className={`${ICON} bg-ground-100 text-ink-800`}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
            <path d="M4 4l16 16" />
          </svg>
        </span>
      }
    >
      <p className="m-0 text-sm text-ink-800">This browser has no demo session, so it can&apos;t show the link.</p>
      <Link href="/sign-in" className="mt-auto self-start rounded-[10px] bg-ink-950 px-4 py-[11px] text-sm font-semibold text-white hover:text-white">
        Go to sign in
      </Link>
    </Card>
  );
}

/** The PayPal return page (design spec §10.13): one card for the status PayPal sent back. */
export default async function LinkCompletePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const status = typeof params['status'] === 'string' ? params['status'] : undefined;
  const session = await pageSession();
  let body: React.ReactNode;

  if (session?.operator === undefined) {
    body = <NoSession />;
  } else {
    let view;
    try {
      view = await serverDeps().facilitator.operator(session.operator.key).get();
    } catch (error) {
      if (!(isFacilitatorError(error) && error.code === 'session_ended')) throw error;
    }
    if (view === undefined) {
      body = <NoSession />;
    } else {
      let card = returnCard(status);
      const state = linkState(view);
      let waiting: ReturnWaitingState | undefined;
      if (card === 'waiting') {
        // Decided from the operator, so the card switches when the wallet changes.
        if (state.kind === 'linked') card = 'active';
        else if (state.kind === 'failed') card = 'link_failed';
        else if (state.kind === 'collecting' || state.kind === 'collecting_review' || state.kind === 'waiting') waiting = state;
        else card = 'unknown';
      }
      if (card === 'active') {
        body = (
          <Card
            title="You're linked."
            icon={
              <span className={`${ICON} bg-meter-400`}>
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#0C0F0E" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 5 5L20 7" />
                </svg>
              </span>
            }
          >
            <p className="m-0 text-sm text-ink-800">
              PayPal approved the agreement{view.wallet.payerEmailMasked === null ? '' : ' for '}
              <span className="font-mono">{view.wallet.payerEmailMasked ?? ''}</span>.
            </p>
            <div className="mt-auto flex flex-wrap gap-2.5">
              <Link href="/app/onboarding/limits" className="rounded-[10px] bg-ink-950 px-4 py-[11px] text-sm font-semibold text-white hover:text-white">
                Set limits
              </Link>
              <Link href="/app" className="rounded-[10px] border-[1.5px] border-ink-950 bg-white px-4 py-2.5 text-sm font-semibold text-ink-950 hover:text-ink-950">
                Go to dashboard
              </Link>
            </div>
          </Card>
        );
      } else if (card === 'link_failed') {
        body = (
          <Card
            title="Link not completed"
            icon={
              <span className={`${ICON} bg-red-100 text-red-800`}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v6M12 17h.01" />
                </svg>
              </span>
            }
          >
            <p className="m-0 text-sm text-ink-800">{failText(view.wallet.linkError ?? 'unknown', view.usage.notCollected)}</p>
            <Link href="/app/onboarding/link" className="mt-auto self-start rounded-[10px] bg-ink-950 px-4 py-[11px] text-sm font-semibold text-white hover:text-white">
              Try again
            </Link>
          </Card>
        );
      } else if (waiting !== undefined) {
        body = <ReturnWaiting state={waiting} />;
      } else {
        body = (
          <Card
            title="Link already used"
            icon={
              <span className={`${ICON} bg-ground-100 text-ink-800`}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
                  <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
                  <path d="M4 4l16 16" />
                </svg>
              </span>
            }
          >
            <p className="m-0 text-sm text-ink-800">This link was already used. Go to your dashboard.</p>
            <Link href="/app" className="mt-auto self-start rounded-[10px] border-[1.5px] border-ink-950 bg-white px-4 py-2.5 text-sm font-semibold text-ink-950 hover:text-ink-950">
              Go to dashboard
            </Link>
          </Card>
        );
      }
    }
  }

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-ground-50 text-[15px] text-ink-950">
        <SandboxStrip />
        <header className="mx-auto flex w-full max-w-[1040px] items-center gap-2.5 px-6 py-[18px]">
          <Link href="/" className="flex items-center gap-2.5 text-ink-950 hover:text-ink-950">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" aria-hidden="true" width={32} height={32} className="block flex-none object-contain" />
            <strong className="text-lg">
              PayPer<span className="font-mono text-meter-700">402</span>
            </strong>
          </Link>
          <span className="ml-auto text-sm text-ink-500">Back from PayPal</span>
        </header>
        <main className="flex flex-1 items-start justify-center px-6 pt-10 pb-14">{body}</main>
      </div>
    </ToastProvider>
  );
}
