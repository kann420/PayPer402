import type { ReactNode } from 'react';
import { ConsoleShell } from '@/components/shell/console-shell';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';

/** The live run's shell: light by default, with the boards' dark look as an option (design spec §10.10). */
export default async function RunLayout({ children }: { children: ReactNode }) {
  const { api } = await operatorPage();
  const view = await load(() => api.get());
  return (
    <ConsoleShell console="operator" tone="run" operator={{ name: view.operator.name, id: view.operator.id }}>
      {children}
    </ConsoleShell>
  );
}
