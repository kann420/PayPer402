import type { ReactNode } from 'react';
import { ConsoleShell } from '@/components/shell/console-shell';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';

/** The operator console (design spec §9): requires a session holding an operator. */
export default async function OperatorConsoleLayout({ children }: { children: ReactNode }) {
  const { api } = await operatorPage();
  const view = await load(() => api.get());
  return (
    <ConsoleShell console="operator" operator={{ name: view.operator.name, id: view.operator.id }}>
      {children}
    </ConsoleShell>
  );
}
