import { randomInt, randomUUID } from 'node:crypto';

/**
 * A deliberately small subset of JSON Schema: enough to describe a flat-ish REST
 * resource (the kind you'd mock for a frontend) without the full spec's recursion
 * and regex surface. Top level must be `type: "object"`.
 */
export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array';

export interface FieldSchema {
  type: FieldType;
  enum?: (string | number)[];
  format?: 'email' | 'uuid' | 'date' | 'date-time';
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  /** Anchored, length-capped, heuristically screened for catastrophic backtracking. */
  pattern?: string;
  /** Only present when type is "array"; items must be a scalar (no nested arrays/objects). */
  items?: { type: Exclude<FieldType, 'array'> };
}

export interface CollectionSchema {
  type: 'object';
  properties: Record<string, FieldSchema>;
  required?: string[];
  /** Always treated as false in practice; kept so a submitted "true" is a clear validation error. */
  additionalProperties?: false;
}

const MAX_PROPERTIES = 40;
const MAX_NAME_LEN = 60;
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,59}$/;
const FIELD_TYPES = new Set<FieldType>(['string', 'number', 'integer', 'boolean', 'array']);

/** Heuristic only: rejects the classic nested-quantifier shapes that cause exponential backtracking. */
function looksCatastrophic(pattern: string): boolean {
  if (pattern.length > 100) return true;
  if (/\([^)]*[+*][^)]*\)[+*]/.test(pattern)) return true; // (a+)+ / (a*)* style
  if (/(\.\*){2,}/.test(pattern)) return true;
  return false;
}

export function validateCollectionSchema(
  input: unknown,
): { ok: true; schema: CollectionSchema } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'schema must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  if (obj.type !== 'object') return { ok: false, error: 'schema.type must be "object"' };
  if (obj.additionalProperties === true) {
    return {
      ok: false,
      error: 'additionalProperties: true is not supported (keep it unset or false)',
    };
  }
  const props = obj.properties;
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return { ok: false, error: 'schema.properties must be an object' };
  }
  const propNames = Object.keys(props);
  if (propNames.length === 0)
    return { ok: false, error: 'schema.properties must have at least one field' };
  if (propNames.length > MAX_PROPERTIES) {
    return { ok: false, error: `schema.properties cannot exceed ${MAX_PROPERTIES} fields` };
  }
  const properties: Record<string, FieldSchema> = {};
  for (const name of propNames) {
    if (name.length > MAX_NAME_LEN || !NAME_RE.test(name)) {
      return {
        ok: false,
        error: `invalid field name "${name}" (letters/digits/underscore, starting with a letter or _)`,
      };
    }
    const fr = validateFieldSchema((props as Record<string, unknown>)[name]);
    if (!fr.ok) return { ok: false, error: `field "${name}": ${fr.error}` };
    properties[name] = fr.field;
  }
  let required: string[] | undefined;
  if (obj.required !== undefined) {
    if (!Array.isArray(obj.required) || !obj.required.every((r) => typeof r === 'string')) {
      return { ok: false, error: 'schema.required must be an array of field names' };
    }
    for (const r of obj.required as string[]) {
      if (!(r in properties))
        return { ok: false, error: `required field "${r}" is not in properties` };
    }
    required = obj.required as string[];
  }
  return {
    ok: true,
    schema: { type: 'object', properties, required, additionalProperties: false },
  };
}

function validateFieldSchema(
  input: unknown,
): { ok: true; field: FieldSchema } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'must be an object' };
  }
  const f = input as Record<string, unknown>;
  if (typeof f.type !== 'string' || !FIELD_TYPES.has(f.type as FieldType)) {
    return { ok: false, error: `type must be one of ${[...FIELD_TYPES].join(', ')}` };
  }
  const type = f.type as FieldType;
  const field: FieldSchema = { type };
  if (f.enum !== undefined) {
    if (!Array.isArray(f.enum) || f.enum.length === 0 || f.enum.length > 50) {
      return { ok: false, error: 'enum must be a non-empty array of up to 50 values' };
    }
    if (!f.enum.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return { ok: false, error: 'enum values must be strings or numbers' };
    }
    field.enum = f.enum as (string | number)[];
  }
  if (f.format !== undefined) {
    if (!['email', 'uuid', 'date', 'date-time'].includes(f.format as string)) {
      return { ok: false, error: 'format must be email, uuid, date or date-time' };
    }
    field.format = f.format as FieldSchema['format'];
  }
  if (f.pattern !== undefined) {
    if (typeof f.pattern !== 'string') return { ok: false, error: 'pattern must be a string' };
    if (looksCatastrophic(f.pattern)) {
      return {
        ok: false,
        error: 'pattern rejected (too long, or a shape known to cause slow matching)',
      };
    }
    try {
      new RegExp(f.pattern);
    } catch {
      return { ok: false, error: 'pattern is not a valid regular expression' };
    }
    field.pattern = f.pattern;
  }
  for (const [key, out] of [
    ['minLength', 'minLength'],
    ['maxLength', 'maxLength'],
    ['minimum', 'minimum'],
    ['maximum', 'maximum'],
  ] as const) {
    if (f[key] !== undefined) {
      if (typeof f[key] !== 'number' || !Number.isFinite(f[key] as number)) {
        return { ok: false, error: `${key} must be a number` };
      }
      field[out] = f[key] as number;
    }
  }
  if (type !== 'array' && f.items !== undefined) {
    return { ok: false, error: 'items is only valid when type is "array"' };
  }
  if (type === 'array') {
    if (
      typeof f.items !== 'object' ||
      f.items === null ||
      typeof (f.items as Record<string, unknown>).type !== 'string' ||
      !FIELD_TYPES.has((f.items as Record<string, unknown>).type as FieldType) ||
      (f.items as Record<string, unknown>).type === 'array'
    ) {
      return { ok: false, error: 'array fields need items: { type: <scalar type> }' };
    }
    field.items = { type: (f.items as { type: Exclude<FieldType, 'array'> }).type };
  }
  return { ok: true, field };
}

