'use client';

import { useLayoutEffect, useState } from 'react';
import { readRunTheme, writeRunTheme, type RunTheme } from '@/lib/run-theme';

const storage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

function apply(theme: RunTheme): void {
  if (theme === 'dark') document.documentElement.setAttribute('data-run-theme', 'dark');
  else document.documentElement.removeAttribute('data-run-theme');
}

/**
 * The live run's light/dark toggle (design spec §10.10). The root layout's script already applied
 * the stored choice before paint on a full load; the layout effect covers client navigation.
 */
export function RunThemeToggle() {
  const [theme, setTheme] = useState<RunTheme>('light');

  useLayoutEffect(() => {
    const stored = readRunTheme(storage());
    apply(stored);
    setTheme(stored);
    // Other console pages are light only: leave no dark attribute behind.
    return () => document.documentElement.removeAttribute('data-run-theme');
  }, []);

  const dark = theme === 'dark';
  const toggle = () => {
    const next: RunTheme = dark ? 'light' : 'dark';
    apply(next);
    writeRunTheme(storage(), next);
    setTheme(next);
  };

  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={dark}
      title={label}
      className="inline-flex size-10 items-center justify-center rounded-[10px] border border-[var(--run-field-line)] bg-[var(--run-field-bg)] text-[var(--run-text)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-meter-600"
    >
      {dark ? (
        // Sun: the way back to light.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        // Moon: switch to dark.
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
}
