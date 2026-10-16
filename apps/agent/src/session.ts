import type { KeyObject } from 'node:crypto';
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { PAYPAL_NETWORK_FAMILY, PayPalBatchClientScheme } from '@payper402/scheme-paypal';
import { Budget, type BudgetSnapshot } from './budget';
import { fetchCatalog, serviceUrl, validateParams, type Catalog, type ParamValue } from './catalog';
import type { AgentEvent, DecisionLayerReport, SpendReport, SpendReportLine } from './events';
import { runPaidCall, type CallOutcome, type DecisionLayerContext, type EventInput } from './payer';
import { CallRegistry } from './registry';
import { CHECK_DEADLINE_MS, DEFAULT_SPEND_POLICY, resultExcerpt, type SpendCheck, type SpendPolicy } from './spend-check';

export interface OpenSessionOptions {
  /** The seller's base URL; the catalog, the calls and the newsroom links share its origin. */
  sellerUrl: string;
  /** The agent's Ed25519 private key. */
  privateKey: KeyObject;
  budgetCents: number;
  maxPerCallCents: number;
  /** Used for the catalog and every call. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Unix seconds for the commitments' `iat` and `exp`. Defaults to the system clock. */
  nowSeconds?: () => number;
  /** Called synchronously, in order, for every event. A throwing callback is ignored. */
  onEvent?: (event: AgentEvent) => void;
  /**
   * Enables the decision layer (decision-layer spec §2, §3). `task` is the same string the agent
   * runs. `policy` and `deadlineMs` are test seams; the CLI and the demo never set them.
   */
  spendCheck?: { checker: SpendCheck; task: string; policy?: SpendPolicy; deadlineMs?: number };
}

/** One budget and one catalog (design spec §4). A CLI run or an MCP server process is one session. */
export interface AgentSession {
  readonly sellerUrl: string;
  readonly catalog: Catalog;
  /** Every event so far, in order. */
  readonly events: readonly AgentEvent[];
  /** True after a blocking refusal (design spec §4.5). */
  readonly blocked: boolean;
  budget(): BudgetSnapshot;
  /** Number of `paid` events. */
  paidCalls(): number;
  /** The paid-call flow (design spec §4.3). Never throws. */
  call(serviceId: string, params: Record<string, unknown>, reason: string): Promise<CallOutcome>;
  /** Emits an event (stamped with `at` now) to `events` and `onEvent`. */
  emit(event: EventInput): AgentEvent;
  /** The spend report (design spec §4.7). */
  report(explanation?: string): SpendReport;
}

class Session implements AgentSession {
  readonly sellerUrl: string;
  readonly catalog: Catalog;
  readonly events: AgentEvent[] = [];
  private isBlocked = false;
  private callCount = 0;
  private readonly ledger: Budget;
  private readonly scheme: PayPalBatchClientScheme;
  private readonly fetchFn: typeof fetch;
  private readonly onEvent: ((event: AgentEvent) => void) | undefined;
  private readonly layer: Omit<DecisionLayerContext, 'input'> | undefined;
  private readonly task: string;
  /** The params of each call that reached the registry, for the checker's earlier results. */
  private readonly callParams = new Map<string, Record<string, ParamValue>>();

  constructor(options: OpenSessionOptions, catalog: Catalog) {
    this.sellerUrl = options.sellerUrl;
    this.catalog = catalog;
    this.ledger = new Budget(options.budgetCents, options.maxPerCallCents);
    this.scheme = new PayPalBatchClientScheme({
      privateKey: options.privateKey,
      ...(options.nowSeconds === undefined ? {} : { now: options.nowSeconds }),
    });
    this.fetchFn = options.fetch ?? fetch;
    this.onEvent = options.onEvent;
    const spend = options.spendCheck;
    this.task = spend?.task ?? '';
    this.layer =
      spend === undefined
        ? undefined
        : {
            registry: new CallRegistry(),
            checker: spend.checker,
            policy: spend.policy ?? DEFAULT_SPEND_POLICY,
            deadlineMs: spend.deadlineMs ?? CHECK_DEADLINE_MS,
          };
  }

  /** The decision-layer context of one call, with its input builder (decision-layer spec §4.1). */
  private decisionLayerFor(callId: string, params: Record<string, ParamValue>): DecisionLayerContext | undefined {
    const layer = this.layer;
    if (layer === undefined) return undefined;
    this.callParams.set(callId, params);
    const serviceName = (serviceId: string) => this.catalog.services.find((s) => s.id === serviceId)?.name ?? serviceId;
    return {
      ...layer,
      input: ({ service, params: callParams }) => ({
        task: this.task,
        call: { serviceName: service.name, serviceDescription: service.description, params: callParams },
        earlier: layer.registry.earlier().map((record) => ({
          serviceName: serviceName(record.serviceId),
          params: this.callParams.get(record.callId) ?? {},
          resultExcerpt: resultExcerpt(record.data),
        })),
      }),
    };
  }

