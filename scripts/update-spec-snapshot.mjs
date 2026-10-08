// Refreshes spec/altegio-api.snapshot.json from the OpenAPI documents Altegio
// publishes on https://developer.alteg.io.
//
// The snapshot holds only what the tests need to check our requests: for every
// operation listed in src/endpoints.ts its parameters, request body schema and
// security schemes, plus the component schemas those refer to. Descriptions,
// titles and examples are dropped.
//
// Usage:
//   npm run spec:update                  download the current documents
//   npm run spec:update -- --from spec   use spec/openapi-<document>.json instead
//
// After a refresh run `npm test`: a failure means the API changed under a tool.

import { readFile, writeFile } from 'node:fs/promises';

import { ENDPOINTS } from '../dist/endpoints.js';

const SOURCES = {
  'online-booking': 'https://developer.alteg.io/_bundle/en/public/openapi.json',
  'business-v1': 'https://developer.alteg.io/_bundle/en/b2b-v1/openapi.json',
};
const SNAPSHOT_FILE = new URL('../spec/altegio-api.snapshot.json', import.meta.url);

/** JSON Schema keywords worth keeping; everything else (titles, descriptions, examples) is dropped. */
const SCHEMA_KEYWORDS = new Set([
  '$ref',
  'type',
  'format',
  'enum',
  'items',
  'properties',
  'required',
  'anyOf',
  'allOf',
  'oneOf',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'minItems',
  'maxItems',
  'default',
]);

async function loadDocument(name) {
  const fromIndex = process.argv.indexOf('--from');
  if (fromIndex !== -1) {
    const directory = process.argv[fromIndex + 1];
    if (!directory) throw new Error('--from needs a directory');
    return JSON.parse(await readFile(`${directory}/openapi-${name}.json`, 'utf8'));
  }
  const response = await fetch(SOURCES[name], { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GET ${SOURCES[name]} answered HTTP ${response.status}`);
  return response.json();
}

function reduceSchema(schema) {
  if (Array.isArray(schema)) return schema.map(reduceSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const reduced = {};
  for (const key of Object.keys(schema).sort()) {
    if (!SCHEMA_KEYWORDS.has(key)) continue;
    const value = schema[key];
    if (key === 'properties') {
      reduced.properties = Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((name) => [name, reduceSchema(value[name])]),
      );
    } else if (key === 'items' || key === 'anyOf' || key === 'allOf' || key === 'oneOf') {
      reduced[key] = reduceSchema(value);
    } else {
      reduced[key] = value;
    }
  }
  return reduced;
}

function collectRefs(value, into) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') into.add(item.split('/').pop());
      else collectRefs(item, into);
    }
  }
}

function reduceOperation(document, name, pathItem, operation) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])]
    .map((parameter) =>
      parameter.$ref ? document.components.parameters[parameter.$ref.split('/').pop()] : parameter,
    )
    .map((parameter) => ({
      name: parameter.name,
      in: parameter.in,
      required: parameter.required === true,
      schema: reduceSchema(parameter.schema ?? {}),
    }))
    .sort((a, b) => `${a.in} ${a.name}`.localeCompare(`${b.in} ${b.name}`));

  const security = operation.security ?? document.security ?? [];
  const reduced = {
    document: name,
    security: [...new Set(security.flatMap((requirement) => Object.keys(requirement)))].sort(),
    parameters,
    successStatuses: Object.keys(operation.responses ?? {})
      .filter((status) => status.startsWith('2'))
      .sort(),
  };

  const body = operation.requestBody?.content?.['application/json'];
  if (body) {
    reduced.requestBody = { required: operation.requestBody.required === true, schema: reduceSchema(body.schema) };
  }
  return reduced;
}

const documents = {};
const operations = {};
const schemas = {};

for (const name of Object.keys(SOURCES)) {
  const document = await loadDocument(name);
  documents[name] = {
    source: SOURCES[name],
    title: document.info?.title,
    version: document.info?.version,
    server: document.servers?.[0]?.url,
    securitySchemes: Object.keys(document.components?.securitySchemes ?? {}).sort(),
  };

  const kept = {};
  for (const endpoint of Object.values(ENDPOINTS)) {
    if (endpoint.document !== name) continue;
    const pathItem = document.paths?.[endpoint.path];
    const operation = pathItem?.[endpoint.method.toLowerCase()];
    if (!operation) {
      throw new Error(`${endpoint.method} ${endpoint.path} is not in the "${document.info?.title}" document any more`);
    }
    kept[`${endpoint.method} ${endpoint.path}`] = reduceOperation(document, name, pathItem, operation);
  }
  Object.assign(operations, kept);

  // Transitive closure of the component schemas the kept operations refer to.
  const own = {};
  const pending = new Set();
  collectRefs(kept, pending);
  while (pending.size > 0) {
    const [schemaName] = pending;
    pending.delete(schemaName);
    if (schemaName in own) continue;
    const schema = document.components?.schemas?.[schemaName];
    if (!schema) throw new Error(`Schema ${schemaName} is referenced but not defined in "${document.info?.title}"`);
    own[schemaName] = reduceSchema(schema);
    collectRefs(own[schemaName], pending);
  }
  schemas[name] = Object.fromEntries(Object.entries(own).sort(([a], [b]) => a.localeCompare(b)));
}

const snapshot = {
  documents,
  operations: Object.fromEntries(Object.entries(operations).sort(([a], [b]) => a.localeCompare(b))),
  schemas,
};

await writeFile(SNAPSHOT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(
  `Wrote ${Object.keys(operations).length} operations from ${Object.keys(documents).length} documents ` +
    `to spec/altegio-api.snapshot.json`,
);
