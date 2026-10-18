/**
 * Structural error detection across server chunks. Next bundles a module into every route chunk
 * that imports it, so each chunk has its own copy of a class, while shared singletons on
 * `globalThis` (the dependencies, with their facilitator client) throw errors made by whichever
 * chunk created them. `instanceof` is then false in every other chunk. A brand under a
 * `Symbol.for` key is the same in every chunk, so the guards below work everywhere.
 */

export const FACILITATOR_ERROR = Symbol.for('pp402.FacilitatorError');
export const ROUTE_ERROR = Symbol.for('pp402.RouteError');
export const WEB_CONFIG_ERROR = Symbol.for('pp402.WebConfigError');

/** Marks `target` with `key` (non-enumerable, so it never reaches JSON). */
export function brand(target: object, key: symbol): void {
  Object.defineProperty(target, key, { value: true, enumerable: false });
}

export function hasBrand(value: unknown, key: symbol): boolean {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[key] === true;
}

/** True for an error with this name, whichever copy of its class made it (for package errors). */
export function isNamedError(value: unknown, name: string): value is Error {
  return typeof value === 'object' && value !== null && (value as { name?: unknown }).name === name && typeof (value as { message?: unknown }).message === 'string';
}
