import { describe, expect, it } from 'vitest';
import { fakeRecord, validateCollectionSchema, validateRecord } from '../src/schema.js';

const todoSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: 140 },
    done: { type: 'boolean' },
    priority: { type: 'integer', minimum: 1, maximum: 5 },
    tags: { type: 'array', items: { type: 'string' } },
    status: { type: 'string', enum: ['open', 'closed'] },
    email: { type: 'string', format: 'email' },
  },
  required: ['title'],
};

describe('validateCollectionSchema', () => {
  it('accepts a well-formed schema', () => {
    const r = validateCollectionSchema(todoSchema);
    expect(r.ok).toBe(true);
  });

  it('rejects non-object top level', () => {
    expect(validateCollectionSchema({ type: 'array' }).ok).toBe(false);
    expect(validateCollectionSchema('nope').ok).toBe(false);
    expect(validateCollectionSchema(null).ok).toBe(false);
  });

  it('rejects additionalProperties: true', () => {
    const r = validateCollectionSchema({ ...todoSchema, additionalProperties: true });
    expect(r.ok).toBe(false);
  });

  it('rejects too many properties', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 41; i++) properties[`f${i}`] = { type: 'string' };
    expect(validateCollectionSchema({ type: 'object', properties }).ok).toBe(false);
  });

  it('rejects invalid field names', () => {
    expect(
      validateCollectionSchema({ type: 'object', properties: { '1bad': { type: 'string' } } }).ok,
    ).toBe(false);
    expect(
      validateCollectionSchema({ type: 'object', properties: { 'has space': { type: 'string' } } })
        .ok,
    ).toBe(false);
  });

  it('rejects required fields that are not declared', () => {
    expect(
      validateCollectionSchema({
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['b'],
      }).ok,
    ).toBe(false);
  });

  it('rejects unknown field types', () => {
    expect(
      validateCollectionSchema({ type: 'object', properties: { a: { type: 'object' } } }).ok,
    ).toBe(false);
  });

  it('rejects array fields without a scalar items type', () => {
    expect(
      validateCollectionSchema({ type: 'object', properties: { a: { type: 'array' } } }).ok,
    ).toBe(false);
    expect(
      validateCollectionSchema({
        type: 'object',
        properties: { a: { type: 'array', items: { type: 'array' } } },
      }).ok,
    ).toBe(false);
  });

  it('rejects patterns that look catastrophic or are too long', () => {
    expect(
      validateCollectionSchema({
        type: 'object',
        properties: { a: { type: 'string', pattern: '(a+)+$' } },
      }).ok,
    ).toBe(false);
    expect(
      validateCollectionSchema({
        type: 'object',
        properties: { a: { type: 'string', pattern: 'x'.repeat(200) } },
      }).ok,
    ).toBe(false);
  });

  it('rejects an invalid regular expression', () => {
    expect(
      validateCollectionSchema({
        type: 'object',
        properties: { a: { type: 'string', pattern: '(unclosed' } },
      }).ok,
    ).toBe(false);
  });
});

describe('validateRecord', () => {
  const r = validateCollectionSchema(todoSchema);
  if (!r.ok) throw new Error('fixture schema invalid');
  const schema = r.schema;

  it('accepts a valid record', () => {
    expect(validateRecord(schema, { title: 'buy milk', done: false, priority: 2 })).toEqual([]);
  });

  it('requires required fields', () => {
    const errors = validateRecord(schema, { done: true });
    expect(errors.some((e) => e.includes('title'))).toBe(true);
  });

  it('rejects unknown fields', () => {
    const errors = validateRecord(schema, { title: 'x', evil: 1 });
    expect(errors.some((e) => e.includes('evil'))).toBe(true);
  });

  it('rejects wrong types', () => {
    expect(validateRecord(schema, { title: 123 }).length).toBeGreaterThan(0);
    expect(validateRecord(schema, { title: 'x', done: 'nope' }).length).toBeGreaterThan(0);
    expect(validateRecord(schema, { title: 'x', priority: 1.5 }).length).toBeGreaterThan(0);
  });

  it('enforces numeric bounds and enums', () => {
    expect(validateRecord(schema, { title: 'x', priority: 0 }).length).toBeGreaterThan(0);
    expect(validateRecord(schema, { title: 'x', priority: 6 }).length).toBeGreaterThan(0);
    expect(validateRecord(schema, { title: 'x', status: 'nope' }).length).toBeGreaterThan(0);
    expect(validateRecord(schema, { title: 'x', status: 'open' })).toEqual([]);
  });

  it('validates array items', () => {
    expect(validateRecord(schema, { title: 'x', tags: ['a', 'b'] })).toEqual([]);
    expect(validateRecord(schema, { title: 'x', tags: ['a', 2] }).length).toBeGreaterThan(0);
    expect(validateRecord(schema, { title: 'x', tags: 'not-array' }).length).toBeGreaterThan(0);
  });

  it('validates email format', () => {
    expect(validateRecord(schema, { title: 'x', email: 'a@b.com' })).toEqual([]);
    expect(validateRecord(schema, { title: 'x', email: 'nope' }).length).toBeGreaterThan(0);
  });

  it('allows partial records for PATCH merges', () => {
    expect(validateRecord(schema, { done: true }, { partial: true })).toEqual([]);
  });

  it('rejects non-object bodies', () => {
    expect(validateRecord(schema, 'nope').length).toBeGreaterThan(0);
    expect(validateRecord(schema, null).length).toBeGreaterThan(0);
    expect(validateRecord(schema, [1, 2]).length).toBeGreaterThan(0);
  });

  it('fakeRecord produces a value that validates', () => {
    for (let i = 0; i < 20; i++) {
      expect(validateRecord(schema, fakeRecord(schema))).toEqual([]);
    }
  });
});
