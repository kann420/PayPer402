import { jakarta, jetbrains } from './fonts';
import { OverviewStudio } from './overview-studio';

const NAV = [
  { label: 'Overview', current: true, icon: <path d="M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" /> },
  { label: 'Agents', icon: <path d="M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM12 4v4M9 13h.01M15 13h.01" /> },
  { label: 'Live run', icon: <path d="M7 4v16l13-8z" /> },
  { label: 'PayPal charges', icon: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" /> },
  { label: 'Settings', icon: <path d="M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /> },
];

function Icon({ children, stroke = 'currentColor' }: { children: React.ReactNode; stroke?: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export default function OverviewPage() {
  return (
    <div className="shell">
      <div className="sandbox">
        <span className="mono" style={{ fontWeight: 600 }}>SANDBOX</span> · Sandbox: test money only. No real charges.
      </div>
      <div className="shell-body">
        <aside className="side">
          <div className="side-brand">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="" aria-hidden="true" width={30} height={30} />
            <span>
              PayPer<span className="mono" style={{ color: 'var(--meter-400)' }}>402</span>
            </span>
          </div>
          <nav className="side-nav" aria-label="Operator">
            {NAV.map((n) => (
              <a key={n.label} href="#" aria-current={n.current ? 'page' : undefined}>
                <Icon stroke={n.current ? 'var(--meter-400)' : 'currentColor'}>{n.icon}</Icon>
                {n.label}
              </a>
            ))}
          </nav>
          <div className="side-account">
            <span style={{ color: '#9aa59f' }}>Northwind Research</span>
            <span className="mono" style={{ color: '#c5cec9' }}>operator@example.com</span>
          </div>
        </aside>

        <main className="main">
          <div className="topbar">
            <h1>Overview</h1>
            <span style={{ color: 'var(--ink-500)', fontSize: 14 }}>Today · Nov 2, 2026</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
              <select aria-label="Demo account" defaultValue="op">
                <option value="op">Operator demo · Northwind</option>
                <option value="seller">Seller demo · Acme Data</option>
              </select>
              <button type="button" className="btn-dark">
                <Icon stroke="var(--meter-400)">
                  <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
                </Icon>
                Ask AI
              </button>
            </div>
          </div>

          <div className="content">
            <div className="kpis">
              <div className="kpi">
                <span className="kpi-label">Spent today</span>
                <span className="kpi-value">$2.46</span>
                <div className="meter" role="progressbar" aria-label="Spent today against daily limit" aria-valuenow={2.46} aria-valuemin={0} aria-valuemax={10}>
                  <div style={{ width: '24.6%', background: 'var(--meter-600)' }} />
                </div>
                <span className="kpi-sub">of $10.00 daily limit</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Not yet charged</span>
                <span className="kpi-value">$3.12</span>
                <div className="meter" role="progressbar" aria-label="Not yet charged against auto-charge amount">
                  <div style={{ width: '62.4%', background: 'var(--violet-500)' }} />
                </div>
                <span className="kpi-sub">auto-charge near $5.00</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Last PayPal charge</span>
                <span className="kpi-value">$5.00</span>
                <span style={{ fontSize: 13, color: 'var(--ink-500)' }}>Nov 2, 09:14 · completed</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Active agents</span>
                <span className="kpi-value">2</span>
                <span style={{ fontSize: 13, color: 'var(--ink-500)' }}>1 paused</span>
              </div>
            </div>

            <div className="link-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <Icon>
                  <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
                  <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
                </Icon>
                <strong>PayPal link</strong>
              </div>
              <span className="badge badge-ok">
                <span aria-hidden="true">✓</span>Active
              </span>
              <span className="mono" style={{ fontSize: 14 }}>al***@example.com</span>
              <span style={{ fontSize: 14, color: 'var(--ink-500)' }}>Linked since Oct 28, 2026</span>
              <a href="#" style={{ marginLeft: 'auto', fontWeight: 600, fontSize: 14 }}>Manage</a>
            </div>

            <div className="section-head">
              <h2>Spend</h2>
              <span className="tag">AG STUDIO</span>
            </div>

            <OverviewStudio
              fontSans={jakarta.style.fontFamily}
              fontMono={jetbrains.style.fontFamily}
            />
          </div>
        </main>
      </div>
    </div>
  );
}