  get blocked(): boolean {
    return this.isBlocked;
  }

  budget(): BudgetSnapshot {
    return this.ledger.snapshot();
  }

  paidCalls(): number {
    return this.events.filter((event) => event.type === 'paid').length;
  }

  emit(input: EventInput): AgentEvent {
    const event = { ...input, at: Date.now() } as AgentEvent;
    this.events.push(event);
    try {
      this.onEvent?.(event);
    } catch {
      // An observer must never break a call.
    }
    return event;
  }

  async call(serviceId: string, params: Record<string, unknown>, reason: string): Promise<CallOutcome> {
    // Step 1: look up and validate. No request and no event for these errors.
    const service = this.catalog.services.find((s) => s.id === serviceId);
    if (!service) return { ok: false, error: 'unknown_service', message: `There is no service ${JSON.stringify(serviceId)} in the catalog` };
    const issues = validateParams(service, params);
    if (issues.length > 0) return { ok: false, error: 'invalid_params', message: 'The params do not match the catalog', issues };
    if (this.isBlocked) {
      return {
        ok: false,
        error: 'payments_blocked',
        message: 'Payments are blocked for this session after an earlier refusal; make no more paid calls',
      };
    }
    this.callCount += 1;
    const callId = `call_${this.callCount}`;
    const client = new x402Client().register(PAYPAL_NETWORK_FAMILY, this.scheme);
    const decisionLayer = this.decisionLayerFor(callId, params as Record<string, ParamValue>);
    return runPaidCall({
      callId,
      service,
      url: serviceUrl(this.sellerUrl, service),
      params: params as Record<string, ParamValue>,
      reason,
      payTo: this.catalog.seller.payTo,
      budget: this.ledger,
      client,
      http: new x402HTTPClient(client),
      fetch: this.fetchFn,
      emit: (event) => {
        this.emit(event);
      },
      block: () => {
        this.isBlocked = true;
      },
      ...(decisionLayer === undefined ? {} : { decisionLayer }),
    });
  }

  report(explanation = ''): SpendReport {
    const lines = new Map<string, SpendReportLine>();
    const commitmentIds: string[] = [];
    const refusals: SpendReport['refusals'] = [];
    for (const event of this.events) {
      if (event.type === 'paid') {
        const unitPriceCents = this.catalog.services.find((s) => s.id === event.serviceId)?.priceCents ?? event.amountCents;
        const line = lines.get(event.serviceId) ?? {
          serviceId: event.serviceId,
          serviceName: event.serviceName,
          calls: 0,
          unitPriceCents,
          totalCents: 0,
        };
        line.calls += 1;
        line.totalCents += event.amountCents;
        lines.set(event.serviceId, line);
        if (event.commitmentId !== null) commitmentIds.push(event.commitmentId);
      } else if (event.type === 'refused') {
        refusals.push({ serviceId: event.serviceId, code: event.code });
      }
    }
    const budget = this.ledger.snapshot();
    return {
      sellerName: this.catalog.seller.name,
      budgetCents: budget.budgetCents,
      spentCents: budget.spentCents,
      uncertainCents: budget.uncertainCents,
      remainingCents: budget.remainingCents,
      lines: [...lines.values()],
      notUsed: this.catalog.services
        .filter((s) => !lines.has(s.id))
        .map((s) => ({ serviceId: s.id, serviceName: s.name, priceCents: s.priceCents })),
      refusals,
      commitmentIds,
      explanation,
      ...(this.layer === undefined ? {} : { decisionLayer: this.decisionLayerReport(this.layer) }),
    };
  }

  /** Counted from the events (decision-layer spec §6); `blocked` includes repeats. */
  private decisionLayerReport(layer: Omit<DecisionLayerContext, 'input'>): DecisionLayerReport {
    const counts = { passed: 0, blocked: 0, flagged: 0, unavailable: 0 };
    for (const event of this.events) {
      if (event.type === 'decided' && event.check !== undefined) {
        if (event.check.status === 'passed') counts.passed += 1;
        else if (event.check.status === 'flagged') counts.flagged += 1;
        else if (event.check.status === 'unavailable') counts.unavailable += 1;
      } else if (event.type === 'refused' && event.check?.status === 'blocked') {
        counts.blocked += 1;
      }
    }
    return { model: layer.checker.model, modes: { ...layer.policy.modes }, ...counts };
  }
}

/** Loads and validates the catalog, then returns the session (design spec §4). */
export async function openSession(options: OpenSessionOptions): Promise<AgentSession> {
  // Validate the limits before any network call.
  new Budget(options.budgetCents, options.maxPerCallCents);
  const catalog = await fetchCatalog(options.sellerUrl, options.fetch ?? fetch);
  return new Session(options, catalog);
}
