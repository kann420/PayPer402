/**
 * Tool schema normalisation for the AI assistant (design spec §12.3, "Query reliability"). AG
 * Studio's query tool schema is generated from its validators: field ids and their allowed
 * aggregations sit behind `$ref`s into `$defs` with long generated names, optional values carry
 * `{ not: {} }` markers, and discriminators may be `const`. Claude reads a flat schema far more
 * reliably, so the route inlines every non-recursive definition, drops the markers, and turns
 * `const` into a one-value `enum`. Recursive definitions (expressions, filter groups) stay in
 * `$defs`, and only the ones still referenced are kept. Pure.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const REF_PREFIX = '#/$defs/';

function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function refName(node: JsonObject): string | undefined {
  const ref = node['$ref'];
  return typeof ref === 'string' && ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : undefined;
}

/** The names of the definitions that `node` references directly or through nested schemas. */
function refsIn(node: Json, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => refsIn(item, out));
  else if (isObject(node)) {
    const name = refName(node);
    if (name !== undefined) out.add(name);
    for (const [key, value] of Object.entries(node)) if (key !== '$defs') refsIn(value, out);
  }
  return out;
}

/** Definitions that can reach themselves through `$ref`s; they cannot be inlined. */
export function recursiveDefinitions(defs: JsonObject): Set<string> {
  const edges = new Map(Object.entries(defs).map(([name, schema]) => [name, refsIn(schema)]));
  const recursive = new Set<string>();
  for (const start of edges.keys()) {
    const seen = new Set<string>();
    const stack = [...(edges.get(start) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (next === start) {
        recursive.add(start);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(edges.get(next) ?? []));
    }
  }
  return recursive;
}

/** `{ not: {} }` matches nothing: Studio's marker for "may be left out". */
function isNeverMarker(node: Json): boolean {
  return isObject(node) && Object.keys(node).length === 1 && isObject(node['not']) && Object.keys(node['not']).length === 0;
}

function transform(node: Json, defs: JsonObject, recursive: Set<string>, depth: number): Json {
  if (depth > 64) return node;
  if (Array.isArray(node)) return node.map((item) => transform(item, defs, recursive, depth + 1));
  if (!isObject(node)) return node;

  const name = refName(node);
  if (name !== undefined && !recursive.has(name) && defs[name] !== undefined) {
    const { $ref: _ref, ...rest } = node;
    const inlined = transform(defs[name], defs, recursive, depth + 1);
    return Object.keys(rest).length === 0 || !isObject(inlined) ? inlined : { ...inlined, ...(transform(rest, defs, recursive, depth + 1) as JsonObject) };
  }

  const out: JsonObject = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === '$defs') continue;
    if (key === 'const') {
      out['enum'] = [value];
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const options = value.filter((option) => !isNeverMarker(option)).map((option) => transform(option, defs, recursive, depth + 1));
      out[key] = options;
      continue;
    }
    out[key] = transform(value, defs, recursive, depth + 1);
  }

  // An anyOf left with one option, and nothing else beside it, is that option.
  for (const key of ['anyOf', 'oneOf'] as const) {
    const options = out[key];
    if (Array.isArray(options) && options.length === 1 && Object.keys(out).length === 1) return options[0] as Json;
  }
  return out;
}

/** The normalised copy of a tool's JSON Schema. The input is not changed. */
export function normalizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const root = JSON.parse(JSON.stringify(schema)) as JsonObject;
  const defs = isObject(root['$defs']) ? root['$defs'] : {};
  const recursive = recursiveDefinitions(defs);
  const body = transform(root, defs, recursive, 0) as JsonObject;

  // Keep the recursive definitions that the body (or another kept definition) still references.
  const kept: JsonObject = {};
  const pending = [...refsIn(body)].filter((name) => recursive.has(name));
  while (pending.length > 0) {
    const name = pending.pop() as string;
    if (kept[name] !== undefined || defs[name] === undefined) continue;
    kept[name] = transform(defs[name], defs, recursive, 0);
    for (const ref of refsIn(kept[name])) if (recursive.has(ref) && kept[ref] === undefined) pending.push(ref);
  }
  return Object.keys(kept).length === 0 ? body : { ...body, $defs: kept };
}
