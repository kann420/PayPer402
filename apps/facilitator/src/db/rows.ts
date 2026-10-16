/** Row shapes of the SQLite tables (design spec §5). */

export type WalletStatusRow =
  | 'not_linked'
  | 'waiting_for_approval'
  | 'active'
  | 'unlinking'
  | 'stopped_by_payer'
  | 'link_failed';

export type CommitmentState = 'unsettled' | 'settling' | 'settled' | 'uncollectable';
export type SettlementTrigger = 'threshold' | 'daily' | 'manual' | 'unlink' | 'relink';
export type SettlementStatus = 'pending' | 'completed' | 'failed' | 'needs_review';

export interface OperatorRow {
  id: string;
  name: string;
  email: string | null;
  cap_per_call: number;
  cap_daily: number;
  cap_unsettled: number;
  cap_total: number | null;
  created_at: number;
}

export interface SellerRow {
  id: string;
  name: string;
  created_at: number;
}

export interface WalletRow {
  operator_id: string;
  status: WalletStatusRow;
  link_state: string | null;
  setup_token_id: string | null;
  link_started_at: number | null;
  link_error: string | null;
  vault_id_sealed: string | null;
  vault_id_hash: string | null;
  paypal_customer_id: string | null;
  payer_email_masked: string | null;
  linked_at: number | null;
  stopped_at: number | null;
  last_checked_at: number | null;
  charge_retry_after: number | null;
  updated_at: number;
}

export interface AgentRow {
  id: string;
  operator_id: string;
  name: string;
  kid: string;
  public_key_x: string;
  status: 'active' | 'paused';
  created_at: number;
}

export interface CommitmentRow {
  id: string;
  kid: string;
  agent_id: string;
  operator_id: string;
  pay_to: string;
  resource_url: string;
  max_amount: number;
  amount: number;
  iat: number;
  recorded_at: number;
  state: CommitmentState;
  payload_hash: string;
  settlement_id: string | null;
}

export interface SettlementRow {
  id: string;
  operator_id: string;
  trigger: SettlementTrigger;
  status: SettlementStatus;
  amount: number;
  calls_count: number;
  paypal_request_id: string;
  vault_id_hash: string | null;
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  capture_status: string | null;
  fee: number | null;
  net: number | null;
  failure_code: string | null;
  failure_reason: string | null;
  attempts: number;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}
