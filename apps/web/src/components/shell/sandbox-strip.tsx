/** "SANDBOX · Sandbox: test money only. No real charges." on every page (design spec §9.1). */
export function SandboxStrip({ tone = 'light' }: { tone?: 'light' | 'run' }) {
  if (tone === 'run') {
    return (
      <div className="border-b border-[var(--run-strip-line)] bg-[var(--run-strip-bg)] px-4 py-1.5 text-center text-[13px] text-[var(--run-strip-text)]">
        <span className="font-mono font-semibold">SANDBOX</span> · Sandbox: test money only. No real charges.
      </div>
    );
  }
  return (
    <div className="border-b border-sandbox-line bg-sandbox-bg px-4 py-1.5 text-center text-[13px] text-amber-800">
      <span className="font-mono font-semibold">SANDBOX</span> · Sandbox: test money only. No real charges.
    </div>
  );
}
