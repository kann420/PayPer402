import type { AgentEvent, SpendReport } from './events';
import { formatUsd } from './tools';

/** Collapses whitespace so every event renders on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
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
      return `[decide] ${event.callId} pay ${formatUsd(event.priceCents)} for ${event.serviceName}: ${oneLine(event.note)} (left after this: ${formatUsd(event.remainingCents)})`;
    case 'paid':
      return `[paid] ${event.callId} ${event.serviceName} ${formatUsd(event.amountCents)}, commitment ${event.commitmentId ?? 'unknown'}; spent ${formatUsd(event.spentCents)}, left ${formatUsd(event.remainingCents)}`;
    case 'refused':
      return `[refused] ${event.callId} ${event.serviceName}: ${event.note} (${event.code}, by ${event.by})`;
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
  return out.join('\n');
}
