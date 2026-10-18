import Link from 'next/link';
import { SandboxStrip } from '@/components/shell/sandbox-strip';
import { serverDeps } from '@/lib/deps';
import { pageSession } from '@/lib/page';
import { DemoPicker } from './picker';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Choose a demo account · PayPer402' };

/** The returning operator's name, if the session still holds a working operator. */
async function returningName(): Promise<string | undefined> {
  const session = await pageSession();
  if (session?.operator === undefined) return undefined;
  try {
    return (await serverDeps().facilitator.operator(session.operator.key).get()).operator.name;
  } catch {
    return undefined;
  }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const ended = params['ended'] === '1';
  const returning = ended ? undefined : await returningName();
  return (
    <div className="flex min-h-screen flex-col bg-ground-50 text-ink-950">
      <SandboxStrip />
      <div className="flex flex-1 flex-col items-center justify-center gap-9 px-4 py-14">
        <Link href="/" className="flex items-center gap-2.5 text-xl font-bold text-ink-950 hover:text-ink-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" aria-hidden="true" width={38} height={38} className="block flex-none object-contain" />
          <span>
            PayPer<span className="font-mono text-meter-700">402</span>
          </span>
        </Link>
        <div className="pg-enter flex flex-col gap-2 text-center">
          <h1 className="m-0 text-[34px] tracking-[-0.02em]">Choose a demo account</h1>
          <p className="m-0 text-[17px] text-ink-700">No passwords. Pick a side and look around.</p>
        </div>
        {ended ? (
          <p role="status" className="m-0 rounded-xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-800">
            Your demo session ended. Start a new one.
          </p>
        ) : null}
        <DemoPicker returning={returning} />
        <p className="m-0 text-sm text-ink-500">Demo accounts on PayPal sandbox.</p>
      </div>
    </div>
  );
}
