'use client';

import Link from 'next/link';

/** The error page of the States board (design spec §10.14). */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-ground-50 p-6">
      <div className="flex w-full max-w-[640px] flex-col justify-center gap-4 rounded-[18px] bg-dark-bg px-9 py-12 text-dark-text">
        <span className="font-mono text-[72px] leading-none font-semibold tracking-[-0.04em] text-meter-400">500</span>
        <strong className="text-2xl">This page hit a toll it couldn&apos;t pay.</strong>
        <p className="m-0 text-ink-300">Something went wrong on our side. No money moved. Try again, or go back to the overview.</p>
        <div className="flex flex-wrap gap-2.5">
          <button type="button" onClick={() => reset()} className="h-11 rounded-[10px] border-0 bg-meter-400 px-[18px] font-semibold text-dark-bg">
            Try again
          </button>
          <Link href="/app" className="inline-flex h-11 items-center rounded-[10px] border border-[#34403B] px-[18px] text-dark-text hover:text-white">
            Go to overview
          </Link>
        </div>
        {error.digest === undefined ? null : <span className="font-mono text-xs text-code-comment">ref {error.digest}</span>}
      </div>
    </div>
  );
}
