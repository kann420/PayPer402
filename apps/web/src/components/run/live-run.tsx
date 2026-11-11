'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { renderMarkdown } from '@/lib/markdown-lite';
import { formatUsd } from '@/lib/money';
import { parseSse } from '@/lib/runs';
import { decisionLayerLine, endCard, initialRun, reduceRun, type RowKind, type RunView, type TimelineRow } from '@/lib/timeline';
import { callApi, handleEnded } from '../shell/session-client';
import { TopBar } from '../shell/top-bar';
import { useToast } from '../ui/toast';
import { RunThemeToggle } from './theme-toggle';

interface RunnableAgent {
  id: string;
  name: string;
}

/** Row colours come from the run theme's variables (globals.css), light or dark (design spec §10.10). */
const META: Record<RowKind, { color: string; box: string }> = {
  thinking: { color: 'var(--run-thinking-ink)', box: 'var(--run-thinking-box)' },
  price: { color: 'var(--run-price-ink)', box: 'var(--run-price-box)' },
  decided: { color: 'var(--run-decided-ink)', box: 'var(--run-decided-box)' },
  skip: { color: 'var(--run-skip-ink)', box: 'var(--run-skip-box)' },
  paid: { color: 'var(--run-paid-ink)', box: 'var(--run-paid-box)' },
  refused: { color: 'var(--run-refused-ink)', box: 'var(--run-refused-box)' },
  problem: { color: 'var(--run-problem-ink)', box: 'var(--run-problem-box)' },
  result: { color: 'var(--run-result-ink)', box: 'var(--run-result-box)' },
};

function RowIcon({ kind }: { kind: RowKind }) {
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'thinking':
      return (
        <svg {...props} strokeWidth="2">
          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z" />
        </svg>
      );
    case 'price':
      return <span className="font-mono text-[11px] font-bold">402</span>;
    case 'decided':
      return (
        <svg {...props} strokeWidth="2.6">
          <path d="m5 12 5 5L20 7" />
        </svg>
      );
    case 'skip':
      return (
        <svg {...props} strokeWidth="2.2">
          <path d="M5 5l7 7-7 7M13 5l7 7-7 7" />
        </svg>
      );
    case 'paid':
      return (
        <svg {...props} strokeWidth="2">
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M3 10h18M7 15h4" />
        </svg>
      );
    case 'refused':
      return (
        <svg {...props} strokeWidth="2.2">
          <circle cx="12" cy="12" r="9" />
          <path d="M5.6 5.6l12.8 12.8" />
        </svg>
      );
    case 'problem':
      return (
        <svg {...props} strokeWidth="2.2">
          <path d="M12 3 2 20h20z" />
          <path d="M12 10v4M12 17h.01" />
        </svg>
      );
    case 'result':
      return (
        <svg {...props} strokeWidth="2">
          <path d="M14 3H6v18h12V7z" />
          <path d="M14 3v4h4M9 13h6M9 17h4" />
        </svg>
      );
  }
}

