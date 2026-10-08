import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AltegioClient, RATE_WINDOWS } from '../src/client.js';
import { ENDPOINTS } from '../src/endpoints.js';
import {
  AltegioApiError,
  AltegioTransportError,
  describeError,
  RateLimitError,
  UnexpectedResponseError,
} from '../src/errors.js';
import { RateLimiter } from '../src/rate-limit.js';
import { FakeApi, hang, json, ok, refusal } from './support/fake-api.js';
import { PARTNER_TOKEN, testConfig } from './support/harness.js';

function setup(overrides: Parameters<typeof testConfig>[0] = {}) {
  const api = new FakeApi();
  const waits: number[] = [];
  let now = 1_000_000;
  const client = new AltegioClient({
    config: testConfig(overrides),
    fetch: api.fetch,
    now: () => now,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms;
    },
  });
  return { api, client, waits, advance: (ms: number) => (now += ms) };
}

const services = { pathParams: { location_id: 4564 } } as const;

describe('requests', () => {
  it('sends the partner token, the versioned Accept header and a client name', async () => {
    const { api, client } = setup();
    api.on('GET', '/api/v1/book_services/4564', ok({ services: [] }));

    await client.request(ENDPOINTS.services, services);

    const { headers, method, url, redirect, body } = api.single;
    assert.equal(method, 'GET');
    assert.equal(url.href, 'https://api.altegio.test/api/v1/book_services/4564');
    assert.equal(headers['authorization'], `Bearer ${PARTNER_TOKEN}`);
    assert.equal(headers['accept'], 'application/vnd.api.v2+json');
    assert.equal(headers['content-type'], 'application/json');
    assert.match(headers['user-agent'] ?? '', /^altegio-mcp\/\d+\.\d+\.\d+$/);
    assert.equal(redirect, 'manual');
    assert.equal(body, undefined);
  });

  it('sends lists of ids as repeated bracket keys and skips undefined values', async () => {
    const { api, client } = setup();
    api.on('GET', '/api/v1/book_services/4564', ok({ services: [] }));

    await client.request(ENDPOINTS.services, {
      ...services,
      query: { staff_id: 6544, service_ids: [11, 22], datetime: undefined, without_seances: 1 },
    });

    assert.equal(api.single.url.search, '?staff_id=6544&service_ids%5B%5D=11&service_ids%5B%5D=22&without_seances=1');
  });

  it('encodes path parameters and refuses dot segments and missing values', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, ok({}));

    await client.request(ENDPOINTS.booking, { pathParams: { location_id: 1, record_id: 2, record_hash: 'a/b?c' } });
    assert.equal(api.single.url.pathname, '/api/v1/book_record/1/2/a%2Fb%3Fc');

    await assert.rejects(
      client.request(ENDPOINTS.booking, { pathParams: { location_id: 1, record_id: 2, record_hash: '..' } }),
      /Invalid value for path parameter "record_hash"/,
    );
    await assert.rejects(client.request(ENDPOINTS.services, {}), /Missing path parameter "location_id"/);
    assert.equal(api.requests.length, 1, 'nothing is sent for an invalid path');
  });

  it('serialises the body as JSON', async () => {
    const { api, client } = setup();
    api.on('POST', '/api/v1/book_check/4564', ok(null, 201));

    await client.request(ENDPOINTS.checkBooking, { ...services, body: { appointments: [{ id: 1 }] } });

    assert.deepEqual(api.single.body, { appointments: [{ id: 1 }] });
  });

  it('returns null for an empty success body', async () => {
    const { api, client } = setup();
    api.on('DELETE', /.*/, new Response(null, { status: 200 }));

    const result = await client.request(ENDPOINTS.cancelBooking, { pathParams: { record_id: 2, record_hash: 'abcdef' } });

    assert.equal(result, null);
  });
});

