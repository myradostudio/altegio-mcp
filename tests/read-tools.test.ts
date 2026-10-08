/**
 * Read tools, called through a real MCP client. Every request the server sends
 * is checked against the snapshot of the Altegio OpenAPI documents.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { json, ok, refusal } from './support/fake-api.js';
import * as fixtures from './support/fixtures.js';
import { IDS, RECORD_HASH, SLOT } from './support/fixtures.js';
import { createHarness, type Harness } from './support/harness.js';
import { assertMatchesSpec } from './support/spec.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** The single request of the test, already checked against the spec. */
function sent(h: Harness) {
  const request = h.api.single;
  return { request, operation: assertMatchesSpec(request) };
}

describe('get_location', () => {
  it('returns the facts a booking conversation needs and nothing about widgets or social links', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/locations/4564', ok(fixtures.location));

    const result = await harness.callJson('get_location');

    assert.equal(sent(harness).operation, 'GET /locations/{location_id}');
    assert.equal(harness.api.single.url.search, '');
    assert.deepEqual(result, {
      id: IDS.location,
      title: 'Студія «Приклад»',
      country: 'Ukraine',
      city: 'Kyiv',
      address: 'вул. Прикладна, 1',
      zip: '01001',
      timezone_name: 'Europe/Kiev',
      site: 'https://example.com',
      coordinate_lat: 50.45,
      coordinate_lon: 30.52,
      phone_confirmation: false,
      active_staff_count: 2,
      main_group_id: 0,
      payment_policy: { type: 'none' },
    });
  });

  it('reports an answer that is not a location', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/locations/4564', ok([]));

    const result = await harness.call('get_location');

    assert.equal(result.isError, true);
    assert.match(result.text, /Unexpected response from the Altegio API: a location was expected/);
  });
});

