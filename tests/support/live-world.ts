/**
 * A stand-in for the Altegio API that keeps one small location consistent
 * enough for the live check to pass: two team members, two services, five weeks
 * of free days with three slots each, and the bookings made during the run.
 * Unlike the canned answers of the other tests it applies the filters it is
 * sent, because that is what the live check verifies.
 *
 * The days are counted from today, since the live check looks for a day after
 * today. Everything else is made up, as in fixtures.ts.
 */

import { FakeApi, json, ok, refusal } from './fake-api.js';
import * as fixtures from './fixtures.js';
import { IDS, RECORD_HASH } from './fixtures.js';

/** The code the stand-in "sends" by SMS at a location that confirms phones. */
export const SMS_CODE = '904172';

const BASE = '/api/v1';
const TIMES = ['10:00', '15:30', '18:30'];
const dayFromToday = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

/** The days with free time: tomorrow and the five weeks after it. */
export const DAYS: readonly string[] = Array.from({ length: 35 }, (_item, index) => dayFromToday(index + 1));

/** A second haircut in the category of the first, so that a search by text and category has two answers to page through. */
const MENS_HAIRCUT = 1896209;
const SERVICES = [
  ...fixtures.services.services,
  { ...fixtures.services.services[0], id: MENS_HAIRCUT, title: 'Стрижка чоловіча' },
];

/** Which services each team member provides. */
const PROVIDES: Readonly<Record<number, readonly number[]>> = {
  [IDS.staff]: [IDS.haircut, IDS.coloring, MENS_HAIRCUT],
  [IDS.otherStaff]: [IDS.coloring],
};

export interface Booking {
  readonly id: number;
  readonly hash: string;
  /** The body of the request that created it. */
  readonly body: Record<string, any>;
  deleted: boolean;
}

export interface World {
  readonly api: FakeApi;
  readonly bookings: Booking[];
  /** The phones a confirmation code was asked for. */
  readonly codesSentTo: string[];
}

