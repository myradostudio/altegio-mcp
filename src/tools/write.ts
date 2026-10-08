/**
 * Write tools. They are registered only when ALTEGIO_ALLOW_WRITE=1.
 *
 * Input schemas are strict (unknown keys are rejected) on purpose: a misspelled
 * field must fail loudly instead of being dropped silently and producing a
 * booking that differs from what the client asked for.
 */

import { z } from 'zod';

import type { AltegioClient, RequestOptions } from '../client.js';
import { ENDPOINTS, type Endpoint } from '../endpoints.js';
import { AltegioApiError, describeError, RateLimitError, ToolError } from '../errors.js';
import { appointment } from './read.js';
import {
  isObject,
  locationId,
  objects,
  recordHash,
  recordId,
  resolveLocation,
  serviceIds,
  slotDateTime,
  staffId,
  unwrap,
} from './schemas.js';
import { ADDITIVE_WRITE, defineTool, DESTRUCTIVE_WRITE, type AnyTool } from './types.js';

const BOOKING_NOTICE =
  'A booking takes real time in a team member\'s schedule, and Altegio may notify the client and the business about it. State the service, team member, date, time and the client name and phone to the user and get explicit confirmation before calling.';

/** The documentation gives +13155550175 as the example; the plus sign is optional there. */
const phone = z
  .string()
  .regex(/^\+?\d{9,15}$/, 'Must be a phone number in international format: digits only, optionally with a leading +.')
  .describe('Client phone in international format, digits only, e.g. +380501234567.');

/**
 * True when the failure proves that Altegio did not carry out the operation:
 * the request was never sent, or the API refused it with a client error.
 * 408 and 429 are left out on purpose: they say nothing about what happened.
 */
