/**
 * The endpoint catalogue (src/endpoints.ts) must agree with the snapshot of the
 * Altegio OpenAPI documents: same operations, the partner token as the only
 * credential, the same path parameters.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { API_BASE_PATH, ENDPOINTS, type Endpoint } from '../src/endpoints.js';
import { KNOWN_DEVIATIONS, snapshot, validate } from './support/spec.js';

const entries = Object.entries(ENDPOINTS) as [string, Endpoint][];

describe('endpoint catalogue vs. OpenAPI snapshot', () => {
  it('uses snapshots taken from the documents on developer.alteg.io', () => {
    assert.deepEqual(Object.keys(snapshot.documents).sort(), ['business-v1', 'online-booking']);
    assert.equal(snapshot.documents['online-booking'].title, 'Online Booking');
    assert.equal(snapshot.documents['business-v1'].title, 'Business Management');
    for (const document of Object.values(snapshot.documents)) {
      assert.match(document.source, /^https:\/\/developer\.alteg\.io\/_bundle\/en\/[\w-]+\/openapi\.json$/);
      assert.match(document.version, /^\d+\.\d+\.\d+/);
      assert.equal(document.server, `https://api.alteg.io${API_BASE_PATH}`);
    }
  });

  it('covers exactly the operations in the catalogue', () => {
    const catalogue = entries.map(([, endpoint]) => `${endpoint.method} ${endpoint.path}`).sort();
    assert.deepEqual(Object.keys(snapshot.operations).sort(), catalogue);
  });

  for (const [name, endpoint] of entries) {
    it(`${name}: ${endpoint.method} ${endpoint.path}`, () => {
      const operation = snapshot.operations[`${endpoint.method} ${endpoint.path}`];
      assert.ok(operation, 'operation is missing from the snapshot');

      assert.equal(operation.document, endpoint.document, 'the document that describes it');
      // The server has no user token, so it may only call what the partner token alone opens.
      assert.deepEqual(operation.security, ['BearerPartner'], 'security scheme');
      assert.ok(operation.successStatuses.length > 0, 'documents a success response');

      const templateParams = [...endpoint.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const specParams = operation.parameters.filter((parameter) => parameter.in === 'path').map((parameter) => parameter.name);
      assert.deepEqual(templateParams.sort(), specParams.sort(), 'path parameters');
    });
  }
});

describe('known deviations from the documents', () => {
  it('are exactly the four listed in the README', () => {
    assert.deepEqual(Object.keys(KNOWN_DEVIATIONS).sort(), [
      'GET /book_staff/{location_id} query.datetime',
      'GET /book_staff_seances/{location_id}/{team_member_id} query.datetime',
      'POST /book_record/{location_id} body.api_id',
      'POST /book_record/{location_id} body.code',
    ]);
  });

  for (const key of Object.keys(KNOWN_DEVIATIONS)) {
    it(`${key} is still declared as a number by the document`, () => {
      // When Altegio corrects the document this fails, and the entry has to go.
      const [method = '', path = '', where = ''] = key.split(' ');
      const operation = snapshot.operations[`${method} ${path}`];
      assert.ok(operation);
      const [place = '', name = ''] = where.split('.');

      let declared: unknown;
      if (place === 'query') {
        declared = operation.parameters.find((parameter) => parameter.in === 'query' && parameter.name === name)?.schema['type'];
      } else {
        const ref = String(operation.requestBody?.schema['$ref'] ?? '').split('/').pop() ?? '';
        const body = snapshot.schemas[operation.document][ref] as { properties?: Record<string, { type?: string }> } | undefined;
        declared = body?.properties?.[name]?.type;
      }
      assert.equal(declared, 'number');
    });
  }
});

describe('spec checker', () => {
  const context = { document: 'online-booking', operation: 'POST /book_record/{location_id}' } as const;
  const body = { $ref: '#/components/schemas/book_record_companyid_request_data_types' };
  const visit = { id: 1, services: [331], staff_id: 6544, datetime: '2026-10-12T15:30:00.000+03:00' };

  it('accepts a minimal valid booking', () => {
    assert.deepEqual(validate(context, body, { phone: '+380501234567', fullname: 'Ірина', appointments: [visit] }, 'body'), []);
  });

  it('reports fields the spec does not define', () => {
    const errors = validate(
      context,
      body,
      { phone: '+380501234567', fullname: 'Ірина', name: 'x', appointments: [{ ...visit, service_id: 331 }] },
      'body',
    );
    assert.deepEqual(errors, ['body.name: not defined in the spec', 'body.appointments[0].service_id: not defined in the spec']);
  });

  it('reports missing required fields and wrong types', () => {
    const errors = validate(context, body, { phone: 380501234567, appointments: [{ ...visit, staff_id: '6544', datetime: 'tomorrow' }] }, 'body');
    assert.deepEqual(errors, [
      'body.fullname: required by the spec but missing',
      'body.phone: expected a string',
      'body.appointments[0].staff_id: expected a number',
      'body.appointments[0].datetime: is not a valid date-time',
    ]);
  });

  it('lets a known deviation through only as a string', () => {
    const base = { phone: '+380501234567', fullname: 'Ірина', appointments: [visit] };
    assert.deepEqual(validate(context, body, { ...base, code: '03882', api_id: 'order-77' }, 'body'), []);
    assert.deepEqual(validate(context, body, { ...base, code: 3882 }, 'body'), ['body.code: a known deviation must be sent as a string']);
  });
});
