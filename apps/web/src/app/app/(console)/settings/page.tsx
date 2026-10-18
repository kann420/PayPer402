import { LimitsForm } from '@/components/forms/limits-form';
import { LiveRefresh } from '@/components/live/live-refresh';
import { LinkCard } from '@/components/settings/link-card';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Settings · PayPer402' };

export default async function SettingsPage() {
  const { api } = await operatorPage();
  const view = await load(() => api.get());
  return (
    <>
      <LiveRefresh scope="operator" />
      <TopBar title="Settings" subtitle="PayPal link & limits" console="operator" operatorName={view.operator.name} />
      <div className="max-w-[920px]">
        <ConsoleContent>
          <LinkCard wallet={view.wallet} chargeable={view.usage.chargeable} notCollected={view.usage.notCollected} lastSettlement={view.lastSettlement} />
          <LimitsForm
            variant="settings"
            saved={view.caps}
            usage={{ spentToday: view.usage.spentToday, spentTotal: view.usage.spentTotal, notYetCharged: view.usage.notYetCharged }}
          />
          <ConsoleFooter />
        </ConsoleContent>
      </div>
    </>
  );
}