export type ValidationErrors = string[];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function checkScalar(
  type: Exclude<FieldType, 'array'>,
  value: unknown,
  path: string,
  errors: string[],
): boolean {
  if (type === 'string' && typeof value !== 'string') errors.push(`${path} must be a string`);
  else if ((type === 'number' || type === 'integer') && typeof value !== 'number') {
    errors.push(`${path} must be a number`);
  } else if (type === 'integer' && typeof value === 'number' && !Number.isInteger(value)) {
    errors.push(`${path} must be an integer`);
  } else if (type === 'boolean' && typeof value !== 'boolean') {
    errors.push(`${path} must be a boolean`);
  } else {
    return true;
  }
  return false;
}

function checkField(name: string, field: FieldSchema, value: unknown, errors: string[]): void {
  const path = name;
  if (field.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path} must be an array`);
      return;
    }
    if (value.length > 200) {
      errors.push(`${path} cannot have more than 200 items`);
      return;
    }
    value.forEach((v, i) => checkScalar(field.items!.type, v, `${path}[${i}]`, errors));
    return;
  }
  if (!checkScalar(field.type, value, path, errors)) return;
  if (field.enum && !field.enum.includes(value as string | number)) {
    errors.push(`${path} must be one of ${field.enum.join(', ')}`);
  }
  if (typeof value === 'string') {
    if (field.minLength !== undefined && value.length < field.minLength) {
      errors.push(`${path} must be at least ${field.minLength} characters`);
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      errors.push(`${path} must be at most ${field.maxLength} characters`);
    }
    if (value.length > 2000) errors.push(`${path} cannot exceed 2000 characters`);
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      errors.push(`${path} does not match the required pattern`);
    }
    if (field.format === 'email' && !EMAIL_RE.test(value))
      errors.push(`${path} must be a valid email`);
    if (field.format === 'uuid' && !UUID_RE.test(value))
      errors.push(`${path} must be a valid uuid`);
    if (field.format === 'date' && !DATE_RE.test(value)) errors.push(`${path} must be YYYY-MM-DD`);
    if (field.format === 'date-time' && !DATE_TIME_RE.test(value)) {
      errors.push(`${path} must be an ISO date-time`);
    }
  }
  if (typeof value === 'number') {
    if (field.minimum !== undefined && value < field.minimum)
      errors.push(`${path} must be >= ${field.minimum}`);
    if (field.maximum !== undefined && value > field.maximum)
      errors.push(`${path} must be <= ${field.maximum}`);
  }
}

/**
 * Validates a plain object against a CollectionSchema.
 * @param partial when true, missing fields are allowed (used for PATCH merges after merging).
 */
export function validateRecord(
  schema: CollectionSchema,
  data: unknown,
  opts: { partial?: boolean } = {},
): ValidationErrors {
  const errors: string[] = [];
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['body must be a JSON object'];
  }
  const obj = data as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in schema.properties)) errors.push(`unknown field "${key}" is not in the schema`);
  }
  if (!opts.partial) {
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${req} is required`);
    }
  }
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!(name in obj)) continue;
    checkField(name, field, obj[name], errors);
  }
  return errors;
}

/** Generates one plausible value per field, for a quick `_seed` endpoint. */
export function fakeRecord(schema: CollectionSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    out[name] = fakeValue(name, field);
  }
  return out;
}

function fakeScalar(
  name: string,
  field: Pick<FieldSchema, 'type' | 'format' | 'minimum' | 'maximum' | 'minLength' | 'maxLength'>,
): unknown {
  const { type, format } = field;
  if (type === 'boolean') return Math.random() < 0.5;
  if (type === 'integer' || type === 'number') {
    const lo = field.minimum ?? 0;
    const hi = field.maximum ?? lo + 1000;
    if (type === 'integer') return randomInt(Math.ceil(lo), Math.floor(hi) + 1);
    const span = Math.max(hi - lo, 0.01);
    return Math.round((lo + Math.random() * span) * 100) / 100;
  }
  // string
  if (format === 'email') return `${name}.${randomInt(1000, 9999)}@example.com`;
  if (format === 'uuid') return randomUUID();
  if (format === 'date')
    return new Date(Date.now() - randomInt(0, 365) * 86_400_000).toISOString().slice(0, 10);
  if (format === 'date-time')
    return new Date(Date.now() - randomInt(0, 365) * 86_400_000).toISOString();
  let s = `${name}-${randomInt(1000, 9999)}`;
  if (field.minLength !== undefined && s.length < field.minLength) {
    s = s.padEnd(field.minLength, 'x');
  }
  if (field.maxLength !== undefined && s.length > field.maxLength) {
    s = s.slice(0, Math.max(field.maxLength, 0));
  }
  return s;
}

function fakeValue(name: string, field: FieldSchema): unknown {
  if (field.enum) return field.enum[randomInt(0, field.enum.length)];
  if (field.type === 'array') {
    const n = randomInt(0, 4);
    return Array.from({ length: n }, () => fakeScalar(name, { type: field.items!.type }));
  }
  return fakeScalar(name, field);
}
