'use client';

/** The top bar's "New agent" button; the agents list opens its drawer. */
export function NewAgentButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event('pp402:new-agent'))}
      className="order-last inline-flex h-10 items-center gap-1.5 rounded-[10px] border-0 bg-ink-950 px-4 text-sm font-semibold text-white"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      New agent
    </button>
  );
}
