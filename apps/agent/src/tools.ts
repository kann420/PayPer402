import { centsToUsdString } from '@payper402/scheme-paypal';
import { z } from 'zod';
import type { ParamIssue } from './catalog';
import type { AgentSession } from './session';

/** A JSON Schema value as the tool definitions use it. Hand-written: see build spec Findings, M1 check 5. */
export type JsonSchema =
  | { type: 'string'; description?: string; enum?: string[]; minLength?: number; maxLength?: number }
  | { type: 'integer'; description?: string; minimum?: number; maximum?: number }
  | { anyOf: JsonSchema[] }
  | JsonObjectSchema;

export interface JsonObjectSchema {
  type: 'object';
  description?: string;
  properties: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

/** A tool result: JSON text, marked as an error for failures. */
export interface ToolOutput {
  isError: boolean;
  text: string;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  openWorldHint?: boolean;
}

/** One tool of the tool core, shared by the Claude agent and the MCP server (design spec §5). */
export interface CoreTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  /** Whether the Claude agent sends it with `strict: true` (design spec §6.1). */
  strict: boolean;
  annotations: ToolAnnotations;
  /** Validates the input with our own zod, then runs. Never throws. */
  run(input: unknown): Promise<ToolOutput>;
}

export const TOOL_DESCRIPTIONS = {
  list_services:
    'List the paid services this agent can call, with the price per call, the params and whether the call fits your limits. Free to call.',
  call_service:
    'Call one paid service. The service answers 402 with its price; if the price is within your limits, the call is paid with a ' +
    "signed commitment that is charged to your operator's PayPal account later. Each call costs money: call only what the task needs.",
  get_budget: 'Show the run budget, what has been spent and what is left. Free to call.',
} as const;

export const REASON_MAX = 300;

/** Strict-compatible schema of a tool without input. */
export const EMPTY_INPUT_SCHEMA: JsonObjectSchema = { type: 'object', properties: {}, required: [], additionalProperties: false };

const emptyInput = z.union([z.undefined(), z.strictObject({})]);

const ok = (value: unknown): ToolOutput => ({ isError: false, text: JSON.stringify(value) });
const err = (value: unknown): ToolOutput => ({ isError: true, text: JSON.stringify(value) });

/** `$D.CC` for display; zero is `$0.00`. */
export function formatUsd(cents: number): string {
  return cents === 0 ? '$0.00' : `$${centsToUsdString(cents)}`;
}

function zodIssues(error: z.ZodError): ParamIssue[] {
  return error.issues.map((issue) => ({ param: issue.path.map(String).join('.') || '(input)', message: issue.message }));
}

/** The `call_service` input schema for a catalog. Not strict: `params` is free-form (design spec §6.1). */
export function callServiceSchema(serviceIds: string[]): JsonObjectSchema {
  return {
    type: 'object',
    properties: {
      service_id: { type: 'string', enum: serviceIds, description: 'The catalog id of the service to call' },
      params: {
        type: 'object',
        description: 'The service params, as listed by list_services',
        properties: {},
        additionalProperties: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      },
      reason: { type: 'string', minLength: 1, maxLength: REASON_MAX, description: 'One sentence: why this call is worth its price' },
    },
    required: ['service_id', 'params', 'reason'],
    additionalProperties: false,
  };
}

/** The tool core over a session: `list_services`, `call_service` and `get_budget` (design spec §5). */
export function createToolCore(session: AgentSession): CoreTool[] {
  const serviceIds = session.catalog.services.map((s) => s.id);
  const callInput = z.strictObject({
    service_id: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    reason: z.string().min(1).max(REASON_MAX),
  });
  const budgetBrief = () => {
    const b = session.budget();
    return { spentCents: b.spentCents, remainingCents: b.remainingCents };
  };
  const invalidInput = () => err({ ok: false, error: 'invalid_params', message: 'This tool takes no input', budget: budgetBrief() });

  const listServices: CoreTool = {
    name: 'list_services',
    description: TOOL_DESCRIPTIONS.list_services,
    inputSchema: EMPTY_INPUT_SCHEMA,
    strict: true,
    annotations: { readOnlyHint: true },
    run: async (input) => {
      if (!emptyInput.safeParse(input).success) return invalidInput();
      const b = session.budget();
      return ok({
        seller: { name: session.catalog.seller.name },
        budget: { budgetCents: b.budgetCents, spentCents: b.spentCents, remainingCents: b.remainingCents, maxPerCallCents: b.maxPerCallCents },
        services: session.catalog.services.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          priceCents: s.priceCents,
          price: formatUsd(s.priceCents),
          withinLimits: s.priceCents <= b.maxPerCallCents && s.priceCents <= b.remainingCents,
          params: s.params,
          required: s.required,
        })),
      });
    },
  };

  const callService: CoreTool = {
    name: 'call_service',
    description: TOOL_DESCRIPTIONS.call_service,
    inputSchema: callServiceSchema(serviceIds),
    strict: false,
    annotations: { readOnlyHint: false, openWorldHint: true },
    run: async (input) => {
      const parsed = callInput.safeParse(input);
      if (!parsed.success) {
        const id = input !== null && typeof input === 'object' ? (input as Record<string, unknown>)['service_id'] : undefined;
        if (typeof id !== 'string' || !serviceIds.includes(id)) {
          return err({ ok: false, error: 'unknown_service', message: 'service_id must be one of the catalog ids', budget: budgetBrief() });
        }
        return err({ ok: false, error: 'invalid_params', message: 'The tool input is invalid', issues: zodIssues(parsed.error), budget: budgetBrief() });
      }
      const { service_id: serviceId, params, reason } = parsed.data;
      const outcome = await session.call(serviceId, params, reason);
      if (outcome.ok) {
        return ok({
          ok: true,
          service: outcome.serviceId,
          paidCents: outcome.paidCents,
          commitmentId: outcome.commitmentId,
          budget: budgetBrief(),
          data: outcome.data,
        });
      }
      return err({
        ok: false,
        error: outcome.error,
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        message: outcome.message,
        ...(outcome.issues === undefined ? {} : { issues: outcome.issues }),
        // A Jev refusal carries the two probabilities, so the model can adapt (decision-layer spec §6).
        ...(outcome.check === undefined ? {} : { check: { servesTask: outcome.check.servesTask, alreadyCovered: outcome.check.alreadyCovered } }),
        budget: budgetBrief(),
      });
    },
  };

  const getBudget: CoreTool = {
    name: 'get_budget',
    description: TOOL_DESCRIPTIONS.get_budget,
    inputSchema: EMPTY_INPUT_SCHEMA,
    strict: true,
    annotations: { readOnlyHint: true },
    run: async (input) => {
      if (!emptyInput.safeParse(input).success) return invalidInput();
      const b = session.budget();
      return ok({
        budgetCents: b.budgetCents,
        spentCents: b.spentCents,
        uncertainCents: b.uncertainCents,
        remainingCents: b.remainingCents,
        maxPerCallCents: b.maxPerCallCents,
        paidCalls: session.paidCalls(),
      });
    },
  };

  return [listServices, callService, getBudget];
}