function isDefiniteRefusal(error: unknown): boolean {
  if (error instanceof RateLimitError || error instanceof ToolError) return true;
  return (
    error instanceof AltegioApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

/**
 * Sends a request that changes something. Unless the failure is a definite
 * refusal, the outcome is unknown (no response, a gateway error, an unreadable
 * response): the error then tells the model how to find out instead of inviting
 * a blind retry that could book the same visit twice.
 */
async function submit(client: AltegioClient, endpoint: Endpoint, options: RequestOptions, recovery: string): Promise<unknown> {
  try {
    return await client.request(endpoint, options);
  } catch (error) {
    if (isDefiniteRefusal(error)) throw error;
    throw new ToolError(
      `${describeError(error)}
It is unknown whether Altegio carried out the operation. Do not simply repeat the call. ${recovery}`,
    );
  }
}

/** Drops keys whose value is undefined so they are not serialised at all. */
function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const writeTools: readonly AnyTool[] = [
  defineTool({
    name: 'create_booking',
    title: 'Create a booking',
    description: `Books one visit for a client at a location: one or several services with one team member at one start time. ${BOOKING_NOTICE} Call check_booking first. Returns record_id and record_hash; keep both, they are the only way to view or cancel the booking with this server. If the location requires phone confirmation (phone_confirmation in get_location or get_booking_form), first call send_phone_confirmation_code and pass the code the client received. Documented refusals: 431 invalid phone, 432 wrong SMS code, 433 the time is taken, 434 the client is blacklisted, 435 no client name, 436 no free team member, 437 overlapping visits.`,
    access: 'write',
    inputSchema: z.strictObject({
      location_id: locationId,
      client_name: z.string().trim().min(1).max(200).describe('Client name as it should appear in the schedule.'),
      client_phone: phone,
      client_email: z.email().optional().describe('Client e-mail.'),
      staff_id: staffId,
      datetime: slotDateTime,
      service_ids: serviceIds,
      comment: z.string().trim().min(1).max(1000).optional().describe('Comment to the booking, visible to the business.'),
      phone_confirmation_code: z
        .string()
        .regex(/^\d{3,10}$/, 'Must be the digits of the SMS code.')
        .optional()
        .describe('SMS code the client received after send_phone_confirmation_code. Needed only at locations with phone confirmation.'),
      sms_reminder_hours: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Send the client an SMS reminder this many hours before the visit. 0 disables it. Omit to send nothing about it to Altegio.'),
      email_reminder_hours: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Send the client an e-mail reminder this many hours before the visit. 0 disables it. Omit to send nothing about it to Altegio.'),
      external_id: z
        .string()
        .regex(/^[\w.:-]{1,64}$/, 'Letters, digits and the characters _ . : - only, at most 64.')
        .optional()
        .describe('Your own id for this booking (api_id in Altegio), returned with the booking later.'),
    }),
    annotations: ADDITIVE_WRITE,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const body = compact({
        phone: args.client_phone,
        fullname: args.client_name,
        email: args.client_email,
        code: args.phone_confirmation_code,
        comment: args.comment,
        notify_by_sms: args.sms_reminder_hours,
        notify_by_email: args.email_reminder_hours,
        api_id: args.external_id,
        appointments: [appointment(args)],
      });
      const response = await submit(
        client,
        ENDPOINTS.createBooking,
        { pathParams: { location_id: location }, body },
        `Call list_time_slots for team member ${args.staff_id} on ${args.datetime.slice(0, 10)}: if the slot ${args.datetime} is no longer offered, the booking was most likely created. Ask the business to check its Altegio schedule before booking again.`,
      );

      const [created] = objects(unwrap(response));
      if (created === undefined || typeof created['record_id'] !== 'number') {
        return {
          note: 'Altegio answered with success but without a booking id. The booking was most likely created; ask the business to check its Altegio schedule. Do not repeat the call.',
          data: unwrap(response),
        };
      }
      return {
        note: `Altegio created booking ${created['record_id']}. Keep record_id and record_hash: they are needed for get_booking and cancel_booking.`,
        data: {
          location_id: location,
          record_id: created['record_id'],
          record_hash: created['record_hash'] ?? null,
          datetime: args.datetime,
        },
      };
    },
  }),

  defineTool({
    name: 'send_phone_confirmation_code',
    title: 'Send an SMS confirmation code',
    description:
      'Makes Altegio send an SMS with a confirmation code to the client phone. It is needed before create_booking only at locations where phone confirmation is switched on (phone_confirmation in get_location or get_booking_form). The message goes to a real person and is sent through the SMS settings of the business, so call it once, only for the phone the client gave for this booking, and then ask the client for the code.',
    access: 'write',
    inputSchema: z.strictObject({
      location_id: locationId,
      client_phone: phone,
    }),
    annotations: ADDITIVE_WRITE,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      await submit(
        client,
        ENDPOINTS.sendPhoneCode,
        { pathParams: { location_id: location }, body: { phone: args.client_phone } },
        'Ask the client whether the SMS arrived before sending another one.',
      );
      return {
        note: 'Altegio accepted the request to send the code. Ask the client for the code and pass it to create_booking as phone_confirmation_code.',
      };
    },
  }),

  defineTool({
    name: 'cancel_booking',
    title: 'Cancel a booking',
    description:
      'Deletes a booking from the schedule by its record_id and record_hash, both returned by create_booking. This frees the time and cannot be undone: to restore the visit a new booking has to be created, if the time is still free. Altegio documents the hash as valid for deleting a booking right after it was made; a location can forbid clients to cancel (allow_delete_record in get_booking), and Altegio then refuses. Confirm with the user before calling.',
    access: 'write',
    inputSchema: z.strictObject({
      record_id: recordId,
      record_hash: recordHash,
    }),
    annotations: DESTRUCTIVE_WRITE,
    handler: async (args, { client }) => {
      const response = await submit(
        client,
        ENDPOINTS.cancelBooking,
        { pathParams: { record_id: args.record_id, record_hash: args.record_hash } },
        'Call get_booking with the same record_id and record_hash: `deleted: true`, or an answer that the booking is not found, means the cancellation went through.',
      );
      const data = unwrap(response);
      return {
        note: `Altegio accepted the cancellation of booking ${args.record_id}.`,
        ...(isObject(data) ? { data } : {}),
      };
    },
  }),
];