function Row({ row }: { row: TimelineRow }) {
  const meta = META[row.kind];
  const border =
    row.kind === 'refused' ? 'var(--run-row-refused-line)' : row.kind === 'paid' ? 'var(--run-row-paid-line)' : row.kind === 'problem' ? 'var(--run-row-problem-line)' : 'var(--run-row-line)';
  const bg = row.kind === 'refused' ? 'var(--run-row-refused-bg)' : 'var(--run-row-bg)';
  return (
    <li className="pg-row flex items-start gap-3.5 rounded-xl border px-3.5 py-3" style={{ borderColor: border, background: bg }}>
      <span aria-hidden="true" className="inline-flex size-[34px] flex-none items-center justify-center rounded-[10px]" style={{ color: meta.color, background: meta.box }}>
        <RowIcon kind={row.kind} />
      </span>
      <div className="flex min-w-0 flex-auto flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <strong className="text-sm" style={{ color: meta.color }}>
            {row.label}
          </strong>
          {row.service === '' ? null : <span className="text-[13px] text-[var(--run-service)]">{row.service}</span>}
          <span className="tnum ml-auto font-mono text-xs text-[var(--run-time)]">{row.time}</span>
        </div>
        <div className="text-[14.5px] break-words whitespace-pre-wrap text-[var(--run-row-text)]">{row.text}</div>
        {row.extra === undefined ? null : <div className="text-[13px] text-[var(--run-amber-text)]">{row.extra}</div>}
        {row.jev === undefined ? null : (
          <span className="mt-1 self-start rounded-md border border-[var(--run-jev-line)] bg-[var(--run-jev-bg)] px-2 py-0.5 font-mono text-[11px] text-[var(--run-jev-text)]">{row.jev}</span>
        )}
      </div>
      {row.chip === undefined ? null : (
        <div className="flex flex-none flex-col items-end gap-1">
          <span
            className={`tnum rounded-md px-[9px] py-[3px] font-mono text-[13px] font-semibold ${
              row.chip.tone === 'price'
                ? 'border border-[var(--run-price-chip-line)] bg-[var(--run-price-chip-bg)] text-[var(--run-price-chip-text)]'
                : row.chip.tone === 'paid'
                  ? 'bg-[var(--run-paid-chip-bg)] text-[var(--run-paid-chip-text)]'
                  : 'border border-[var(--run-chip-line)] bg-[var(--run-chip-bg)] text-[var(--run-chip-text)]'
            }`}
          >
            {row.chip.text}
          </span>
          {row.chipSub === undefined ? null : <span className="tnum font-mono text-xs text-[var(--run-muted)]">{row.chipSub}</span>}
        </div>
      )}
    </li>
  );
}

function StatusPill({ phase }: { phase: RunView['phase'] }) {
  if (phase === 'idle') return null;
  const meta =
    phase === 'running'
      ? { label: 'Running', color: 'var(--run-pill-running-text)', bg: 'var(--run-pill-running-bg)', pulse: true }
      : phase === 'blocked'
        ? { label: 'Blocked', color: 'var(--run-pill-bad-text)', bg: 'var(--run-pill-bad-bg)', pulse: false }
        : phase === 'error'
          ? { label: 'Failed', color: 'var(--run-pill-bad-text)', bg: 'var(--run-pill-bad-bg)', pulse: false }
          : { label: 'Finished', color: 'var(--run-pill-done-text)', bg: 'var(--run-pill-done-bg)', pulse: false };
  return (
    <span className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold" style={{ color: meta.color, background: meta.bg }}>
      <span aria-hidden="true" className={`size-2 rounded-full bg-current ${meta.pulse ? 'pg-pulse' : ''}`} />
      {meta.label}
    </span>
  );
}

