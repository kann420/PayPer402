import { AgentsList } from '@/components/agents/agents-list';
import { NewAgentButton } from '@/components/agents/new-agent-button';
import { LiveRefresh } from '@/components/live/live-refresh';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { load, operatorPage } from '@/lib/page';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Agents · PayPer402' };

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { api } = await operatorPage();
  const [view, { agents }] = await load(() => Promise.all([api.get(), api.agents()]));
  const params = await searchParams;
  return (
    <>
      <LiveRefresh scope="operator" />
      <TopBar
        title="Agents"
        subtitle={<span className="font-mono text-[13px]">{`${agents.length} agent${agents.length === 1 ? '' : 's'}`}</span>}
        console="operator"
        operatorName={view.operator.name}
      >
        <div className="order-last ml-0">
          <NewAgentButton />
        </div>
      </TopBar>
      <ConsoleContent gap={16}>
        <AgentsList agents={agents} blockReason={view.blockReason} openNew={params['new'] === '1'} />
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
