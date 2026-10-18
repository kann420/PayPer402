import Link from 'next/link';

/** The onboarding header: the mark and the operator's name. */
export function OnbHeader({ name }: { name: string }) {
  return (
    <header className="mx-auto flex w-full max-w-[1040px] items-center gap-2.5 px-6 py-[18px]">
      <Link href="/app" className="flex items-center gap-2.5 text-ink-950 hover:text-ink-950">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.png" alt="" aria-hidden="true" width={32} height={32} className="block flex-none object-contain" />
        <strong className="text-lg">
          PayPer<span className="font-mono text-meter-700">402</span>
        </strong>
      </Link>
      <span className="ml-auto text-sm text-ink-500">{name}</span>
    </header>
  );
}

const STEPS = ['Link PayPal', 'Set limits', 'First agent'] as const;

/** The three-step stepper of the onboarding boards. Step 1 is done only when the wallet is linked. */
export function Stepper({ current, linkedEmail }: { current: 1 | 2 | 3; linkedEmail?: string | null | undefined }) {
  return (
    <ol aria-label="Setup progress" className="m-0 flex list-none flex-wrap items-center gap-2.5 p-0 text-sm">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const done = n < current && (n !== 1 || (linkedEmail !== undefined && linkedEmail !== null));
        const active = n === current;
        return [
          i > 0 ? <li key={`line-${n}`} aria-hidden="true" className={`h-0.5 min-w-6 flex-[1_1_24px] ${n <= current ? 'bg-meter-400' : 'bg-line-250'}`} /> : null,
          <li
            key={label}
            aria-current={active ? 'step' : undefined}
            className={`flex items-center gap-2 ${done ? 'text-meter-800' : active ? 'font-semibold' : 'text-ink-500'}`}
          >
            {done ? (
              <span className="inline-flex size-[26px] items-center justify-center rounded-full bg-meter-400 text-ink-950">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m5 12 5 5L20 7" />
                </svg>
              </span>
            ) : active ? (
              <span className="inline-flex size-[26px] items-center justify-center rounded-full bg-ink-950 text-[13px] text-white">{n}</span>
            ) : (
              <span className="inline-flex size-[26px] items-center justify-center rounded-full border-[1.5px] border-line-400 text-[13px]">{n}</span>
            )}
            {label}
            {done && n === 1 && linkedEmail ? <span className="font-mono text-xs text-ink-700">{linkedEmail}</span> : null}
          </li>,
        ];
      })}
    </ol>
  );
}
