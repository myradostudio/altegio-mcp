/**
 * Checks recorded requests against the snapshot of the Altegio OpenAPI documents
 * (spec/altegio-api.snapshot.json, refreshed with `npm run spec:update`).
 *
 * This is a deliberately small JSON Schema checker covering the keywords the
 * documents use for the operations this server calls. Unknown query parameters
 * and unknown body properties are reported: the server must not send what the
 * API does not define.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { API_BASE_PATH, type SpecDocument } from '../../src/endpoints.js';
import type { RecordedRequest } from './fake-api.js';

type Schema = Record<string, unknown>;

interface Parameter {
  readonly name: string;
  readonly in: 'query' | 'header' | 'path';
  readonly required: boolean;
  readonly schema: Schema;
}

export interface Operation {
  readonly document: SpecDocument;
  readonly security: readonly string[];
  readonly parameters: readonly Parameter[];
  readonly successStatuses: readonly string[];
  readonly requestBody?: { readonly required: boolean; readonly schema: Schema };
}

interface Snapshot {
  readonly documents: Readonly<Record<SpecDocument, { source: string; title: string; version: string; server: string }>>;
  readonly operations: Readonly<Record<string, Operation>>;
  readonly schemas: Readonly<Record<SpecDocument, Readonly<Record<string, Schema>>>>;
}

// Compiled tests live in build-test/tests/support/, three levels below the repository root.
export const snapshot = JSON.parse(
  readFileSync(new URL('../../../spec/altegio-api.snapshot.json', import.meta.url), 'utf8'),
) as Snapshot;

/**
 * Places where the server knowingly sends something else than the schema of the
 * document says, because the document contradicts itself there. Each one is
 * repeated in the README under "Limitations". tests/spec.test.ts fails when an
 * entry stops being a contradiction, so the list cannot go stale.
 */