describe('failures', () => {
  it('turns an error answer into AltegioApiError with the message and the coded details', async () => {
    const { api, client } = setup();
    api.on(
      'POST',
      /.*/,
      refusal(422, 'An error has occurred', [
        { code: 433, message: 'The selected time is already taken' },
        { code: 436, message: 'No team members available' },
      ]),
    );

    const error = await client.request(ENDPOINTS.checkBooking, { ...services, body: {} }).catch((e: unknown) => e);

    assert.ok(error instanceof AltegioApiError);
    assert.equal(error.status, 422);
    assert.equal(error.message, 'An error has occurred');
    assert.deepEqual(error.details, [
      { code: 433, message: 'The selected time is already taken' },
      { code: 436, message: 'No team members available' },
    ]);
    assert.equal(
      describeError(error),
      'Altegio API error (HTTP 422): An error has occurred\n  - code 433: The selected time is already taken\n  - code 436: No team members available',
    );
  });

  it('adds a hint for the statuses it can explain', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, refusal(401, 'Partner token is invalid'));

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.match(describeError(error), /^Altegio API error \(HTTP 401\): Partner token is invalid\nAltegio rejected the partner token\. Check ALTEGIO_PARTNER_TOKEN\.$/);
  });

  it('treats success: false as an error even when the status is 200', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, refusal(200, 'Location is not available'));

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.ok(error instanceof AltegioApiError);
    assert.equal(error.message, 'Location is not available');
  });

  it('keeps a truncated text for an error that is not JSON', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response(`<html>${'x'.repeat(2_000)}</html>`, { status: 502 }));

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.ok(error instanceof AltegioApiError);
    assert.equal(error.status, 502);
    assert.equal(error.message.length, 500);
  });

  it('removes the partner token from anything the API echoes back', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, refusal(403, `Token ${PARTNER_TOKEN} has no access`, [{ code: 403, message: `Bearer ${PARTNER_TOKEN}` }]));

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    const text = describeError(error);
    assert.ok(!text.includes(PARTNER_TOKEN));
    assert.match(text, /Token \[redacted\] has no access/);
    assert.match(text, /code 403: Bearer \[redacted\]/);
  });

  it('does not follow a redirect and says what to check', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.ok(error instanceof UnexpectedResponseError);
    assert.match(error.message, /redirect \(HTTP 302\)/);
    assert.match(error.message, /ALTEGIO_API_URL/);
    assert.equal(api.requests.length, 1);
  });

  it('reports a success status with a body that is not JSON', async () => {
    const { api, client } = setup();
    api.on('GET', /.*/, new Response('<html>ok</html>', { status: 200 }));

    await assert.rejects(client.request(ENDPOINTS.services, services), (error: unknown) => {
      assert.ok(error instanceof UnexpectedResponseError);
      assert.match(error.message, /not valid JSON/);
      return true;
    });
  });

  it('times out instead of waiting forever', async () => {
    const client = new AltegioClient({ config: testConfig({ timeoutMs: 40 }), fetch: (_url, init) => hang(init) });

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.ok(error instanceof AltegioTransportError);
    assert.equal(error.kind, 'timeout');
    assert.match(error.message, /GET \/book_services\/\{location_id\} timed out after 0\.04 s/);
  });

  it('reports a network failure with its cause and without the token', async () => {
    const client = new AltegioClient({
      config: testConfig(),
      fetch: async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
      },
    });

    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.ok(error instanceof AltegioTransportError);
    assert.equal(error.kind, 'network');
    assert.match(error.message, /no usable response from https:\/\/api\.altegio\.test \(ECONNREFUSED\)/);
  });

  it('never repeats a request on its own, whatever the answer', async () => {
    const { api, client } = setup();
    api.on('POST', /.*/, json({ message: 'Bad gateway' }, 502));

    await assert.rejects(client.request(ENDPOINTS.createBooking, { ...services, body: {} }));

    assert.equal(api.requests.length, 1);
  });
});

describe('request pacing', () => {
  it('implements the limits Altegio documents', () => {
    assert.deepEqual(RATE_WINDOWS, [
      { limit: 5, perMs: 1_000 },
      { limit: 200, perMs: 60_000 },
    ]);
  });

  it('lets five requests through at once and delays the sixth to the next second', async () => {
    const { api, client, waits } = setup();
    api.on('GET', /.*/, ok({ services: [] }));

    for (let i = 0; i < 6; i += 1) await client.request(ENDPOINTS.services, services);

    assert.deepEqual(waits, [1_000]);
    assert.equal(api.requests.length, 6);
  });

  it('does not delay requests that are spread out', async () => {
    const { api, client, waits, advance } = setup();
    api.on('GET', /.*/, ok({ services: [] }));

    for (let i = 0; i < 12; i += 1) {
      await client.request(ENDPOINTS.services, services);
      advance(250);
    }

    assert.deepEqual(waits, []);
  });

  it('refuses the 201st request of a minute without sending it and says when to retry', async () => {
    const { api, client, advance } = setup();
    api.on('GET', /.*/, ok({ services: [] }));

    for (let i = 0; i < 200; i += 1) {
      await client.request(ENDPOINTS.services, services);
      advance(210);
    }
    const error = await client.request(ENDPOINTS.services, services).catch((e: unknown) => e);

    assert.ok(error instanceof RateLimitError);
    assert.match(error.message, /^Not sent: Altegio allows 200 requests per minute and 5 per second/);
    assert.match(error.message, /Try again in 18 s\.$/);
    assert.equal(api.requests.length, 200);

    advance(18_000);
    await client.request(ENDPOINTS.services, services);
    assert.equal(api.requests.length, 201);
  });

  it('hands concurrent callers different slots', () => {
    let now = 0;
    const limiter = new RateLimiter([{ limit: 2, perMs: 1_000 }], () => now);

    const waits = [0, 1, 2, 3, 4].map(() => limiter.reserve(10_000).waitMs);

    assert.deepEqual(waits, [0, 0, 1_000, 1_000, 2_000]);
    now = 2_000;
    assert.equal(limiter.reserve(10_000).waitMs, 0, 'the second slot of the third second is still free');
    assert.equal(limiter.reserve(10_000).waitMs, 1_000);
  });

  it('books nothing when the wait would be too long', () => {
    const limiter = new RateLimiter([{ limit: 1, perMs: 60_000 }], () => 0);

    assert.deepEqual(limiter.reserve(0), { granted: true, waitMs: 0 });
    assert.deepEqual(limiter.reserve(5_000), { granted: false, waitMs: 60_000 });
    assert.deepEqual(limiter.reserve(5_000), { granted: false, waitMs: 60_000 }, 'a refused call does not push the next slot away');
  });
});