describe('location binding', () => {
  it('uses the preset location when none is passed and accepts the same one', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/locations/4564', ok(fixtures.location));

    await harness.callJson('get_location', { location_id: IDS.location });

    assert.equal(harness.api.single.url.pathname, '/api/v1/locations/4564');
  });

  it('refuses another location without sending anything', async () => {
    harness = await createHarness();

    const result = await harness.call('list_services', { location_id: IDS.otherLocation });

    assert.equal(result.isError, true);
    assert.match(result.text, /bound to location 4564 \(ALTEGIO_LOCATION_ID\) and does not work with location 9001/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('takes the location from the arguments when the server is not bound', async () => {
    harness = await createHarness({ locationId: undefined });
    harness.api.on('GET', '/api/v1/book_staff/9001', ok([]));

    await harness.callJson('list_staff', { location_id: IDS.otherLocation });

    assert.equal(sent(harness).request.url.pathname, '/api/v1/book_staff/9001');
  });

  it('asks for a location when there is none at all', async () => {
    harness = await createHarness({ locationId: undefined });

    const result = await harness.call('list_staff');

    assert.equal(result.isError, true);
    assert.match(result.text, /No location given\. Pass location_id, or start the server with ALTEGIO_LOCATION_ID/);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('get_booking_form', () => {
  it('turns a form id into a location id and the confirmation rules', async () => {
    harness = await createHarness({ locationId: undefined });
    harness.api.on('GET', '/api/v1/bookform/123', ok(fixtures.bookingForm));

    const result = await harness.callJson('get_booking_form', { form_id: IDS.form });

    assert.equal(sent(harness).operation, 'GET /bookform/{id}');
    assert.deepEqual(result, {
      id: IDS.form,
      url: 'https://b123.alteg.io',
      group_id: 0,
      phone_confirmation: true,
      comment_required: false,
      sms_enabled: true,
      lang: 'uk-UA',
      location_id: IDS.location,
    });
  });
});

describe('get_booking_form on a bound server', () => {
  it('returns a form of the bound location', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/bookform/123', ok(fixtures.bookingForm));

    const result = await harness.callJson('get_booking_form', { form_id: IDS.form });

    assert.equal(result.location_id, IDS.location);
  });

  it('refuses a form that belongs to another location, so the binding cannot be walked around', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/bookform/777', ok({ ...fixtures.bookingForm, id: 777, company_id: IDS.otherLocation }));

    const result = await harness.call('get_booking_form', { form_id: 777 });

    assert.equal(result.isError, true);
    assert.equal(result.text, 'This server is bound to location 4564 (ALTEGIO_LOCATION_ID), and booking form 777 belongs to another location.');
    assert.ok(!result.text.includes(String(IDS.otherLocation)), 'the other location is not named');
  });
});

describe('list_services', () => {
  it('lists services and categories in compact form', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_services/4564', ok(fixtures.services));

    const result = await harness.callJson('list_services');

    assert.equal(sent(harness).operation, 'GET /book_services/{location_id}');
    assert.equal(harness.api.single.url.search, '');
    assert.deepEqual(result, {
      total: 2,
      returned: 2,
      next_offset: null,
      categories: [
        { id: IDS.category, title: 'Стрижки' },
        { id: 1895574, title: 'Фарбування волосся' },
      ],
      services: [
        {
          id: IDS.haircut,
          title: 'Стрижка жіноча',
          category_id: IDS.category,
          price_min: 600,
          price_max: 900,
          discount: 0,
          seance_length: 3600,
          prepaid: 'forbidden',
        },
        {
          id: IDS.coloring,
          title: 'Фарбування',
          category_id: 1895574,
          price_min: 1500,
          price_max: 3000,
          discount: 10,
          seance_length: 7200,
          comment: 'Ціна залежить від довжини',
          prepaid: 'allowed',
        },
      ],
    });
  });

  it('passes the API filters on', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_services/4564', ok(fixtures.services));

    await harness.callJson('list_services', {
      staff_id: IDS.staff,
      datetime: '2026-10-12T15:30',
      service_ids: [IDS.haircut, IDS.coloring],
      only_catalog: true,
    });

    const { request } = sent(harness);
    assert.equal(request.url.searchParams.get('staff_id'), String(IDS.staff));
    assert.equal(request.url.searchParams.get('datetime'), '2026-10-12T15:30');
    assert.deepEqual(request.url.searchParams.getAll('service_ids[]'), [String(IDS.haircut), String(IDS.coloring)]);
    assert.equal(request.url.searchParams.get('without_seances'), '1');
  });

  it('does not send only_catalog=false or its own filters to the API', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_services/4564', ok(fixtures.services));

    await harness.callJson('list_services', { only_catalog: false, search: 'фарб', category_id: 1895574, limit: 5, offset: 0 });

    assert.equal(sent(harness).request.url.search, '');
  });

  it('searches titles without regard to case and filters by category', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_services/4564', ok(fixtures.services));

    const bySearch = await harness.callJson('list_services', { search: 'ФАРБ' });
    const byCategory = await harness.callJson('list_services', { category_id: IDS.category });

    assert.deepEqual(bySearch.services.map((service: { id: number }) => service.id), [IDS.coloring]);
    assert.equal(bySearch.total, 1);
    assert.deepEqual(byCategory.services.map((service: { id: number }) => service.id), [IDS.haircut]);
  });

  it('pages through a long list on its own side', async () => {
    harness = await createHarness();
    const many = Array.from({ length: 7 }, (_, index) => ({ id: index + 1, title: `Послуга ${index + 1}`, category_id: 1 }));
    harness.api.on('GET', '/api/v1/book_services/4564', ok({ events: [], services: many, category: [] }));

    const first = await harness.callJson('list_services', { limit: 3 });
    const last = await harness.callJson('list_services', { limit: 3, offset: 6 });

    assert.deepEqual([first.total, first.returned, first.next_offset], [7, 3, 3]);
    assert.deepEqual([last.total, last.returned, last.next_offset], [7, 1, null]);
    assert.deepEqual(last.services, [{ id: 7, title: 'Послуга 7', category_id: 1 }]);
  });

  it('accepts the category list under either documented name', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_services/4564', ok({ services: [], categories: [{ id: 1, title: 'A', weight: 3 }] }));

    const result = await harness.callJson('list_services');

    assert.deepEqual(result.categories, [{ id: 1, title: 'A' }]);
  });

  it('rejects an argument it does not know instead of ignoring it', async () => {
    harness = await createHarness();

    const result = await harness.call('list_services', { price_max: 500 });

    assert.equal(result.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('list_staff', () => {
  it('lists team members without avatars and HTML biographies', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_staff/4564', ok(fixtures.staff));

    const result = await harness.callJson('list_staff');

    assert.equal(sent(harness).operation, 'GET /book_staff/{location_id}');
    assert.deepEqual(result, {
      returned: 2,
      staff: [
        {
          id: IDS.staff,
          name: 'Олена',
          specialization: 'Перукар',
          bookable: true,
          seance_date: '2026-10-12',
          schedule_till: '2026-11-30',
          rating: 4.9,
          votes_count: 12,
          position: 'Топ-стиліст',
        },
        { id: IDS.otherStaff, name: 'Марія', specialization: 'Колорист', bookable: false, rating: 0, votes_count: 0 },
      ],
    });
  });

  it('filters by services and a moment on the API side, by bookable on its own side', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_staff/4564', ok(fixtures.staff));

    const result = await harness.callJson('list_staff', { service_ids: [IDS.haircut], datetime: SLOT, only_bookable: true });

    const { request } = sent(harness);
    assert.deepEqual([...request.url.searchParams.keys()], ['service_ids[]', 'datetime']);
    assert.equal(request.url.searchParams.get('datetime'), SLOT);
    assert.deepEqual(result.staff.map((member: { id: number }) => member.id), [IDS.staff]);
  });

  it('reports an answer that is not a list', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_staff/4564', ok({ staff: [] }));

    const result = await harness.call('list_staff');

    assert.equal(result.isError, true);
    assert.match(result.text, /a list of team members was expected/);
  });
});

describe('list_available_dates', () => {
  it('returns sorted booking and working dates', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_dates/4564', ok(fixtures.dates));

    const result = await harness.callJson('list_available_dates', { service_ids: [IDS.haircut], staff_id: IDS.staff });

    const { request, operation } = sent(harness);
    assert.equal(operation, 'GET /book_dates/{location_id}');
    assert.equal(request.url.search, `?service_ids%5B%5D=${IDS.haircut}&staff_id=${IDS.staff}`);
    assert.deepEqual(result, {
      booking_dates: ['2026-10-12', '2026-10-13', '2026-11-02'],
      working_dates: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-11-02'],
    });
  });

  it('sends one month, or a range that replaces it', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_dates/4564', ok(fixtures.dates));

    await harness.callJson('list_available_dates', { month: '2026-11-01' });
    await harness.callJson('list_available_dates', { month: '2026-11-01', date_from: '2026-10-12', date_to: '2026-10-20' });

    const [month, range] = harness.api.requests;
    assert.equal(month?.url.search, '?date=2026-11-01');
    assert.equal(range?.url.search, '?date_from=2026-10-12&date_to=2026-10-20');
    for (const request of harness.api.requests) assertMatchesSpec(request);
  });

  it('wants both ends of a range, in order', async () => {
    harness = await createHarness();

    const half = await harness.call('list_available_dates', { date_from: '2026-10-12' });
    const reversed = await harness.call('list_available_dates', { date_from: '2026-10-20', date_to: '2026-10-12' });

    assert.match(half.text, /date_from and date_to must be given together/);
    assert.match(reversed.text, /date_from must not be later than date_to/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('treats the empty arrays Altegio sends for "no data" as no dates', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_dates/4564', ok({ booking_days: [], booking_dates: [], working_days: [], working_dates: [] }));

    assert.deepEqual(await harness.callJson('list_available_dates'), { booking_dates: [], working_dates: [] });
  });

  it('rejects a date that does not exist', async () => {
    harness = await createHarness();

    const result = await harness.call('list_available_dates', { month: '2026-02-30' });

    assert.equal(result.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('list_time_slots', () => {
  it('lists the slots of a team member on a date', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/api/v1/book_times/4564/${IDS.staff}/2026-10-12`, ok(fixtures.slots));

    const result = await harness.callJson('list_time_slots', { staff_id: IDS.staff, date: '2026-10-12', service_ids: [IDS.haircut] });

    const { request, operation } = sent(harness);
    assert.equal(operation, 'GET /book_times/{location_id}/{team_member_id}/{date}');
    assert.deepEqual(request.url.searchParams.getAll('service_ids[]'), [String(IDS.haircut)]);
    assert.deepEqual(result, {
      date: '2026-10-12',
      returned: 2,
      slots: [
        { time: '15:30', datetime: SLOT, seance_length: 3600, sum_length: 3600 },
        { time: '16:30', datetime: '2026-10-12T16:30:00.000+03:00', seance_length: 3600, sum_length: 3600 },
      ],
    });
  });

  it('asks for any team member with staff_id 0', async () => {
    harness = await createHarness();
    harness.api.on('GET', '/api/v1/book_times/4564/0/2026-10-12', ok([]));

    const result = await harness.callJson('list_time_slots', { staff_id: 0, date: '2026-10-12' });

    assertMatchesSpec(harness.api.single);
    assert.deepEqual(result, { date: '2026-10-12', returned: 0, slots: [] });
  });

  it('needs a team member and a well-formed date', async () => {
    harness = await createHarness();

    const noStaff = await harness.call('list_time_slots', { date: '2026-10-12' });
    const badDate = await harness.call('list_time_slots', { staff_id: IDS.staff, date: '12.10.2026' });

    assert.equal(noStaff.isError, true);
    assert.equal(badDate.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('get_nearest_time_slots', () => {
  it('returns the nearest day with its slots', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/api/v1/book_staff_seances/4564/${IDS.staff}`, ok(fixtures.nearestSlots));

    const result = await harness.callJson('get_nearest_time_slots', {
      staff_id: IDS.staff,
      service_ids: [IDS.haircut],
      datetime: '2026-10-10T09:00',
    });

    const { request, operation } = sent(harness);
    assert.equal(operation, 'GET /book_staff_seances/{location_id}/{team_member_id}');
    assert.equal(request.url.searchParams.get('datetime'), '2026-10-10T09:00');
    assert.equal(result.seance_date, '2026-10-12');
    assert.equal(result.returned, 2);
    assert.equal(result.slots[0].datetime, SLOT);
  });

  it('says so when there is no free time', async () => {
    harness = await createHarness();
    harness.api.on('GET', `/api/v1/book_staff_seances/4564/${IDS.staff}`, ok([]));

    const result = await harness.call('get_nearest_time_slots', { staff_id: IDS.staff });

    assert.equal(result.isError, false);
    assert.equal(result.text, 'Altegio returned no free time for this team member.');
  });
});

describe('check_booking', () => {
  const args = { staff_id: IDS.staff, datetime: SLOT, service_ids: [IDS.haircut] };

  it('sends the documented validation request and reports a bookable slot', async () => {
    harness = await createHarness();
    harness.api.on('POST', '/api/v1/book_check/4564', json({ success: true, meta: { message: 'Created' } }, 201));

    const result = await harness.call('check_booking', args);

    const { request, operation } = sent(harness);
    assert.equal(operation, 'POST /book_check/{location_id}');
    assert.deepEqual(request.body, {
      appointments: [{ id: 1, services: [IDS.haircut], staff_id: IDS.staff, datetime: SLOT }],
    });
    assert.equal(result.isError, false);
    assert.match(result.text, /^Altegio accepts these booking parameters\. Nothing was created and the slot is not reserved\./);
    assert.deepEqual(JSON.parse(result.text.slice(result.text.indexOf('{'))), { can_be_booked: true });
  });

  it('reports a refusal as an answer, with the codes Altegio gave', async () => {
    harness = await createHarness();
    harness.api.on('POST', '/api/v1/book_check/4564', refusal(422, 'An error has occurred', [fixtures.slotTaken]));

    const result = await harness.call('check_booking', args);

    assert.equal(result.isError, false);
    assert.deepEqual(JSON.parse(result.text), {
      can_be_booked: false,
      reasons: [{ code: 433, message: fixtures.slotTaken.message }],
    });
  });

  it('reports "the team member does not provide the service" (HTTP 404) the same way', async () => {
    harness = await createHarness();
    harness.api.on('POST', '/api/v1/book_check/4564', refusal(404, "The team member doesn't provide the selected service"));

    const result = await harness.call('check_booking', args);

    assert.equal(result.isError, false);
    // 404 is documented for a wrong id as well, so the answer says that it may not be about the slot at all.
    assert.match(result.text, /^Altegio answered HTTP 404: either the team member does not provide this service, or the location, team member or service id is wrong\./);
    assert.deepEqual(JSON.parse(result.text.slice(result.text.indexOf('{'))), {
      can_be_booked: false,
      reasons: [{ code: null, message: "The team member doesn't provide the selected service" }],
    });
  });

  it('keeps a rejected token an error instead of calling the slot unavailable', async () => {
    harness = await createHarness();
    harness.api.on('POST', '/api/v1/book_check/4564', refusal(401, 'Unauthorized'));

    const result = await harness.call('check_booking', args);

    assert.equal(result.isError, true);
    assert.match(result.text, /Altegio API error \(HTTP 401\)/);
  });

  it('wants the start time with a UTC offset, as a slot returns it', async () => {
    harness = await createHarness();

    const result = await harness.call('check_booking', { ...args, datetime: '2026-10-12T15:30' });

    assert.equal(result.isError, true);
    assert.match(result.text, /UTC offset/);
    assert.equal(harness.api.requests.length, 0);
  });

  it('rejects a moment that does not exist instead of letting it roll over to another day', async () => {
    harness = await createHarness();

    for (const datetime of ['2026-02-30T15:30:00+02:00', '2026-10-12T24:00:00+03:00', '2026-10-12T15:60:00+03:00', '2026-13-01T10:00:00+03:00']) {
      const result = await harness.call('check_booking', { ...args, datetime });
      assert.equal(result.isError, true, datetime);
    }
    const filter = await harness.call('list_staff', { datetime: '2026-10-12T99:99' });
    assert.equal(filter.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });
});

describe('get_booking', () => {
  it('returns the booking by id and hash, whether or not the answer is wrapped', async () => {
    harness = await createHarness();
    const path = `/api/v1/book_record/4564/${IDS.record}/${RECORD_HASH}`;
    harness.api.on('GET', path, json(fixtures.booking));

    const bare = await harness.callJson('get_booking', { record_id: IDS.record, record_hash: RECORD_HASH });
    assert.equal(sent(harness).operation, 'GET /book_record/{location_id}/{record_id}/{record_hash}');

    harness.api.on('GET', path, ok(fixtures.booking));
    const wrapped = await harness.callJson('get_booking', { record_id: IDS.record, record_hash: RECORD_HASH });

    assert.deepEqual(wrapped, bare);
    assert.deepEqual(bare, {
      id: IDS.record,
      datetime: SLOT,
      date: '2026-10-12T12:30:00Z',
      create_date: '2026-10-08T09:00:00Z',
      last_change_date: '2026-10-08T09:00:00Z',
      length: 3600,
      deleted: false,
      attendance: 0,
      comment: 'Перший візит',
      online: true,
      master_requested: true,
      api_id: 'order-77',
      prepaid: false,
      prepaid_confirmed: false,
      services: [
        { id: IDS.haircut, title: 'Стрижка жіноча', cost: 600, price_min: 600, price_max: 900, discount: 0, seance_length: 3600, amount: 1 },
      ],
      staff: { id: IDS.staff, name: 'Олена', specialization: 'Перукар' },
      company: {
        id: IDS.location,
        title: 'Студія «Приклад»',
        city: 'Kyiv',
        address: 'вул. Прикладна, 1',
        phone: '+380441234567',
        timezone: '3',
        currency_short_title: '₴',
        allow_delete_record: true,
        allow_change_record: false,
      },
    });
  });

  it('rejects a hash that could change the path', async () => {
    harness = await createHarness();

    const result = await harness.call('get_booking', { record_id: IDS.record, record_hash: '../../locations' });

    assert.equal(result.isError, true);
    assert.equal(harness.api.requests.length, 0);
  });

  it('passes a "not found" answer on with a hint', async () => {
    harness = await createHarness();
    harness.api.on('GET', /book_record/, refusal(404, 'Not found'));

    const result = await harness.call('get_booking', { record_id: IDS.record, record_hash: RECORD_HASH });

    assert.equal(result.isError, true);
    assert.match(result.text, /^Altegio API error \(HTTP 404\): Not found\nAltegio did not find/);
  });
});
