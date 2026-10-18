'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ASK_AI_EVENT } from '../studio/ask-ai';
import { Icon } from '../ui/icons';
import { useToast } from '../ui/toast';
import { postSession } from './session-client';

export interface TopBarProps {
  title: string;
  subtitle?: ReactNode;
  console: 'operator' | 'seller';
  operatorName?: string | undefined;
  /** `panel` opens the AI panel on this page; `link` goes to the overview with the panel open. */
  askAi?: 'panel' | 'link' | 'none';
  /** `run` follows the live run's light/dark theme variables (design spec §10.10). */
  tone?: 'light' | 'run';
  children?: ReactNode;
}

const ASK_AI_CLASS = 'inline-flex h-10 items-center gap-2 rounded-[10px] bg-ink-950 px-3.5 text-sm font-semibold text-white hover:text-white';
/** The live run's secondary "Ask AI", in its theme's colours. */
const RUN_ASK_AI_CLASS =
  'inline-flex h-10 items-center rounded-[10px] border border-[var(--run-field-line)] bg-[var(--run-field-bg)] px-3.5 text-sm font-semibold text-[var(--run-text)] hover:text-[var(--run-text)]';
/** On pages without a panel the boards show "Ask AI" as a plain secondary button. */
const ASK_AI_LINK_CLASS = 'inline-flex h-10 items-center rounded-[10px] border border-line-300 bg-white px-3.5 text-sm font-semibold text-ink-950 hover:bg-ground-50';

function Sparkle() {
  return (
    <Icon size={16} stroke="#2BE38A">
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </Icon>
  );
}

/** The white top bar (design spec §9.4): title, demo-account switcher and "Ask AI". */
export function TopBar({ title, subtitle, console, operatorName, askAi = 'link', tone = 'light', children }: TopBarProps) {
  const run = tone === 'run';
  const askClass = `${ASK_AI_CLASS} border-0`;
  const router = useRouter();
  const toast = useToast();

  const switchTo = async (role: 'operator' | 'seller') => {
    if (role === console) return;
    const result = await postSession({ role });
    if (result.ok) router.push(result.next);
    else toast({ text: result.message, icon: 'error' });
  };

  return (
    <div className={`flex flex-wrap items-center gap-3 border-b px-7 py-4 ${run ? 'border-[var(--run-topbar-line)] bg-[var(--run-topbar-bg)]' : 'border-line-200 bg-white'}`}>
      <h1 className="m-0 text-[22px] tracking-[-0.01em]">{title}</h1>
      {subtitle === undefined ? null : <span className={run ? 'font-mono text-[13px] text-[var(--run-muted)]' : 'text-sm text-ink-500'}>{subtitle}</span>}
      {children}
      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        <label htmlFor="demo-account" className="sr-only">
          Demo account
        </label>
        <select
          id="demo-account"
          value={console}
          onChange={(event) => void switchTo(event.target.value === 'seller' ? 'seller' : 'operator')}
          className={`h-10 rounded-[10px] border px-2.5 text-sm ${run ? 'border-[var(--run-field-line)] bg-[var(--run-field-bg)] text-[var(--run-text)]' : 'border-line-300 bg-white'}`}
        >
          <option value="operator">Operator demo{operatorName === undefined ? '' : ` · ${operatorName}`}</option>
          <option value="seller">Seller demo · Acme Data</option>
        </select>
        {askAi === 'panel' ? (
          <button type="button" className={askClass} onClick={() => window.dispatchEvent(new Event(ASK_AI_EVENT))}>
            <Sparkle />
            Ask AI
          </button>
        ) : askAi === 'link' ? (
          <Link href={console === 'operator' ? '/app?ai=1' : '/seller?ai=1'} className={run ? RUN_ASK_AI_CLASS : ASK_AI_LINK_CLASS}>
            Ask AI
          </Link>
        ) : null}
      </div>
    </div>
  );
}
