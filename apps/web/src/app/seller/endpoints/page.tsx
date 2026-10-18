import { LiveRefresh } from '@/components/live/live-refresh';
import { IntegrationCard } from '@/components/seller/integration';
import { TestIt } from '@/components/seller/test-it';
import { ConsoleContent, ConsoleFooter } from '@/components/shell/console-shell';
import { TopBar } from '@/components/shell/top-bar';
import { loadSellerCalls } from '@/lib/loaders';
import { formatUsd } from '@/lib/money';
import { load, sellerPage, sessionOperatorName } from '@/lib/page';
import { nowSeconds, utcDayStart } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Endpoints · PayPer402' };

export default async function SellerEndpointsPage() {
  const { api, deps } = await sellerPage();
  const [catalog, calls] = await load(() => Promise.all([deps.catalog.get(), loadSellerCalls(api)]));
  const services = catalog?.services ?? [];
  const today = utcDayStart(nowSeconds());
  const todayCalls = calls.calls.filter((c) => c.recordedAt >= today);
  const stats = (path: string) => {
    const mine = todayCalls.filter((c) => c.path.split('?')[0] === path);
    return { calls: mine.length, revenue: mine.reduce((n, c) => n + c.amount, 0) };
  };
  return (
    <>
      <LiveRefresh scope="seller" />
      <TopBar
        title="Endpoints & pricing"
        subtitle={`${services.length} paid endpoint${services.length === 1 ? '' : 's'} · read-only`}
        console="seller"
        operatorName={await sessionOperatorName()}
      />
      <ConsoleContent gap={18}>
        <p className="m-0 flex items-start gap-2 rounded-xl border border-line-200 bg-white px-3.5 py-3 text-sm text-ink-800">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="mt-0.5 flex-none">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v5M12 8h.01" />
          </svg>
          Prices are set in your middleware config. A new price applies as soon as you deploy it.
        </p>
        {catalog === undefined ? (
          <p role="alert" className="m-0 rounded-xl border border-amber-300 bg-amber-100 px-4 py-3 text-sm text-amber-800">
            The seller API did not answer, so its endpoints can&apos;t be listed right now.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[14px] border border-line-200 bg-white">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Service</th>
                  <th>Description</th>
                  <th>Price per call</th>
                  <th className="!text-right">Calls today</th>
                  <th className="!text-right">Revenue today</th>
                </tr>
              </thead>
              <tbody>
                {services.map((s) => {
                  const st = stats(s.path);
                  return (
                    <tr key={s.id}>
                      <td className="font-mono">
                        <span className={`font-semibold ${s.method === 'GET' ? 'text-meter-700' : 'text-[#5B3FD9]'}`}>{s.method}</span> {s.path}
                      </td>
                      <td>{s.name}</td>
                      <td className="!whitespace-normal text-ink-800">{s.description}</td>
                      <td className="tnum font-mono">{formatUsd(s.priceCents)}</td>
                      <td className="tnum text-right font-mono">{st.calls}</td>
                      <td className="tnum text-right font-mono">{formatUsd(st.revenue)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <IntegrationCard />
        <TestIt services={services.map((s) => ({ id: s.id, name: s.name, method: s.method, path: s.path }))} />
        <ConsoleFooter />
      </ConsoleContent>
    </>
  );
}
