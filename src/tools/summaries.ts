/**
 * Compact projections of Altegio objects.
 *
 * The API returns a lot that a booking conversation never needs (avatars, widget
 * styling, analytics ids, HTML biographies). Tools return these projections to
 * keep the model's context small.
 *
 * Field names come from the response schemas of the OpenAPI documents. Every
 * function tolerates missing fields, so an API change degrades to a sparser
 * result instead of an error.
 */

import { isObject, objects } from './schemas.js';

type Json = Record<string, unknown>;

/** Copies the listed keys that are present, not null and not an empty string. */
function pick(source: unknown, keys: readonly string[]): Json {
  const result: Json = {};
  if (!isObject(source)) return result;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') result[key] = value;
  }
  return result;
}

function pickNested(source: Json, key: string, keys: readonly string[]): Json {
  const nested = pick(source[key], keys);
  return Object.keys(nested).length > 0 ? { [key]: nested } : {};
}

export function summarizeLocation(location: Json): Json {
  return {
    ...pick(location, [
      'id',
      'title',
      'country',
      'city',
      'address',
      'zip',
      'timezone_name',
      'site',
      'coordinate_lat',
      'coordinate_lon',
      'phone_confirmation',
      'active_staff_count',
      'main_group_id',
    ]),
    ...pickNested(location, 'payment_policy', ['type']),
  };
}

export function summarizeBookingForm(form: Json): Json {
  return {
    ...pick(form, ['id', 'url', 'group_id', 'phone_confirmation', 'comment_required', 'sms_enabled', 'lang']),
    // The form reports the location under the name the API used before "location".
    ...(form['company_id'] === undefined ? {} : { location_id: form['company_id'] }),
  };
}

export function summarizeCategory(category: Json): Json {
  return pick(category, ['id', 'title']);
}

export function summarizeService(service: Json): Json {
  return pick(service, [
    'id',
    'title',
    'category_id',
    'price_min',
    'price_max',
    'discount',
    'seance_length',
    'comment',
    'prepaid',
  ]);
}

export function summarizeStaff(member: Json): Json {
  const position = member['position'];
  return {
    ...pick(member, ['id', 'name', 'specialization', 'bookable', 'seance_date', 'schedule_till', 'rating', 'votes_count']),
    // `position` is an object, or an empty array when the team member has none.
    ...(isObject(position) && typeof position['title'] === 'string' && position['title'] !== ''
      ? { position: position['title'] }
      : {}),
  };
}

export function summarizeSlot(slot: Json): Json {
  return pick(slot, ['time', 'datetime', 'seance_length', 'sum_length']);
}

export function summarizeBooking(booking: Json): Json {
  return {
    ...pick(booking, [
      'id',
      'datetime',
      'date',
      'create_date',
      'last_change_date',
      'length',
      'deleted',
      'attendance',
      'comment',
      'online',
      'master_requested',
      'api_id',
      'prepaid',
      'prepaid_confirmed',
    ]),
    services: objects(booking['services']).map((service) =>
      pick(service, ['id', 'title', 'cost', 'price_min', 'price_max', 'discount', 'seance_length', 'amount']),
    ),
    ...pickNested(booking, 'staff', ['id', 'name', 'specialization']),
    // Documented under the old name `company`; it is the location of the booking.
    ...pickNested(booking, 'company', [
      'id',
      'title',
      'city',
      'address',
      'phone',
      'timezone',
      'currency_short_title',
      'allow_delete_record',
      'allow_change_record',
    ]),
  };
}
