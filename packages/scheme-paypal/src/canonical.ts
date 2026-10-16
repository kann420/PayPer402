/**
 * RFC 8785 (JSON Canonicalization Scheme) for the subset of JSON the binding signs: plain objects
 * whose values are strings, safe integers or nested plain objects.
 *
 * For that subset, JCS output equals `JSON.stringify` with object keys sorted by UTF-16 code unit
 * and no whitespace: JSON.stringify already serialises strings and safe integers exactly as JCS
 * requires. Anything outside the subset (floats, booleans, null, arrays, non-plain objects) throws.
 */
export type CanonicalValue = string | number | CanonicalObject;
export interface CanonicalObject {
  readonly [key: string]: CanonicalValue;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function compareCodeUnits(a: string, b: string): number {
  // The default JS string comparison orders by UTF-16 code units, as RFC 8785 requires.
  return a < b ? -1 : a > b ? 1 : 0;
}

function serialize(value: unknown, path: string): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError(`canonical: ${path} is not a safe integer`);
    }
    // Normalise -0 to 0, as RFC 8785 does.
    return JSON.stringify(value === 0 ? 0 : value);
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareCodeUnits);
    const members = keys.map((key) => `${JSON.stringify(key)}:${serialize(value[key], `${path}.${key}`)}`);
    return `{${members.join(',')}}`;
  }
  throw new TypeError(`canonical: unsupported value at ${path}`);
}

/** Serialises a plain object canonically. Throws on unsupported values. */
export function canonical(value: CanonicalObject): string {
  if (!isPlainObject(value)) {
    throw new TypeError('canonical: top-level value must be a plain object');
  }
  return serialize(value, '$');
}
