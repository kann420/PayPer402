import { LiveRun } from '@/components/run/live-run';
import { WEB_DEFAULT_TASK } from '@/lib/copy';
import { load, operatorPage } from '@/lib/page';
import { statusEntry } from '@/lib/status';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Live run · PayPer402' };

export default async function LiveRunPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { api, session } = await operatorPage();
  const [view, { agents }] = await load(() => Promise.all([api.get(), api.agents()]));
  const params = await searchParams;
  const held = new Set(session.agents.map((a) => a.id));
  // Only agents whose key this browser holds can run here (design spec §4.4). No seed leaves the server.
  const runnable = agents.filter((a) => held.has(a.id)).map((a) => ({ id: a.id, name: a.name }));
  const wanted = typeof params['agent'] === 'string' ? params['agent'] : undefined;
  return (
    <LiveRun
      operatorName={view.operator.name}
      agents={runnable}
      initialAgentId={runnable.some((a) => a.id === wanted) ? wanted : runnable[0]?.id}
      defaultTask={WEB_DEFAULT_TASK}
      perCallCents={view.caps.perCall}
      linkLabel={statusEntry('wallet', view.wallet.status).label}
    />
  );
}
