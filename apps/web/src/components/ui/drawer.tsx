'use client';

import { useRef, type ReactNode } from 'react';
import { useFocusTrap } from './dialog';

/** The right-hand drawer of the Agents board: traps focus, closes on Escape and returns focus. */
export function Drawer({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="pg-fade fixed inset-0 z-[70] bg-[rgba(12,15,14,.45)]" onClick={onClose} aria-hidden="true" />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className="pg-drawer fixed top-0 right-0 bottom-0 z-[71] box-border flex w-[min(480px,100%)] flex-col overflow-y-auto bg-white text-ink-950 shadow-[-20px_0_60px_rgba(0,0,0,.18)]"
      >
        <div className="flex items-center border-b border-line-200 px-6 py-5">
          <h2 id="drawer-title" className="m-0 text-xl">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto inline-flex size-10 items-center justify-center rounded-[10px] border-0 bg-transparent">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0C0F0E" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4 p-6">{children}</div>
      </aside>
    </>
  );
}
