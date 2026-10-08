/** Zod building blocks shared by the tool input schemas, plus small response helpers. */

import { z } from 'zod';

import type { Config } from '../config.js';
import { ToolError } from '../errors.js';

const id = (what: string) => z.number().int().min(1).describe(what);

export const locationId = id(
  'Location (branch) id in Altegio. Required unless the server is bound to one location with ALTEGIO_LOCATION_ID; then it may be omitted and must not name another location.',
).optional();

export const serviceId = id('Service id from list_services.');

export const serviceIds = z
  .array(id('Service id.'))
  .min(1)
  .max(20)
  .describe('Service ids from list_services. Several ids mean services booked together in one visit.');

export const staffId = z
  .number()
  .int()
  .min(0)
  .describe('Team member id from list_staff. 0 means "any team member".');

export const recordId = id('Booking (appointment) id: `record_id` returned by create_booking.');

/** The example in the documentation is 32 hexadecimal characters; anything path-safe is let through. */
export const recordHash = z
  .string()
  .regex(/^[A-Za-z0-9_-]{6,128}$/, 'Must be the record_hash returned by create_booking.')
  .describe('`record_hash` returned by create_booking together with the booking id. It proves the right to view or cancel that booking.');

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

export const date = (what: string) =>
  z
    .string()
    .regex(DATE_PATTERN, 'Must be a date as YYYY-MM-DD, e.g. 2026-10-12.')
    .refine(isRealDate, 'Not a valid calendar date.')
    .describe(`${what} Format YYYY-MM-DD, e.g. 2026-10-12.`);

// Hours 00–23 and minutes 00–59 are spelled out: Date.parse takes "T24:00" and turns 30 February into 2 March.
const DATE_TIME_PREFIX = String.raw`\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?`;
const OFFSET = String.raw`(Z|[+-]\d{2}:\d{2})`;
const FILTER_DATE_TIME_PATTERN = new RegExp(`^${DATE_TIME_PREFIX}${OFFSET}?$`);
const SLOT_DATE_TIME_PATTERN = new RegExp(`^${DATE_TIME_PREFIX}${OFFSET}$`);

/** A moment used only to filter what is offered; the documentation shows it without an offset. */
export const filterDateTime = (what: string) =>
  z
    .string()
    .regex(FILTER_DATE_TIME_PATTERN, 'Must be an ISO 8601 date-time, e.g. 2026-10-12T15:30.')
    .refine((value) => isRealDate(value.slice(0, 10)), 'Not a valid date-time.')
    .describe(`${what} ISO 8601: the \`datetime\` of a slot, or the local time of the location such as 2026-10-12T15:30.`);

/**
 * The moment a booking is made for. An offset is required: without one the same
 * text would mean a different hour depending on who reads it.
 */
export const slotDateTime = z
  .string()
  .regex(
    SLOT_DATE_TIME_PATTERN,
    'Must be an ISO 8601 date-time with a UTC offset, exactly as a slot returns it, e.g. 2026-10-12T15:30:00.000+03:00.',
  )
  .refine((value) => isRealDate(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)), 'Not a valid date-time.')
  .describe(
    'Start of the visit: the `datetime` value of a slot from list_time_slots or get_nearest_time_slots, passed on unchanged (ISO 8601 with a UTC offset).',
  );

type Json = Record<string, unknown>;

export function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Objects of an array; anything else (including the empty array Altegio sends for "no data") gives []. */
export function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/**
 * Most Altegio responses are wrapped as `{ success, data, meta }`; a few (the
 * details of a booking) are documented as the bare object. Returns the payload either way.
 */
export function unwrap(response: unknown): unknown {
  if (isObject(response) && typeof response['success'] === 'boolean' && 'data' in response) {
    return response['data'];
  }
  return response;
}

/**
 * The location a tool call works with. A server started with ALTEGIO_LOCATION_ID
 * is bound to that location: the model cannot point a tool at another one.
 */
export function resolveLocation(args: { location_id?: number | undefined }, config: Config): number {
  if (config.locationId !== undefined) {
    if (args.location_id !== undefined && args.location_id !== config.locationId) {
      throw new ToolError(
        `This server is bound to location ${config.locationId} (ALTEGIO_LOCATION_ID) and does not work with location ${args.location_id}.`,
      );
    }
    return config.locationId;
  }
  if (args.location_id === undefined) {
    throw new ToolError(
      'No location given. Pass location_id, or start the server with ALTEGIO_LOCATION_ID. A booking form id (the number in https://b123.alteg.io) can be turned into a location id with get_booking_form.',
    );
  }
  return args.location_id;
}
