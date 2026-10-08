/**
 * Catalogue of the Altegio API operations this server calls.
 *
 * Paths and the security scheme are taken from the OpenAPI documents published
 * on https://developer.alteg.io: "Online Booking" for everything a booking widget
 * does, and "Business Management v1" for the one location lookup. Every operation
 * here is documented as needing the partner token only (`BearerPartner`), never a
 * user token. tests/spec.test.ts compares each entry with a snapshot of those
 * documents, so an endpoint cannot be added or changed here without the spec agreeing.
 */

/** Both documents declare the server `https://api.alteg.io/api/v1`; paths below are relative to it. */
export const API_BASE_PATH = '/api/v1';

export type SpecDocument = 'online-booking' | 'business-v1';

export interface Endpoint {
  readonly method: 'GET' | 'POST' | 'DELETE';
  /** Path template; `{name}` segments are filled from path parameters. */
  readonly path: string;
  /** The OpenAPI document that describes the operation. */
  readonly document: SpecDocument;
}

function endpoint(method: Endpoint['method'], path: string, document: SpecDocument = 'online-booking'): Endpoint {
  return { method, path, document };
}

export const ENDPOINTS = {
  // Location and booking form
  location: endpoint('GET', '/locations/{location_id}', 'business-v1'),
  bookingForm: endpoint('GET', '/bookform/{id}'),

  // What can be booked, with whom and when
  services: endpoint('GET', '/book_services/{location_id}'),
  staff: endpoint('GET', '/book_staff/{location_id}'),
  dates: endpoint('GET', '/book_dates/{location_id}'),
  times: endpoint('GET', '/book_times/{location_id}/{team_member_id}/{date}'),
  nearestTimes: endpoint('GET', '/book_staff_seances/{location_id}/{team_member_id}'),

  // Bookings
  checkBooking: endpoint('POST', '/book_check/{location_id}'),
  booking: endpoint('GET', '/book_record/{location_id}/{record_id}/{record_hash}'),
  createBooking: endpoint('POST', '/book_record/{location_id}'),
  sendPhoneCode: endpoint('POST', '/book_code/{location_id}'),
  cancelBooking: endpoint('DELETE', '/user/records/{record_id}/{record_hash}'),
} as const satisfies Record<string, Endpoint>;

export type EndpointName = keyof typeof ENDPOINTS;
