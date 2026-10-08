/**
 * Read-only tools. They are always registered and change nothing in Altegio.
 *
 * All of them send GET requests, with one exception: check_booking sends the
 * POST that Altegio documents for validating booking parameters, which stores
 * nothing ("you can validate them to ensure the appointment can be created").
 *
 * Input schemas are strict: an argument the tool does not know is rejected
 * instead of ignored, so the model never believes it applied a filter that was
 * silently dropped.
 */

import { z } from 'zod';

import { ENDPOINTS } from '../endpoints.js';
import { AltegioApiError, ToolError } from '../errors.js';
import {
  date,
  filterDateTime,
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
import {
  summarizeBooking,
  summarizeBookingForm,
  summarizeCategory,
  summarizeLocation,
  summarizeService,
  summarizeSlot,
  summarizeStaff,
} from './summaries.js';
import { defineTool, READ_ONLY, type AnyTool } from './types.js';

const DEFAULT_SERVICE_LIMIT = 100;
const MAX_SERVICE_LIMIT = 500;

function expectObject(value: unknown, what: string): Record<string, unknown> {
  if (!isObject(value)) throw new ToolError(`Unexpected response from the Altegio API: ${what} was expected.`);
  return value;
}

function sortedDates(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').sort() : [];
}

/** The body Altegio documents for both validating and creating a booking, with one visit in it. */
export function appointment(args: { staff_id: number; datetime: string; service_ids: readonly number[] }) {
  return { id: 1, services: [...args.service_ids], staff_id: args.staff_id, datetime: args.datetime };
}

export const readTools: readonly AnyTool[] = [
  defineTool({
    name: 'get_location',
    title: 'Get a location',
    description:
      'Returns one Altegio location (a branch of a business): name, country, city, address, time zone, website and whether online booking requires confirming the client phone by SMS (phone_confirmation). Call it first to learn the time zone, because all slot times are local to the location.',
    access: 'read',
    inputSchema: z.strictObject({ location_id: locationId }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const data = unwrap(await client.request(ENDPOINTS.location, { pathParams: { location_id: location } }));
      return { data: summarizeLocation(expectObject(data, 'a location')) };
    },
  }),

  defineTool({
    name: 'get_booking_form',
    title: 'Get a booking form',
    description:
      'Returns the settings of an online booking form (widget) by its id (on a server bound to one location, only a form of that location): the location it belongs to (location_id), the chain id for a chain form (group_id, 0 otherwise), whether the client phone must be confirmed by SMS and whether a comment is required. The form id is the number in the widget address, for example 123 in https://b123.alteg.io. Use it to turn a widget link into a location id.',
    access: 'read',
    inputSchema: z.strictObject({
      form_id: z.number().int().min(1).describe('Booking form id: the number in the widget address https://b<id>.alteg.io.'),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const data = unwrap(await client.request(ENDPOINTS.bookingForm, { pathParams: { id: args.form_id } }));
      const form = expectObject(data, 'a booking form');
      // The form is asked for by its own id, so the binding to one location is applied to the answer.
      if (config.locationId !== undefined && form['company_id'] !== config.locationId) {
        throw new ToolError(
          `This server is bound to location ${config.locationId} (ALTEGIO_LOCATION_ID), and booking form ${args.form_id} belongs to another location.`,
        );
      }
      return { data: summarizeBookingForm(form) };
    },
  }),

  defineTool({
    name: 'list_services',
    title: 'List services available for booking',
    description:
      'Lists the services a client can book online at a location, with their categories: id, title, category, price range (price_min to price_max, in the currency of the location), duration in seconds (seance_length) and the online payment status (prepaid). Optional filters: a team member, a moment, and services already chosen for the same visit. `search`, `category_id`, `limit` and `offset` are applied by this server to the list Altegio returned, since the API has no such parameters.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      staff_id: z.number().int().min(1).optional().describe('Only services this team member provides (id from list_staff).'),
      datetime: filterDateTime('Only services that can be booked at this moment.').optional(),
      service_ids: serviceIds
        .optional()
        .describe('Services already chosen for the same visit; Altegio then returns what can be added to them. Makes sense together with staff_id and datetime.'),
      only_catalog: z
        .boolean()
        .optional()
        .describe('true returns the bookable services without checking free time, which is faster; datetime is then not used to check availability.'),
      search: z.string().min(1).max(100).optional().describe('Keep only services whose title contains this text (case-insensitive).'),
      category_id: z.number().int().min(1).optional().describe('Keep only services of this category.'),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(`How many services to return. Default ${DEFAULT_SERVICE_LIMIT}; values above ${MAX_SERVICE_LIMIT} are clamped.`),
      offset: z.number().int().min(0).optional().describe('How many matching services to skip. Default 0.'),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const response = await client.request(ENDPOINTS.services, {
        pathParams: { location_id: location },
        query: {
          staff_id: args.staff_id,
          datetime: args.datetime,
          service_ids: args.service_ids,
          without_seances: args.only_catalog === true ? 1 : undefined,
        },
      });
      const data = expectObject(unwrap(response), 'an object with services');

      const needle = args.search?.toLocaleLowerCase();
      const matching = objects(data['services']).filter(
        (service) =>
          (args.category_id === undefined || service['category_id'] === args.category_id) &&
          (needle === undefined || String(service['title'] ?? '').toLocaleLowerCase().includes(needle)),
      );
      const limit = Math.min(args.limit ?? DEFAULT_SERVICE_LIMIT, MAX_SERVICE_LIMIT);
      const offset = args.offset ?? 0;
      const services = matching.slice(offset, offset + limit).map(summarizeService);

      return {
        data: {
          total: matching.length,
          returned: services.length,
          next_offset: offset + services.length < matching.length ? offset + services.length : null,
          // The response calls the list `category`; the field table of the documentation says `categories`.
          categories: objects(data['category'] ?? data['categories']).map(summarizeCategory),
          services,
        },
      };
    },
  }),

  defineTool({
    name: 'list_staff',
    title: 'List team members available for booking',
    description:
      'Lists the team members (staff, masters) a client can book online at a location: id, name, specialization, position, rating, whether they have free time (bookable) and the nearest day with free time (seance_date). Filter by services to get only those who provide all of them, and by a moment to get only those free at that time.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      service_ids: serviceIds.optional().describe('Only team members who provide these services (ids from list_services).'),
      datetime: filterDateTime('Only team members with free time for the chosen services at this moment.').optional(),
      only_bookable: z
        .boolean()
        .optional()
        .describe('true keeps only team members with bookable = true. Applied by this server to the list Altegio returned.'),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const response = await client.request(ENDPOINTS.staff, {
        pathParams: { location_id: location },
        query: { service_ids: args.service_ids, datetime: args.datetime },
      });
      const data = unwrap(response);
      if (!Array.isArray(data)) {
        throw new ToolError('Unexpected response from the Altegio API: a list of team members was expected.');
      }
      const staff = objects(data)
        .filter((member) => args.only_bookable !== true || member['bookable'] === true)
        .map(summarizeStaff);
      return { data: { returned: staff.length, staff } };
    },
  }),

  defineTool({
    name: 'list_available_dates',
    title: 'List dates available for booking',
    description:
      'Returns the dates on which a location can be booked: booking_dates (days that still have free time) and working_dates (days the team member or location works). Filter by services and by a team member. Pass `month` for one month, or `date_from` together with `date_to` for a range; the documentation does not say which period Altegio uses when neither is given.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      service_ids: serviceIds.optional().describe('Only dates on which these services can be booked.'),
      staff_id: z.number().int().min(1).optional().describe('Only dates on which this team member can be booked.'),
      month: date('Any day of the month to look at.').optional(),
      date_from: date('First day of the period. Requires date_to and replaces `month`.').optional(),
      date_to: date('Last day of the period. Requires date_from.').optional(),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      if ((args.date_from === undefined) !== (args.date_to === undefined)) {
        throw new ToolError('date_from and date_to must be given together.');
      }
      if (args.date_from !== undefined && args.date_to !== undefined && args.date_from > args.date_to) {
        throw new ToolError('date_from must not be later than date_to.');
      }
      const response = await client.request(ENDPOINTS.dates, {
        pathParams: { location_id: location },
        query: {
          service_ids: args.service_ids,
          staff_id: args.staff_id,
          date: args.date_from === undefined ? args.month : undefined,
          date_from: args.date_from,
          date_to: args.date_to,
        },
      });
      const data = expectObject(unwrap(response), 'an object with dates');
      return {
        data: {
          booking_dates: sortedDates(data['booking_dates']),
          working_dates: sortedDates(data['working_dates']),
        },
      };
    },
  }),

  defineTool({
    name: 'list_time_slots',
    title: 'List free time slots on a date',
    description:
      'Lists the free time slots of a team member on one date: local time of the location (time), the exact moment (datetime) and the duration in seconds (seance_length for the first service, sum_length for all chosen services). Pass service_ids to get only the slots long enough for those services. To book a slot, pass its `datetime` unchanged to check_booking and create_booking. staff_id 0 asks for any team member.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      staff_id: staffId,
      date: date('The day to list slots for.'),
      service_ids: serviceIds.optional().describe('Only slots in which these services fit.'),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const response = await client.request(ENDPOINTS.times, {
        pathParams: { location_id: location, team_member_id: args.staff_id, date: args.date },
        query: { service_ids: args.service_ids },
      });
      const data = unwrap(response);
      if (!Array.isArray(data)) {
        throw new ToolError('Unexpected response from the Altegio API: a list of time slots was expected.');
      }
      const slots = objects(data).map(summarizeSlot);
      return { data: { date: args.date, returned: slots.length, slots } };
    },
  }),

  defineTool({
    name: 'get_nearest_time_slots',
    title: 'Nearest free time slots of a team member',
    description:
      'Returns the nearest day on which a team member has free time (seance_date) and the free slots of that day, in the same shape as list_time_slots. Use it when the client asks for "the earliest time" instead of a date. Pass service_ids so that only slots long enough for those services are returned, and `datetime` to search from a later moment.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      staff_id: z.number().int().min(1).describe('Team member id from list_staff.'),
      service_ids: serviceIds.optional().describe('Only slots in which these services fit.'),
      datetime: filterDateTime('Search from this moment on.').optional(),
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const response = await client.request(ENDPOINTS.nearestTimes, {
        pathParams: { location_id: location, team_member_id: args.staff_id },
        query: { service_ids: args.service_ids, datetime: args.datetime },
      });
      const data = unwrap(response);
      // An empty array instead of an object is how Altegio says "no data".
      if (!isObject(data)) return { note: 'Altegio returned no free time for this team member.' };
      const slots = objects(data['seances']).map(summarizeSlot);
      return { data: { seance_date: data['seance_date'] ?? null, returned: slots.length, slots } };
    },
  }),

  defineTool({
    name: 'check_booking',
    title: 'Check that a booking can be made',
    description:
      'Asks Altegio whether a visit with these services, team member and start time can be booked right now, without creating anything. Returns can_be_booked: true, or false with the reasons Altegio gave (documented codes: 433 the time is taken or not working time, 436 no team member is free, 437 overlap with another visit of the same request, 438 the service is not available for booking). Call it before create_booking. A positive answer does not reserve the slot.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      staff_id: staffId,
      datetime: slotDateTime,
      service_ids: serviceIds,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      try {
        await client.request(ENDPOINTS.checkBooking, {
          pathParams: { location_id: location },
          body: { appointments: [appointment(args)] },
        });
      } catch (error) {
        // 422 and 404 are Altegio's way of answering "no": that is a result, not a failure of the tool.
        if (error instanceof AltegioApiError && (error.status === 422 || error.status === 404)) {
          const reasons =
            error.details.length > 0
              ? error.details.map((detail) => ({ code: detail.code ?? null, message: detail.message }))
              : [{ code: null, message: error.message }];
          return {
            // Altegio documents 404 here for two different things, and only one of them is about the slot.
            ...(error.status === 404
              ? { note: 'Altegio answered HTTP 404: either the team member does not provide this service, or the location, team member or service id is wrong. Check the ids before telling the client that the time is unavailable.' }
              : {}),
            data: { can_be_booked: false, reasons },
          };
        }
        throw error;
      }
      return {
        note: 'Altegio accepts these booking parameters. Nothing was created and the slot is not reserved.',
        data: { can_be_booked: true },
      };
    },
  }),

  defineTool({
    name: 'get_booking',
    title: 'Get a booking',
    description:
      'Returns a booking (appointment) by its id and hash, both of which create_booking returns: date and time, duration, services with prices, team member, location with its address and phone, the comment, whether it was deleted (deleted) and whether the location lets clients cancel or move bookings (allow_delete_record, allow_change_record). Only bookings whose hash is known can be read; this server cannot list the bookings of a location.',
    access: 'read',
    inputSchema: z.strictObject({
      location_id: locationId,
      record_id: recordId,
      record_hash: recordHash,
    }),
    annotations: READ_ONLY,
    handler: async (args, { client, config }) => {
      const location = resolveLocation(args, config);
      const response = await client.request(ENDPOINTS.booking, {
        pathParams: { location_id: location, record_id: args.record_id, record_hash: args.record_hash },
      });
      return { data: summarizeBooking(expectObject(unwrap(response), 'a booking')) };
    },
  }),
];
