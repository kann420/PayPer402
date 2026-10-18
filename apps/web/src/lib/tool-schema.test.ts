import { describe, expect, it } from 'vitest';
import { AI_TEXT } from './studio-config';
import { normalizeToolSchema, recursiveDefinitions } from './tool-schema';

/** A small copy of the shapes in AG Studio's execute_query schema (captured 2026-10-17). */
const studioLike = {
  type: 'object',
  properties: {
    query: {
      anyOf: [
        {
          type: 'object',
          properties: {
            variant: { type: 'string', const: 'aggregation' },
            measures: { type: 'array', items: { type: 'object', properties: { field: { $ref: '#/$defs/FieldRef' } }, required: ['field'] } },
            filter: { $ref: '#/$defs/AgApiFilterGroup' },
          },
        },
      ],
    },
  },
  required: ['query'],
  $defs: {
    FieldIdsDate: { type: 'string', enum: ['paid_calls.day'] },
    FieldIdsNumber: { type: 'string', enum: ['paid_calls.price'] },
    FieldRef: {
      anyOf: [
        { type: 'object', properties: { id: { $ref: '#/$defs/FieldIdsDate' }, aggregation: { type: 'string', enum: ['count', 'countd', 'first', 'last'] } } },
        { type: 'object', properties: { id: { $ref: '#/$defs/FieldIdsNumber' }, aggregation: { type: 'string', enum: ['avg', 'max', 'min', 'sum'] } } },
      ],
    },
    AgApiFilterGroup: {
      type: 'object',
      properties: {
        conditions: { type: 'array', items: { anyOf: [{ $ref: '#/$defs/AgApiFilterGroup' }, { $ref: '#/$defs/Literal' }] } },
      },
    },
    Literal: { type: 'object', properties: { value: { anyOf: [{ type: 'string' }, { type: 'null' }, { not: {} }] } } },
    Unused: { type: 'string' },
  },
};

describe('normalizeToolSchema', () => {
  it('finds the definitions that reach themselves', () => {
    expect([...recursiveDefinitions(studioLike.$defs as never)]).toEqual(['AgApiFilterGroup']);
  });

  it('inlines non-recursive definitions, so field ids and their aggregations sit together', () => {
    const out = normalizeToolSchema(studioLike) as { properties: { query: { properties: Record<string, { items?: { properties: { field: unknown } } }> } } };
    // The single-option anyOf around the query is unwrapped.
    const field = out.properties.query.properties['measures']?.items?.properties.field;
    expect(field).toEqual({
      anyOf: [
        { type: 'object', properties: { id: { type: 'string', enum: ['paid_calls.day'] }, aggregation: { type: 'string', enum: ['count', 'countd', 'first', 'last'] } } },
        { type: 'object', properties: { id: { type: 'string', enum: ['paid_calls.price'] }, aggregation: { type: 'string', enum: ['avg', 'max', 'min', 'sum'] } } },
      ],
    });
  });

  it('turns const into a one-value enum and drops { not: {} } markers', () => {
    const out = normalizeToolSchema(studioLike);
    const text = JSON.stringify(out);
    expect(text).not.toContain('"const"');
    expect(text).toContain('"variant":{"type":"string","enum":["aggregation"]}');
    expect(text).not.toContain('"not":{}');
    expect(text).toContain('"value":{"anyOf":[{"type":"string"},{"type":"null"}]}');
  });

  it('keeps only the recursive definitions that are still referenced', () => {
    const out = normalizeToolSchema(studioLike) as { $defs?: Record<string, unknown> };
    expect(Object.keys(out.$defs ?? {})).toEqual(['AgApiFilterGroup']);
    const text = JSON.stringify(out);
    expect(text).toContain('"$ref":"#/$defs/AgApiFilterGroup"');
    expect(text).not.toContain('#/$defs/FieldRef');
    expect(text).not.toContain('#/$defs/Literal');
  });

  it('leaves a schema without definitions as it was, and never changes its input', () => {
    const plain = { type: 'object', properties: { widgetId: { type: 'string', enum: ['a', 'b'] } }, required: ['widgetId'] };
    expect(normalizeToolSchema(plain)).toEqual(plain);
    const before = JSON.stringify(studioLike);
    normalizeToolSchema(studioLike);
    expect(JSON.stringify(studioLike)).toBe(before);
  });
});

describe('analyst instructions', () => {
  it('names the field ids and the aggregations allowed per type', () => {
    for (const scope of ['operator', 'seller'] as const) {
      const text = AI_TEXT[scope].instructions;
      for (const id of ['paid_calls.time', 'paid_calls.day', 'paid_calls.price', 'paid_calls.agent', 'paid_calls.endpoint', 'paid_calls.path', 'paid_calls.status']) expect(text).toContain(id);
      expect(text).toContain('never use max or min on paid_calls.time or paid_calls.day');
      expect(text).toContain('sorted descending or ascending with limit 1');
    }
  });
});
