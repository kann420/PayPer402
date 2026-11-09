/** The text of `payper402 status` (operator-cli.md §6.4). Pure: no I/O, ASCII only. */
import type { AgentStatus } from './facilitator-api';
import { formatUsd } from './tools';

const LABEL_WIDTH = 13;

/** The wording of a wallet status; also the PayPal line for a wallet that is not linked. */
export function walletWording(status: string): string {
  switch (status) {
    case 'stopped_by_payer':
      return 'PayPal stopped by the payer';
    case 'not_linked':
    case 'link_failed':
      return 'PayPal not linked';
    case 'waiting_for_approval':
      return 'Waiting for PayPal approval';
    case 'unlinking':
      return 'PayPal is being unlinked';
    default:
      return 'PayPal is not active';
  }
}

/** The State line: the first rule that applies. */
export function stateOf(status: AgentStatus): string {
  if (status.agent.status === 'paused') return 'Paused by the operator';
  switch (status.blockReason) {
    case 'wallet_not_active':
      return walletWording(status.wallet.status);
    case 'daily':
      return 'Daily limit reached';
    case 'unsettled':
      return 'Waiting for a PayPal charge (not-yet-charged limit reached)';
    case 'total':
      return 'Total limit reached';
    default:
      return status.blocked ? 'Blocked' : 'Ready to pay';
  }
}

/** `YYYY-MM-DD HH:MM UTC` from unix seconds. */
export function formatUtc(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const calls = (n: number) => `${n} ${n === 1 ? 'call' : 'calls'}`;

/** The lines of the status text. `sellerUrl` comes from the config file, not from the facilitator. */
export function formatStatus(status: AgentStatus, sellerUrl: string): string[] {
  const { agent, caps, usage, wallet } = status;
  const total = caps.total === undefined ? 'no total limit' : `${formatUsd(caps.total)} total`;
  const charge =
    wallet.lastChargeAt !== null && wallet.lastChargeAmount !== null
      ? `. Last charge ${formatUsd(wallet.lastChargeAmount)}, ${(wallet.lastChargeStatus ?? 'unknown').replaceAll('_', ' ')}, ${formatUtc(wallet.lastChargeAt)}`
      : '';
  const rows: [string, string][] = [
    ['Agent', `${agent.name}  ${agent.keyFingerprint}  for ${status.operator.name}`],
    ['State', stateOf(status)],
    ['Limits', `${formatUsd(caps.perCall)} per call, ${formatUsd(caps.daily)} per day, ${formatUsd(caps.unsettled)} not yet charged, ${total}`],
    [
      'Today',
      `${formatUsd(usage.spentToday)} spent, ${formatUsd(status.remainingToday)} left (this agent: ${formatUsd(agent.spentToday)} in ${calls(agent.callsToday)})`,
    ],
    ['Not charged', `${formatUsd(usage.notYetCharged)} in ${calls(usage.notYetChargedCalls)}`],
    ['PayPal', `${wallet.status === 'active' ? 'Linked' : walletWording(wallet.status)}${charge}`],
    ['Seller', sellerUrl],
  ];
  return rows.map(([label, value]) => `${label.padEnd(LABEL_WIDTH)}${value}`);
}
