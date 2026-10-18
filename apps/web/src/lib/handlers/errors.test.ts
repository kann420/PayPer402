/**
 * Errors crossing server chunks (audit round 1): Next bundles `facilitator.ts`, `config.ts` and
 * `common.ts` into each route chunk, so an error can come from another chunk's copy of its class.
 * These tests build such errors from different classes with the same brand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { FACILITATOR_ERROR, ROUTE_ERROR, WEB_CONFIG_ERROR } from '../brand';
import { FacilitatorError, isFacilitatorError } from '../facilitator';
import { errorResponse, isRouteError, RouteError } from './common';

/** Another chunk's copy of FacilitatorError: same shape and brand, a different class. */
class OtherChunkFacilitatorError extends Error {
  override readonly name = 'FacilitatorError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    Object.defineProperty(this, Symbol.for('pp402.FacilitatorError'), { value: true });
  }
  toJSON(): Record<string, unknown> {
    return { error: this.code, message: this.message };
  }
}

class OtherChunkRouteError extends Error {
  readonly extra = { issues: [{ path: 'unsettled', message: 'too small' }] };
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    Object.defineProperty(this, Symbol.for('pp402.RouteError'), { value: true });
  }
}

class OtherChunkConfigError extends Error {
  readonly variables = ['WEB_SESSION_SECRET'];
  constructor() {
    super('bad');
    Object.defineProperty(this, Symbol.for('pp402.WebConfigError'), { value: true });
  }
}

describe('errors from another chunk', () => {
  it('uses Symbol.for brands, which every chunk shares', () => {
    expect(FACILITATOR_ERROR).toBe(Symbol.for('pp402.FacilitatorError'));
    expect(ROUTE_ERROR).toBe(Symbol.for('pp402.RouteError'));
    expect(WEB_CONFIG_ERROR).toBe(Symbol.for('pp402.WebConfigError'));
    expect(isFacilitatorError(new FacilitatorError(409, 'wallet_not_active', 'x'))).toBe(true);
    expect(isRouteError(new RouteError(400, 'validation_failed', 'x'))).toBe(true);
    expect(isFacilitatorError(new Error('x'))).toBe(false);
    expect(Object.keys(new FacilitatorError(409, 'c', 'm'))).not.toContain(String(FACILITATOR_ERROR));
  });

  it('maps a facilitator error made by another copy of the class to its status', async () => {
    const error = new OtherChunkFacilitatorError(409, 'wallet_not_active', 'Link a PayPal account first.');
    expect(error instanceof FacilitatorError).toBe(false);
    const res = errorResponse(error, () => {});
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'wallet_not_active', message: 'Link a PayPal account first.' });
  });

  it('maps a route error and a config error made by other copies', async () => {
    const route = errorResponse(new OtherChunkRouteError(400, 'validation_failed', 'The request is invalid.'), () => {});
    expect(route.status).toBe(400);
    expect(await route.json()).toMatchObject({ error: 'validation_failed', issues: [{ path: 'unsettled' }] });
    const lines: string[] = [];
    const config = errorResponse(new OtherChunkConfigError(), (line) => lines.push(line));
    expect(config.status).toBe(503);
    expect(lines).toEqual(['[web] configuration missing or invalid: WEB_SESSION_SECRET']);
  });
});

describe('withServerDeps', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    delete (globalThis as { __pp402Deps?: unknown }).__pp402Deps;
  });

  it('answers 503 and names the variable when a value is invalid, not only missing', async () => {
    vi.resetModules();
    delete (globalThis as { __pp402Deps?: unknown }).__pp402Deps;
    vi.stubEnv('WEB_SESSION_SECRET', 'ab'.repeat(31) + 'a');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    const { withServerDeps } = await import('../route');
    const res = await withServerDeps(async () => new Response('unreachable'));
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'not_configured' });
    expect(lines).toEqual(['[web] configuration missing or invalid: WEB_SESSION_SECRET']);
  });
});
