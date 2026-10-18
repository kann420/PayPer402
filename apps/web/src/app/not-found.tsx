import Link from 'next/link';

export const metadata = { title: 'Not found · PayPer402' };

/** "No toll booth here." (design spec §10.14). */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ground-50 p-6">
      <div className="flex w-full max-w-[640px] flex-col justify-center gap-4 rounded-[18px] bg-dark-bg px-9 py-12 text-dark-text">
        <span className="font-mono text-[72px] leading-none font-semibold tracking-[-0.04em] text-meter-400">404</span>
        <strong className="text-2xl">No toll booth here.</strong>
        <p className="m-0 text-ink-300">This page doesn&apos;t exist.</p>
        <div className="flex flex-wrap gap-2.5">
          <Link href="/" className="inline-flex h-11 items-center rounded-[10px] bg-meter-400 px-[18px] font-semibold text-dark-bg hover:text-dark-bg">
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}
