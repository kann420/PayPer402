import type { ReactNode } from 'react';
import { ToastProvider } from '../ui/toast';
import { OfflineBanner } from './offline-banner';
import { SandboxStrip } from './sandbox-strip';
import { Sidebar } from './sidebar';

/**
 * The console layout (design spec §9): sandbox strip, dark sidebar, then the page. `run` is the
 * live run's themable shell (§10.10): light by default, dark when <html> has data-run-theme="dark".
 */
export function ConsoleShell({
  console,
  operator,
  tone = 'light',
  children,
}: {
  console: 'operator' | 'seller';
  operator?: { name: string; id: string } | undefined;
  tone?: 'light' | 'run';
  children: ReactNode;
}) {
  return (
    <ToastProvider>
      <div className={`flex min-h-screen flex-col ${tone === 'run' ? 'run-theme' : 'bg-ground-50 text-ink-950'}`}>
        <SandboxStrip tone={tone} />
        <OfflineBanner />
        <div className="console-body">
          <Sidebar console={console} operator={operator} tone={tone} />
          <main className="console-main">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}

/** The muted line every console page ends with (design spec §9.5). */
export function ConsoleFooter() {
  return <p className="m-0 pt-2 text-[13px] text-ink-500">Times in UTC · Sandbox demo · Settled with PayPal</p>;
}

/** The padded content column under the top bar. */
export function ConsoleContent({ children, gap = 20 }: { children: ReactNode; gap?: number }) {
  return (
    <div className="pg-enter flex flex-col px-7 pt-6 pb-10" style={{ gap }}>
      {children}
    </div>
  );
}