function SpendReportCard({ view, agentName }: { view: RunView; agentName: string }) {
  const result = view.result;
  if (result === undefined) return null;
  const { report } = result;
  const calls = report.lines.reduce((n, l) => n + l.calls, 0);
  const layer = decisionLayerLine(report);
  const td = 'px-3.5 py-2.5 text-right';
  return (
    <section aria-label="Spend report" className="mx-7 mb-10 flex flex-col gap-5 rounded-[18px] border border-[var(--run-report-line)] bg-[var(--run-report-bg)] p-7 text-ink-950 max-sm:mx-4 max-sm:p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#087A3D" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
        <h2 className="m-0 text-[22px]">Spend report</h2>
        <span className="ml-auto text-[13px] text-ink-700">Written by {agentName}</span>
      </div>
      <div className="flex flex-wrap gap-6">
        <div className="flex-[1_1_360px] overflow-x-auto rounded-xl border border-line-200 bg-white">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="text-xs tracking-[.05em] text-ink-500 uppercase">
                <th className="px-3.5 py-2.5 text-left font-medium">Service</th>
                <th className="px-3.5 py-2.5 text-right font-medium">Calls</th>
                <th className="px-3.5 py-2.5 text-right font-medium">Price</th>
                <th className="px-3.5 py-2.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="tnum font-mono">
              {report.lines.map((line) => (
                <tr key={line.serviceId} className="border-t border-ground-100">
                  <td className="px-3.5 py-2.5 font-sans">{line.serviceName}</td>
                  <td className={td}>{line.calls}</td>
                  <td className={td}>{formatUsd(line.unitPriceCents)}</td>
                  <td className={td}>{formatUsd(line.totalCents)}</td>
                </tr>
              ))}
              {report.notUsed.map((s) => (
                <tr key={s.serviceId} className="border-t border-ground-100 text-ink-500">
                  <td className="px-3.5 py-2.5 font-sans">
                    <s>{s.serviceName}</s> · skipped
                  </td>
                  <td className={td}>0</td>
                  <td className={td}>{formatUsd(s.priceCents)}</td>
                  <td className={td}>{formatUsd(0)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-ink-950 font-semibold">
                <td className="px-3.5 py-3 font-sans">Total</td>
                <td className="px-3.5 py-3 text-right">{calls}</td>
                <td />
                <td className="px-3.5 py-3 text-right">{formatUsd(report.spentCents)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="flex flex-[1_1_320px] flex-col gap-3.5">
          {report.explanation === '' ? null : (
            <blockquote className="m-0 rounded-xl bg-ink-950 p-[18px] text-[15px] text-dark-text">{renderMarkdown(report.explanation)}</blockquote>
          )}
          <div className="flex flex-col gap-1.5 rounded-xl border border-line-200 bg-white p-4">
            <span className="font-mono text-xs text-ink-500">RESULT</span>
            <div className="text-[15px]">{result.answer === '' ? '(no answer)' : renderMarkdown(result.answer)}</div>
          </div>
          {layer === undefined ? null : <p className="m-0 font-mono text-xs text-ink-500">{layer}</p>}
        </div>
      </div>
    </section>
  );
}

/** The live run (design spec §10.10): task setup, the timeline, the budget meter, then the report. */
export function LiveRun({
  operatorName,
  agents,
  initialAgentId,
  defaultTask,
  perCallCents,
  linkLabel,
}: {
  operatorName: string;
  agents: RunnableAgent[];
  initialAgentId: string | undefined;
  defaultTask: string;
  perCallCents: number;
  linkLabel: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [agentId, setAgentId] = useState(initialAgentId ?? '');
  const [task, setTask] = useState(defaultTask);
  const [budget, setBudget] = useState('1.00');
  const [view, setView] = useState<RunView>(() => initialRun(100));
  const [running, setRunning] = useState(false);
  const [creating, setCreating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (agentId === '' && initialAgentId !== undefined) setAgentId(initialAgentId);
  }, [agentId, initialAgentId]);

  const budgetCents = (() => {
    const m = /^\$?(\d{1,4})(?:\.(\d{1,2}))?$/.exec(budget.trim());
    if (!m) return undefined;
    const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
    return cents >= 1 && cents <= 500 ? cents : undefined;
  })();
  const taskOk = task.trim().length >= 1 && task.length <= 500;
  const agent = agents.find((a) => a.id === agentId);
  const maxPerCall = Math.min(perCallCents, budgetCents ?? perCallCents);

  const createBot = async () => {
    setCreating(true);
    const res = await callApi<{ agent: { id: string } }>('/api/operator/agents', { name: 'trip-planner' });
    setCreating(false);
    if (!res.ok) {
      if (!handleEnded(res)) toast({ text: res.message, icon: 'error' });
      return;
    }
    setAgentId(res.agent.id);
    router.refresh();
  };

  const run = async () => {
    if (running || agent === undefined || budgetCents === undefined || !taskOk) return;
    setRunning(true);
    let current: RunView = { ...initialRun(budgetCents), phase: 'running' };
    setView(current);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: agent.id, task, budget: (budgetCents / 100).toFixed(2) }),
        signal: controller.signal,
      });
      if (!res.ok || res.body === null) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        if (body.error === 'no_session' || body.error === 'session_ended') {
          window.location.assign('/sign-in?ended=1');
          return;
        }
        current = { ...current, phase: 'error', error: body.message ?? 'The run could not start.' };
        setView(current);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const end = buffer.lastIndexOf('\n\n');
        if (end < 0) continue;
        const complete = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 2);
        for (const frame of parseSse(complete)) {
          if (frame.event === undefined) continue;
          current = reduceRun(current, frame);
        }
        setView(current);
      }
      if (current.phase === 'running') setView({ ...current, phase: current.blocked === undefined ? 'finished' : 'blocked' });
    } catch {
      if (!controller.signal.aborted) setView({ ...current, phase: 'error', error: 'The connection to the run was lost.' });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const card = endCard(view);
  const field = 'border border-[var(--run-field-line)] bg-[var(--run-field-bg)] text-[var(--run-text)] rounded-[10px]';
  return (
    <>
      <TopBar
        title="Live run"
        subtitle={agent === undefined ? undefined : `agent · ${agent.name}`}
        console="operator"
        operatorName={operatorName}
        tone="run"
      >
        <StatusPill phase={view.phase} />
        <div className="order-last">
          <RunThemeToggle />
        </div>
      </TopBar>
      <div className="flex flex-wrap items-start gap-5 px-7 pt-6 pb-10 max-sm:px-4">
        <section
          aria-label="Task setup"
          className="box-border flex max-w-[360px] flex-[1_1_260px] flex-col gap-4 rounded-2xl border border-[var(--run-line)] bg-[var(--run-surface)] p-5"
        >
          <strong className="text-[15px]">Task</strong>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="run-agent" className="text-[13px] text-[var(--run-muted)]">
              Agent
            </label>
            {agents.length === 0 ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  disabled={creating}
                  onClick={() => void createBot()}
                  className="h-11 rounded-[10px] border border-[var(--run-field-line)] bg-[var(--run-field-bg)] font-semibold text-[var(--run-text)]"
                >
                  {creating ? 'Creating…' : 'Create trip-planner'}
                </button>
                <span className="text-xs text-[var(--run-muted)]">
                  The key is kept in this browser session. Create an agent on the Agents page to get a key you can keep.
                </span>
              </div>
            ) : (
              <select id="run-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} className={`${field} h-[46px] px-3 font-mono`}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="task" className="text-[13px] text-[var(--run-muted)]">
              What should the agent do?
            </label>
            <textarea
              id="task"
              rows={5}
              maxLength={500}
              value={task}
              onChange={(event) => setTask(event.target.value)}
              className={`${field} resize-y p-3 text-[15px] focus:outline-2 focus:outline-meter-600`}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="budget" className="text-[13px] text-[var(--run-muted)]">
              Budget for this run
            </label>
            <div className={`${field} flex h-[46px] items-center px-3 ${budgetCents === undefined ? 'border-[var(--run-danger-text)]' : ''}`}>
              <span className="font-mono text-[var(--run-muted)]">$</span>
              <input
                id="budget"
                inputMode="decimal"
                value={budget}
                onChange={(event) => setBudget(event.target.value)}
                aria-invalid={budgetCents === undefined}
                className="w-full border-0 bg-transparent pl-1.5 font-mono text-base text-[var(--run-text)] outline-none"
              />
            </div>
            {budgetCents === undefined ? <span className="text-xs text-[var(--run-danger-text)]">Use an amount from $0.01 to $5.00.</span> : null}
          </div>
          <div className="flex flex-col gap-1 font-mono text-xs text-[var(--run-muted)]">
            <span>Max per call · {formatUsd(maxPerCall)}</span>
            <span>PayPal link · {linkLabel}</span>
          </div>
          <button
            type="button"
            disabled={running || agent === undefined || budgetCents === undefined || !taskOk}
            onClick={() => void run()}
            className="inline-flex h-[50px] items-center justify-center gap-2.5 rounded-xl border-0 bg-[var(--run-button-bg)] text-base font-bold text-[var(--run-button-text)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M7 4v16l13-8z" />
            </svg>
            {running ? 'Running…' : 'Run'}
          </button>
        </section>

        <section aria-label="Live timeline" className="flex min-w-0 flex-[2_1_420px] flex-col gap-2.5">
          <div className="flex items-center gap-2.5 text-[13px] text-[var(--run-muted)]">
            <span className="font-mono">TIMELINE</span>
            <span className="ml-auto font-mono">
              {view.rows.length} step{view.rows.length === 1 ? '' : 's'}
            </span>
          </div>
          {view.phase === 'idle' ? (
            <p className="m-0 rounded-xl border border-dashed border-[var(--run-dashed)] p-5 text-sm text-[var(--run-muted)]">
              Press Run. Each step of the agent appears here as it happens: prices, decisions, payments and refusals.
            </p>
          ) : null}
          <ol aria-live="polite" className="m-0 flex list-none flex-col gap-2 p-0">
            {view.rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
            {view.phase === 'running' ? (
              <li className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm text-[var(--run-muted)]">
                <span className="pg-pulse size-2 rounded-full bg-[var(--run-bar)]" />
                Agent is working…
              </li>
            ) : null}
          </ol>
          {view.phase === 'error' && view.error !== undefined ? (
            <p role="alert" className="m-0 rounded-xl border border-[var(--run-danger-line)] bg-[var(--run-danger-bg)] p-4 text-sm text-[var(--run-danger-text)]">
              {view.error}
            </p>
          ) : null}
        </section>

        <section aria-label="Budget meter" className="flex max-w-[320px] flex-[1_1_240px] flex-col gap-3.5">
          <div className="flex flex-col gap-3.5 rounded-2xl border border-[var(--run-line)] bg-[var(--run-surface)] p-5">
            <span className="font-mono text-xs text-[var(--run-muted)]">BUDGET METER</span>
            <div className="flex items-baseline gap-2">
              <span className="tnum font-mono text-[40px] font-semibold tracking-[-0.03em] text-[var(--run-spent)]">{formatUsd(view.meter.spentCents)}</span>
              <span className="tnum font-mono text-[var(--run-muted)]">/ {formatUsd(view.meter.budgetCents)}</span>
            </div>
            <div
              role="progressbar"
              aria-label="Spent against budget"
              aria-valuenow={view.meter.spentCents}
              aria-valuemin={0}
              aria-valuemax={view.meter.budgetCents}
              className="h-3 overflow-hidden rounded-full bg-[var(--run-bar-bg)]"
            >
              <div
                className="h-full min-w-0.5 bg-[var(--run-bar)] transition-[width] duration-400"
                style={{ width: `${Math.min(100, (view.meter.spentCents / Math.max(1, view.meter.budgetCents)) * 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--run-muted)]">Remaining</span>
              <span className="tnum font-mono font-semibold">{formatUsd(view.meter.remainingCents)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--run-muted)]">Paid calls</span>
              <span className="tnum font-mono font-semibold">{view.meter.paidCalls}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-[var(--run-muted)]">Skipped</span>
              <span className="tnum font-mono font-semibold">
                {view.meter.skippedCalls === 0 ? '0' : `${view.meter.skippedCalls} · ${formatUsd(view.meter.skippedCents)}`}
              </span>
            </div>
          </div>
          <div className="rounded-[14px] border border-dashed border-[var(--run-dashed)] p-3.5 text-[13px] text-[var(--run-muted)]">
            These paid calls are now <strong className="text-[var(--run-text)]">Not yet charged</strong>. Use{' '}
            <Link href="/app" className="font-semibold text-[var(--run-link)] hover:underline">
              Charge now
            </Link>{' '}
            on the overview to see a PayPal charge right away.
          </div>
        </section>
      </div>

      {card !== undefined ? (
        <section
          role="alert"
          className="mx-7 mb-10 flex flex-wrap items-center gap-x-5 gap-y-3.5 rounded-[18px] border border-[var(--run-end-line)] bg-[var(--run-end-bg)] p-6 text-[var(--run-end-text)] max-sm:mx-4"
        >
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <path d="M5.6 5.6l12.8 12.8" />
          </svg>
          <div className="flex-[1_1_360px]">
            <strong className="text-lg">{card.title}</strong>
            <div className="text-[15px]">{card.body}</div>
          </div>
          <Link href={card.action.href} className="rounded-[10px] bg-[var(--run-end-action-bg)] px-[18px] py-3 font-semibold text-[var(--run-end-action-text)] hover:text-[var(--run-end-action-text)]">
            {card.action.label}
          </Link>
        </section>
      ) : null}
      {view.result !== undefined && (card === undefined || card.withReport) ? <SpendReportCard view={view} agentName={agent?.name ?? 'the agent'} /> : null}
    </>
  );
}
