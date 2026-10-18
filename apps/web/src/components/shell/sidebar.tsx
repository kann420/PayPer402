'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { btn } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { Icon } from '../ui/icons';
import { useToast } from '../ui/toast';
import { postSession } from './session-client';

const OPERATOR_NAV = [
  { href: '/app', label: 'Overview', icon: 'overview' },
  { href: '/app/agents', label: 'Agents', icon: 'agents' },
  { href: '/app/live-run', label: 'Live run', icon: 'play' },
  { href: '/app/charges', label: 'PayPal charges', icon: 'receipt' },
  { href: '/app/settings', label: 'Settings', icon: 'settings' },
] as const;

const SELLER_NAV = [
  { href: '/seller', label: 'Overview', icon: 'overview' },
  { href: '/seller/endpoints', label: 'Endpoints', icon: 'code' },
  { href: '/seller/revenue', label: 'Settled revenue', icon: 'receipt' },
] as const;

type NavIcon = (typeof OPERATOR_NAV)[number]['icon'] | (typeof SELLER_NAV)[number]['icon'];

function NavGlyph({ icon, active }: { icon: NavIcon; active: boolean }) {
  const stroke = active ? '#2BE38A' : 'currentColor';
  switch (icon) {
    case 'overview':
      return (
        <Icon stroke={stroke}>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </Icon>
      );
    case 'agents':
      return (
        <Icon stroke={stroke}>
          <rect x="5" y="8" width="14" height="11" rx="3" />
          <path d="M12 4v4M9 13h.01M15 13h.01" />
        </Icon>
      );
    case 'play':
      return (
        <Icon stroke={stroke}>
          <path d="M7 4v16l13-8z" />
        </Icon>
      );
    case 'receipt':
      return (
        <Icon stroke={stroke}>
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </Icon>
      );
    case 'settings':
      return (
        <Icon stroke={stroke}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
        </Icon>
      );
    case 'code':
      return (
        <Icon stroke={stroke}>
          <path d="m8 9-4 3 4 3M16 9l4 3-4 3M13 6l-2 12" />
        </Icon>
      );
  }
}

function isCurrent(pathname: string, href: string): boolean {
  if (href === '/app' || href === '/seller') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export interface SidebarProps {
  console: 'operator' | 'seller';
  operator?: { name: string; id: string } | undefined;
  tone?: 'light' | 'run';
}

/** The dark sidebar (design spec §9); below 900 px it becomes a horizontal nav bar. */
export function Sidebar({ console, operator, tone = 'light' }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const nav = console === 'operator' ? OPERATOR_NAV : SELLER_NAV;

  const startOver = async () => {
    setBusy(true);
    const result = await postSession({ role: 'operator', startOver: true });
    setBusy(false);
    setConfirm(false);
    if (result.ok) {
      router.push(result.next);
      router.refresh();
    } else {
      toast({ text: result.message, icon: 'error' });
    }
  };

  return (
    <aside className={`console-side flex flex-col gap-[22px] bg-ink-950 px-3.5 py-5 text-dark-text ${tone === 'run' ? 'border-r border-[var(--run-topbar-line)]' : ''}`}>
      <div className="flex items-center gap-2.5 px-2">
        <Link href={console === 'operator' ? '/app' : '/seller'} className="flex items-center gap-2.5 text-dark-text hover:text-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="" aria-hidden="true" width={30} height={30} className="block flex-none object-contain" />
          <strong className="text-[17px]">
            PayPer<span className="font-mono text-meter-400">402</span>
          </strong>
        </Link>
        {console === 'seller' ? (
          <span className="rounded-md border border-[#4A3C8C] px-1.5 py-px font-mono text-[11px] text-dark-violet">SELLER</span>
        ) : null}
      </div>
      <nav className="side-nav flex flex-col gap-0.5" aria-label={console === 'operator' ? 'Operator' : 'Seller'}>
        {nav.map((item) => {
          const active = isCurrent(pathname, item.href);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}>
              <NavGlyph icon={item.icon} active={active} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className="console-account mt-auto flex flex-col gap-1 rounded-xl border border-side-line p-3 text-[13px]">
        {console === 'operator' ? (
          <>
            <span className="text-ink-400">{operator?.name ?? 'Operator demo'}</span>
            <span className="font-mono text-ink-200">{operator === undefined ? '' : `${operator.id.slice(0, 7)}…`}</span>
            <button type="button" className="mt-1 self-start border-0 bg-transparent p-0 text-[13px] font-semibold text-meter-400" onClick={() => setConfirm(true)}>
              Start over
            </button>
          </>
        ) : (
          <>
            <span className="text-ink-400">Acme Data</span>
            <span className="text-ink-200">Settled with PayPal</span>
          </>
        )}
      </div>
      <Dialog
        open={confirm}
        title="Start a new demo account?"
        onClose={() => setConfirm(false)}
        actions={
          <>
            <button type="button" className={btn.ghost} onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" className={btn.primary} disabled={busy} onClick={() => void startOver()}>
              Start over
            </button>
          </>
        }
      >
        <p className="m-0 text-sm text-ink-800">You get a fresh operator with no PayPal link, agents or paid calls. This one stays as it is.</p>
      </Dialog>
    </aside>
  );
}