export const KNOWN_DEVIATIONS: Readonly<Record<string, string>> = {
  'GET /book_staff/{location_id} query.datetime':
    'the schema says number, the description says "date in iso8601 format"; an ISO 8601 string is sent',
  'GET /book_staff_seances/{location_id}/{team_member_id} query.datetime':
    'the schema says number, the description says "date in iso8601 format"; an ISO 8601 string is sent',
  'POST /book_record/{location_id} body.code':
    'the schema says number, the field table says string; a string is sent so that a code starting with 0 survives',
  'POST /book_record/{location_id} body.api_id':
    'the schema says number, the field table says string ("External Appointment ID"); a string is sent',
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolve(document: SpecDocument, schema: Schema): Schema {
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return schema;
  const name = ref.split('/').pop() ?? '';
  const target = snapshot.schemas[document][name];
  assert.ok(target, `schema ${name} is missing from the snapshot`);
  return target;
}

const FORMATS: Readonly<Record<string, RegExp>> = {
  'date-time': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/,
};

export interface ValidationContext {
  readonly document: SpecDocument;
  /** Operation key, used to look up known deviations. */
  readonly operation: string;
}

/** Returns a list of violations; an empty list means the value fits the schema. */
export function validate(context: ValidationContext, rawSchema: Schema, value: unknown, path: string): string[] {
  if (KNOWN_DEVIATIONS[`${context.operation} ${path}`] !== undefined) {
    return typeof value === 'string' ? [] : [`${path}: a known deviation must be sent as a string`];
  }

  const schema = resolve(context.document, rawSchema);
  const errors: string[] = [];

  const allowed = schema['enum'] as unknown[] | undefined;
  if (allowed !== undefined && !allowed.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(allowed)}`);
  }

  const type = schema['type'] ?? (schema['properties'] !== undefined ? 'object' : undefined);
  switch (type) {
    case 'string': {
      if (typeof value !== 'string') return [...errors, `${path}: expected a string`];
      const format = schema['format'] as string | undefined;
      const formatPattern = format === undefined ? undefined : FORMATS[format];
      if (formatPattern !== undefined && !formatPattern.test(value)) errors.push(`${path}: is not a valid ${format}`);
      break;
    }
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) {
        errors.push(`${path}: expected ${type === 'integer' ? 'an integer' : 'a number'}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected a boolean`);
      break;
    case 'array': {
      if (!Array.isArray(value)) return [...errors, `${path}: expected an array`];
      const items = schema['items'] as Schema | undefined;
      if (items !== undefined) {
        value.forEach((item, index) => errors.push(...validate(context, items, item, `${path}[${index}]`)));
      }
      break;
    }
    case 'object': {
      if (!isObject(value)) return [...errors, `${path}: expected an object`];
      const properties = schema['properties'] as Record<string, Schema> | undefined;
      for (const name of (schema['required'] as string[] | undefined) ?? []) {
        if (value[name] === undefined) errors.push(`${path}.${name}: required by the spec but missing`);
      }
      if (properties !== undefined) {
        for (const [name, item] of Object.entries(value)) {
          const property = properties[name];
          if (property === undefined) errors.push(`${path}.${name}: not defined in the spec`);
          else errors.push(...validate(context, property, item, `${path}.${name}`));
        }
      }
      break;
    }
    default:
      break;
  }
  return errors;
}

/** Converts a query-string or path value to the type its schema declares, as the API server would. */
function coerce(schema: Schema, raw: string): unknown {
  const type = schema['type'];
  if (type === 'integer' || type === 'number') return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
  return raw;
}

function findOperation(request: RecordedRequest): { key: string; operation: Operation; pathParams: Record<string, string> } {
  assert.ok(
    request.url.pathname.startsWith(`${API_BASE_PATH}/`),
    `${request.url.pathname} is outside the documented server path ${API_BASE_PATH}`,
  );
  const pathname = request.url.pathname.slice(API_BASE_PATH.length);

  for (const [key, operation] of Object.entries(snapshot.operations)) {
    const [method = '', template = ''] = key.split(' ');
    if (method !== request.method) continue;
    const names: string[] = [];
    const pattern = template.replace(/\{(\w+)\}/g, (_match, name: string) => {
      names.push(name);
      return '([^/]+)';
    });
    const match = new RegExp(`^${pattern}$`).exec(pathname);
    if (match === null) continue;
    const pathParams = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? '')]));
    return { key, operation, pathParams };
  }
  assert.fail(`${request.method} ${pathname} is not an operation of the Altegio OpenAPI snapshot`);
}

/**
 * Asserts that a request the server sent is valid according to the documents:
 * known operation, declared and well-typed path and query parameters, the
 * partner token alone in the Authorization header, the versioned Accept header,
 * and a body that fits the request schema.
 * Returns the matched operation key, e.g. `GET /book_services/{location_id}`.
 */
export function assertMatchesSpec(request: RecordedRequest): string {
  const { key, operation, pathParams } = findOperation(request);
  const context: ValidationContext = { document: operation.document, operation: key };
  const errors: string[] = [];
  const parameters = (location: Parameter['in']) => operation.parameters.filter((parameter) => parameter.in === location);

  for (const parameter of parameters('path')) {
    const raw = pathParams[parameter.name] ?? '';
    errors.push(...validate(context, parameter.schema, coerce(parameter.schema, raw), `path.${parameter.name}`));
  }

  const query = parameters('query');
  for (const name of new Set(request.url.searchParams.keys())) {
    const parameter = query.find((candidate) => candidate.name === name);
    if (parameter === undefined) {
      errors.push(`query.${name}: not a query parameter of ${key}`);
      continue;
    }
    const values = request.url.searchParams.getAll(name);
    if (name.endsWith('[]')) {
      // The documents declare `service_ids[]` as an array in some operations and as a
      // string in others. The server always sends it as repeated keys, the form in
      // which the bracket suffix has a meaning; every value must be a numeric id.
      for (const value of values) {
        if (!/^[1-9]\d*$/.test(value)) errors.push(`query.${name}: ${JSON.stringify(value)} is not a numeric id`);
      }
      continue;
    }
    if (values.length !== 1) errors.push(`query.${name}: sent ${values.length} times but is not a list`);
    errors.push(...validate(context, parameter.schema, coerce(parameter.schema, values[0] ?? ''), `query.${name}`));
  }
  for (const parameter of query) {
    if (parameter.required && !request.url.searchParams.has(parameter.name)) {
      errors.push(`query.${parameter.name}: required by the spec but missing`);
    }
  }

  // Every operation the server uses is documented with the partner token alone.
  if (!/^Bearer [^\s,]+$/.test(request.headers['authorization'] ?? '')) {
    errors.push('header Authorization: must be "Bearer <partner token>" and nothing else');
  }
  if (request.headers['accept'] !== 'application/vnd.api.v2+json') {
    errors.push('header Accept: must be application/vnd.api.v2+json');
  }
  if (request.headers['content-type'] !== 'application/json') {
    errors.push('header Content-Type: declared as required for every operation');
  }

  if (operation.requestBody === undefined) {
    if (request.body !== undefined) errors.push('body: the operation does not take a request body');
  } else if (request.body === undefined) {
    if (operation.requestBody.required) errors.push('body: required by the spec but missing');
  } else {
    errors.push(...validate(context, operation.requestBody.schema, request.body, 'body'));
  }

  assert.deepEqual(errors, [], `${request.method} ${request.url.pathname}${request.url.search} violates the spec`);
  return key;
}
