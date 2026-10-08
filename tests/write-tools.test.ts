/**
 * Write tools, called through a real MCP client with ALTEGIO_ALLOW_WRITE on.
 * Every request the server sends is checked against the OpenAPI snapshot.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { AltegioClient } from '../src/client.js';
import { runTool } from '../src/server.js';
import { writeTools } from '../src/tools/write.js';
import { hang, json, ok, refusal } from './support/fake-api.js';
import * as fixtures from './support/fixtures.js';
import { IDS, RECORD_HASH, SLOT } from './support/fixtures.js';
import { createHarness, testConfig, type Harness } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const BOOKING = {
  client_name: 'Ірина Тестова',
  client_phone: '+380501234567',
  staff_id: IDS.staff,
  datetime: SLOT,
  service_ids: [IDS.haircut],
};
const CREATE = '/api/v1/book_record/4564';

describe('opt-in', () => {
  it('registers no write tool unless the operator allowed it', async () => {
    harness = await createHarness();

    const { tools } = await harness.mcp.listTools();

    assert.ok(!tools.some((tool) => writeTools.some((write) => write.name === tool.name)));
    await assert.rejects(harness.call('create_booking', BOOKING), /Tool create_booking not found/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('adds exactly three write tools after the read tools', async () => {
    harness = await createHarness({ allowWrite: true });

    const { tools } = await harness.mcp.listTools();

    assert.deepEqual(
      tools.slice(-3).map((tool) => tool.name),
      ['create_booking', 'send_phone_confirmation_code', 'cancel_booking'],
    );
    assert.equal(tools.length, 12);
  });
});

describe('create_booking', () => {
  it('sends the smallest documented body and returns the id and hash of the booking', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, ok(fixtures.createdBooking, 201));

    const result = await harness.call('create_booking', BOOKING);

    const request = harness.api.single;
    assert.equal(assertMatchesSpec(request), 'POST /book_record/{location_id}');
    assert.deepEqual(request.body, {
      phone: '+380501234567',
      fullname: 'Ірина Тестова',
      appointments: [{ id: 1, services: [IDS.haircut], staff_id: IDS.staff, datetime: SLOT }],
    });
    assert.equal(result.isError, false);
    assert.match(result.text, /^Altegio created booking 2820023\. Keep record_id and record_hash/);
    assert.deepEqual(JSON.parse(result.text.slice(result.text.indexOf('{'))), {
      location_id: IDS.location,
      record_id: IDS.record,
      record_hash: RECORD_HASH,
      datetime: SLOT,
    });
  });

  it('maps every optional argument onto the field Altegio documents', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, ok(fixtures.createdBooking, 201));

    await harness.callJson('create_booking', {
      ...BOOKING,
      client_name: '  Ірина Тестова  ',
      client_email: 'iryna@example.com',
      service_ids: [IDS.haircut, IDS.coloring],
      comment: 'Перший візит',
      phone_confirmation_code: '03882',
      sms_reminder_hours: 2,
      email_reminder_hours: 0,
      external_id: 'order-77',
    });

    const request = harness.api.single;
    assertMatchesSpec(request);
    assert.deepEqual(request.body, {
      phone: '+380501234567',
      fullname: 'Ірина Тестова',
      email: 'iryna@example.com',
      code: '03882',
      comment: 'Перший візит',
      notify_by_sms: 2,
      notify_by_email: 0,
      api_id: 'order-77',
      appointments: [{ id: 1, services: [IDS.haircut, IDS.coloring], staff_id: IDS.staff, datetime: SLOT }],
    });
  });

  it('books at the location of the arguments when the server is not bound', async () => {
    harness = await createHarness({ allowWrite: true, locationId: undefined });
    harness.api.on('POST', '/api/v1/book_record/9001', ok(fixtures.createdBooking, 201));

    const result = await harness.callJson('create_booking', { ...BOOKING, location_id: IDS.otherLocation });

    assert.equal(result.location_id, IDS.otherLocation);
  });

  it('refuses to book at another location than the one the server is bound to', async () => {
    harness = await createHarness({ allowWrite: true });

    const result = await harness.call('create_booking', { ...BOOKING, location_id: IDS.otherLocation });

    assert.equal(result.isError, true);
    assert.match(result.text, /bound to location 4564/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('passes a refusal on with its codes and does not call the outcome unknown', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, refusal(422, 'An error has occurred', [fixtures.slotTaken]));

    const result = await harness.call('create_booking', BOOKING);

    assert.equal(result.isError, true);
    assert.match(result.text, /^Altegio API error \(HTTP 422\): An error has occurred\n  - code 433: Team Member/);
    assert.doesNotMatch(result.text, /It is unknown whether/);
    assert.equal(harness.api.requests.length, 1, 'a refused booking is not retried');
  });

  it('explains a blacklisted client (HTTP 403)', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, refusal(403, 'Forbidden', [{ code: 434, message: 'The client is blacklisted' }]));

    const result = await harness.call('create_booking', BOOKING);

    assert.match(result.text, /code 434: The client is blacklisted/);
    assert.match(result.text, /blacklisted client phone \(code 434\)/);
  });

  for (const [name, response] of [
    ['a gateway error', json({ message: 'Bad gateway' }, 502)],
    ['HTTP 429', refusal(429, 'Too many requests')],
    ['a success status with an unreadable body', new Response('<html>', { status: 201 })],
  ] as const) {
    it(`says the outcome is unknown after ${name} and how to find out`, async () => {
      harness = await createHarness({ allowWrite: true });
      harness.api.on('POST', CREATE, response);

      const result = await harness.call('create_booking', BOOKING);

      assert.equal(result.isError, true);
      assert.match(result.text, /It is unknown whether Altegio carried out the operation\. Do not simply repeat the call\./);
      assert.match(result.text, new RegExp(`Call list_time_slots for team member ${IDS.staff} on 2026-10-12`));
      assert.equal(harness.api.requests.length, 1, 'the server never retries a booking');
    });
  }

  it('does not put "wait and retry" next to "do not repeat the call"', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, refusal(429, 'Too many requests'));

    const result = await harness.call('create_booking', BOOKING);

    assert.match(result.text, /^Altegio API error \(HTTP 429\): Too many requests\nIt is unknown whether/);
    assert.doesNotMatch(result.text, /Wait before retrying/);
  });

  it('does not send the model to the free slots when the booking was for any team member', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, json({ message: 'Bad gateway' }, 502));

    const result = await harness.call('create_booking', { ...BOOKING, staff_id: 0 });

    assert.match(result.text, /It is unknown whether Altegio carried out the operation/);
    assert.match(result.text, /asked for any team member, so the list of free slots cannot show whether it was made/);
    assert.doesNotMatch(result.text, /Call list_time_slots/);
    assert.match(result.text, /book again only after it confirms that there is no booking/);
  });

  it('says that a slot still on offer proves nothing', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, json({ message: 'Bad gateway' }, 502));

    const result = await harness.call('create_booking', BOOKING);

    assert.match(result.text, /If it is still offered, the booking may nevertheless exist or still be on its way/);
  });

  it('treats success: false under a success status as a refusal, not as an unknown outcome', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, refusal(201, 'The client is blacklisted'));

    const result = await harness.call('create_booking', BOOKING);

    assert.equal(result.isError, true);
    assert.match(result.text, /^Altegio API error \(HTTP 201\): The client is blacklisted$/);
    assert.doesNotMatch(result.text, /It is unknown whether/);
  });

  it('says the outcome is unknown after a timeout', async () => {
    const config = testConfig({ allowWrite: true, timeoutMs: 30 });
    const client = new AltegioClient({ config, fetch: (_url, init) => hang(init) });
    const tool = writeTools.find((candidate) => candidate.name === 'create_booking');
    assert.ok(tool);

    const result = await runTool(tool, BOOKING, { config, client });

    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^POST \/book_record\/\{location_id\} timed out after 0\.03 s\.\nIt is unknown whether/);
  });

  it('does not report a booking it has no id for', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', CREATE, ok([], 201));

    const result = await harness.call('create_booking', BOOKING);

    assert.equal(result.isError, false);
    assert.match(result.text, /answered with success but without a booking id/);
    assert.match(result.text, /Do not repeat the call/);
  });

  it('validates the arguments before anything is sent', async () => {
    harness = await createHarness({ allowWrite: true });
    const invalid: Record<string, unknown>[] = [
      { ...BOOKING, client_phone: '050 123 45 67' },
      { ...BOOKING, client_name: '   ' },
      { ...BOOKING, client_email: 'not-an-email' },
      { ...BOOKING, service_ids: [] },
      { ...BOOKING, datetime: '2026-10-12 15:30' },
      { ...BOOKING, datetime: '2026-10-12T15:30:00' },
      { ...BOOKING, staff_id: -1 },
      { ...BOOKING, phone_confirmation_code: 'abc' },
      { ...BOOKING, sms_reminder_hours: 1.5 },
      { ...BOOKING, external_id: 'has spaces' },
      { ...BOOKING, discount: 10 },
      { client_phone: BOOKING.client_phone, staff_id: IDS.staff, datetime: SLOT, service_ids: [IDS.haircut] },
    ];

    for (const args of invalid) {
      const result = await harness.call('create_booking', args);
      assert.equal(result.isError, true, JSON.stringify(args));
    }
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('send_phone_confirmation_code', () => {
  it('asks Altegio to send the code to the phone and nothing else', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', '/api/v1/book_code/4564', json({ success: true, meta: { message: 'Created' } }, 201));

    const result = await harness.call('send_phone_confirmation_code', { client_phone: '+380501234567' });

    const request = harness.api.single;
    assert.equal(assertMatchesSpec(request), 'POST /book_code/{location_id}');
    assert.deepEqual(request.body, { phone: '+380501234567' });
    assert.equal(result.isError, false);
    assert.match(result.text, /^Altegio accepted the request to send the code\./);
  });

  it('does not invite a second SMS when the outcome is unknown', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('POST', '/api/v1/book_code/4564', json({ message: 'Gateway timeout' }, 504));

    const result = await harness.call('send_phone_confirmation_code', { client_phone: '+380501234567' });

    assert.equal(result.isError, true);
    assert.match(result.text, /Ask the client whether the SMS arrived before sending another one\./);
    assert.equal(harness.api.requests.length, 1);
  });
});

describe('cancel_booking', () => {
  const path = `/api/v1/user/records/${IDS.record}/${RECORD_HASH}`;

  it('deletes the booking by id and hash', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('DELETE', path, new Response(null, { status: 200 }));

    const result = await harness.call('cancel_booking', { record_id: IDS.record, record_hash: RECORD_HASH });

    const request = harness.api.single;
    assert.equal(assertMatchesSpec(request), 'DELETE /user/records/{record_id}/{record_hash}');
    assert.equal(request.body, undefined);
    assert.equal(result.isError, false);
    assert.equal(result.text, 'Altegio accepted the cancellation of booking 2820023.');
  });

  it('passes on the refusal of a location that does not let clients cancel', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('DELETE', path, refusal(403, 'Deleting appointments is forbidden'));

    const result = await harness.call('cancel_booking', { record_id: IDS.record, record_hash: RECORD_HASH });

    assert.equal(result.isError, true);
    assert.match(result.text, /^Altegio API error \(HTTP 403\): Deleting appointments is forbidden/);
    assert.doesNotMatch(result.text, /It is unknown whether/);
  });

  it('tells how to check after an answer that proves nothing', async () => {
    harness = await createHarness({ allowWrite: true });
    harness.api.on('DELETE', path, json({ message: 'Bad gateway' }, 502));

    const result = await harness.call('cancel_booking', { record_id: IDS.record, record_hash: RECORD_HASH });

    assert.match(result.text, /It is unknown whether Altegio carried out the operation/);
    assert.match(result.text, /Call get_booking with the same record_id and record_hash/);
    assert.equal(harness.api.requests.length, 1);
  });

  it('needs both the id and the hash', async () => {
    harness = await createHarness({ allowWrite: true });

    const result = await harness.call('cancel_booking', { record_id: IDS.record });

    assert.equal(result.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});
