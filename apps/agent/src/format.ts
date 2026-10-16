import type { AgentEvent, BlockedCheck, DecidedCheck, SpendReport } from './events';
import { formatUsd } from './tools';

/** Collapses whitespace so every event renders on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const p2 = (value: number) => value.toFixed(2);

/** The check suffix of a `decided` line (decision-layer spec §6). */
function decidedCheck(check: DecidedCheck | undefined): string {
  if (check === undefined) return '';
  switch (check.status) {
    case 'passed':
      return ` | Jev: serves task ${p2(check.servesTask)}, covered ${p2(check.alreadyCovered)}`;
    case 'flagged':
      return ` | Jev would refuse (${check.wouldRefuse}, ${
        check.wouldRefuse === 'not_needed' ? `serves task ${p2(check.servesTask)}` : `covered ${p2(check.alreadyCovered)}`
      }), observe-only`;
    case 'unavailable':
      return ` | Jev unavailable (${check.note})`;
  }
}

/** The check suffix of a `refused` line for a Jev block or its repeat. */
function refusedCheck(code: string, check: BlockedCheck | undefined): string {
  if (check === undefined) return '';
  const score = code === 'already_covered' ? `covered ${p2(check.alreadyCovered)}` : `serves task ${p2(check.servesTask)}`;
  return ` | Jev: ${score}${check.repeatOf === undefined ? '' : `, repeat of ${check.repeatOf}`}`;
}

/** One line per event, with an ASCII tag (design spec §7). */
export function formatEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'started':
      return `[start] ${event.sellerName}: budget ${formatUsd(event.budgetCents)}, per-call limit ${formatUsd(event.maxPerCallCents)}${
        event.task === undefined ? '' : `. Task: ${oneLine(event.task)}`
      }`;
    case 'thinking':
      return `[think] ${oneLine(event.note)}`;
    case 'discovered_price':
      return `[402] ${event.callId} ${event.serviceName} asks ${formatUsd(event.priceCents)} (catalog ${formatUsd(event.catalogPriceCents)})`;
    case 'decided':
      return `[decide] ${event.callId} pay ${formatUsd(event.priceCents)} for ${event.serviceName}: ${oneLine(event.note)} (left after this: ${formatUsd(event.remainingCents)})${decidedCheck(event.check)}`;
    case 'paid':
      return `[paid] ${event.callId} ${event.serviceName} ${formatUsd(event.amountCents)}, commitment ${event.commitmentId ?? 'unknown'}; spent ${formatUsd(event.spentCents)}, left ${formatUsd(event.remainingCents)}`;
    case 'refused':
      return `[refused] ${event.callId} ${event.serviceName}: ${event.note} (${event.code}, by ${event.by})${refusedCheck(event.code, event.check)}`;
    case 'failed':
      return `[failed] ${event.callId === undefined ? '' : `${event.callId} ${event.serviceName ?? ''}: `}${oneLine(event.note)} (charged: ${event.charged})`;
    case 'result':
      return `[result] ${event.status}`;
  }
}

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length))) ?? [];
  return rows.map((row) =>
    row
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
}

/** The spend report as a plain-text table. */
export function formatReport(report: SpendReport): string {
  const rows = [['Service', 'Calls', 'Unit', 'Total']];
  for (const line of report.lines) {
    rows.push([line.serviceName, String(line.calls), formatUsd(line.unitPriceCents), formatUsd(line.totalCents)]);
  }
  rows.push(['Spent', '', '', formatUsd(report.spentCents)]);
  if (report.uncertainCents > 0) rows.push(['Outcome unknown', '', '', formatUsd(report.uncertainCents)]);
  rows.push(['Left of budget', '', '', `${formatUsd(report.remainingCents)} of ${formatUsd(report.budgetCents)}`]);
  const out = [`Spend report (${report.sellerName})`, ...table(rows)];
  if (report.notUsed.length > 0) {
    out.push(`Not used: ${report.notUsed.map((s) => `${s.serviceName} (${formatUsd(s.priceCents)})`).join(', ')}`);
  }
  if (report.refusals.length > 0) out.push(`Refused: ${report.refusals.map((r) => `${r.serviceId} (${r.code})`).join(', ')}`);
  if (report.commitmentIds.length > 0) out.push(`Commitments: ${report.commitmentIds.join(', ')}`);
  if (report.explanation !== '') out.push(`Why: ${oneLine(report.explanation)}`);
  const layer = report.decisionLayer;
  if (layer !== undefined) {
    out.push(`Decision layer: Jev (${layer.model}): ${layer.passed} passed, ${layer.blocked} blocked, ${layer.flagged} flagged, ${layer.unavailable} unavailable`);
  }
  return out.join('\n');
}