export function liveWorld(options: { phoneConfirmation?: boolean } = {}): World {
  const api = new FakeApi();
  const bookings: Booking[] = [];
  const codesSentTo: string[] = [];

  const at = (path: string) => `${BASE}${path}`;
  const created = () => json({ success: true, meta: { message: 'Created' } }, 201);
  const taken = (datetime: string) => bookings.some((booking) => !booking.deleted && booking.body['appointments'][0].datetime === datetime);
  const slotsOf = (date: string) =>
    DAYS.includes(date)
      ? TIMES.map((time) => ({ time, seance_length: 3600, sum_length: 3600, datetime: `${date}T${time}:00.000+03:00` })).filter(
          (slot) => !taken(slot.datetime),
        )
      : [];
  const isFree = (datetime: string) => slotsOf(datetime.slice(0, 10)).some((slot) => slot.datetime.slice(0, 16) === datetime.slice(0, 16));
  const bookingAt = (pathname: string) => {
    const [id, hash] = pathname.split('/').slice(-2);
    return bookings.find((booking) => String(booking.id) === id && booking.hash === hash);
  };

  api.on('GET', at(`/locations/${IDS.location}`), () => ok({ ...fixtures.location, phone_confirmation: options.phoneConfirmation === true }));
  api.on('GET', at(`/bookform/${IDS.form}`), ok(fixtures.bookingForm));

  api.on('GET', at(`/book_staff/${IDS.location}`), ({ url }) => {
    const wanted = url.searchParams.getAll('service_ids[]').map(Number);
    const moment = url.searchParams.get('datetime');
    return ok(
      fixtures.staff.filter(
        (member) => wanted.every((id) => PROVIDES[member.id]?.includes(id) === true) && (moment === null || (member.bookable && isFree(moment))),
      ),
    );
  });

  api.on('GET', at(`/book_services/${IDS.location}`), ({ url }) => {
    const staffId = url.searchParams.get('staff_id');
    const provided = staffId === null ? undefined : (PROVIDES[Number(staffId)] ?? []);
    return ok({ ...fixtures.services, services: SERVICES.filter((service) => provided === undefined || (service.id !== undefined && provided.includes(service.id))) });
  });

  api.on('GET', at(`/book_dates/${IDS.location}`), ({ url }) => {
    const staffId = url.searchParams.get('staff_id');
    const month = url.searchParams.get('date');
    const from = url.searchParams.get('date_from');
    const to = url.searchParams.get('date_to');
    const days = DAYS.filter(
      (day) =>
        (staffId === null || Number(staffId) === IDS.staff) &&
        (month === null || day.startsWith(month.slice(0, 7))) &&
        (from === null || to === null || (day >= from && day <= to)),
    );
    // Latest first: nobody promised an order, and the tool sorts.
    const dates = [...days].reverse();
    return ok({ booking_days: {}, booking_dates: dates, working_days: {}, working_dates: dates });
  });

  api.on('GET', new RegExp(`^${BASE}/book_times/${IDS.location}/\\d+/[\\d-]+$`), ({ url }) => {
    const [staffId = '', date = ''] = url.pathname.split('/').slice(-2);
    return ok([0, IDS.staff].includes(Number(staffId)) ? slotsOf(date) : []);
  });

  api.on('GET', at(`/book_staff_seances/${IDS.location}/${IDS.staff}`), ({ url }) => {
    const from = (url.searchParams.get('datetime') ?? '').slice(0, 10);
    const date = DAYS.find((day) => day >= from && slotsOf(day).length > 0);
    return ok(date === undefined ? [] : { seance_date: date, seances: slotsOf(date) });
  });

  api.on('POST', at(`/book_check/${IDS.location}`), ({ body }) =>
    isFree((body as Record<string, any>)['appointments'][0].datetime) ? created() : refusal(422, 'An error has occurred', [fixtures.slotTaken]),
  );

  api.on('GET', new RegExp(`^${BASE}/book_record/${IDS.location}/\\d+/\\w+$`), ({ url }) => {
    const booking = bookingAt(url.pathname);
    if (booking === undefined) return refusal(404, 'Not found');
    const visit = booking.body['appointments'][0];
    // Documented as the bare object, without the envelope.
    return json({
      ...fixtures.booking,
      id: booking.id,
      datetime: visit.datetime,
      deleted: booking.deleted,
      api_id: booking.body['api_id'],
      comment: booking.body['comment'],
      services: fixtures.booking.services.map((service) => ({ ...service, id: visit.services[0] })),
      staff: { ...fixtures.booking.staff, id: visit.staff_id },
    });
  });

  api.on('POST', at(`/book_record/${IDS.location}`), ({ body }) => {
    const request = body as Record<string, any>;
    if (options.phoneConfirmation === true && request['code'] !== SMS_CODE) {
      // The refusal repeats what was sent, as error texts of an API sometimes do.
      return refusal(422, 'An error has occurred', [{ code: 432, message: `The SMS code ${request['code']} is wrong` }]);
    }
    if (!isFree(request['appointments'][0].datetime)) return refusal(422, 'An error has occurred', [fixtures.slotTaken]);
    const booking: Booking = { id: IDS.record + bookings.length, hash: RECORD_HASH, body: request, deleted: false };
    bookings.push(booking);
    return ok([{ id: 1, record_id: booking.id, record_hash: booking.hash }], 201);
  });

  api.on('POST', at(`/book_code/${IDS.location}`), ({ body }) => {
    codesSentTo.push((body as Record<string, any>)['phone']);
    return created();
  });

  api.on('DELETE', new RegExp(`^${BASE}/user/records/\\d+/\\w+$`), ({ url }) => {
    const booking = bookingAt(url.pathname);
    if (booking === undefined) return refusal(404, 'Not found');
    booking.deleted = true;
    return new Response(null, { status: 200 });
  });

  return { api, bookings, codesSentTo };
}
