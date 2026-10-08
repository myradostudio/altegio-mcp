/**
 * Minimal HTTP client for the Altegio API.
 *
 * Responsibilities:
 *  - send the partner token and the versioned `Accept` header Altegio asks for;
 *  - stay within the documented request rate (200 per minute, 5 per second);
 *  - apply a timeout to every request and never follow redirects;
 *  - never repeat a request on its own: a repeated booking would be a second booking;
 *  - turn failures into typed errors whose messages never contain the token.
 *
 * Nothing is logged here: request and response bodies contain client names and
 * phone numbers and must not end up in a log file.
 */

import type { Config } from './config.js';
import { API_BASE_PATH, type Endpoint } from './endpoints.js';
import {
  AltegioApiError,
  AltegioTransportError,
  RateLimitError,
  UnexpectedResponseError,
  type ApiErrorDetail,
} from './errors.js';
import { RateLimiter, type RateWindow } from './rate-limit.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type QueryValue = string | number | readonly number[] | undefined;

export interface RequestOptions {
  readonly pathParams?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, QueryValue>>;
  /** JSON request body. Omitted entirely when undefined. */
  readonly body?: unknown;
}

export interface AltegioClientOptions {
  readonly config: Config;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Injectable clock for tests; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable delay for tests; defaults to a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** "200 requests per minute per IP address, 5 requests per second per IP address" (developer.alteg.io). */
export const RATE_WINDOWS: readonly RateWindow[] = [
  { limit: 5, perMs: 1_000 },
  { limit: 200, perMs: 60_000 },
];
/** A short burst is smoothed out by waiting; a longer wait is reported instead, so a tool call never hangs. */
const MAX_RATE_WAIT_MS = 2_000;
const MAX_ERROR_BODY_CHARS = 500;
const REDACTED = '[redacted]';
/** The media type the Altegio documentation shows in every example. */
const ACCEPT = 'application/vnd.api.v2+json';

export class AltegioClient {
  private readonly config: Config;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: RateLimiter;

  constructor(options: AltegioClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.limiter = new RateLimiter(RATE_WINDOWS, options.now ?? Date.now);
  }

  /**
   * Calls an API operation and returns the parsed JSON body, or null for an empty one.
   * A body that carries `success: false` is turned into an error even on HTTP 2xx.
   */
  async request<T = unknown>(endpoint: Endpoint, options: RequestOptions = {}): Promise<T> {
    const url = buildUrl(this.config.apiUrl, endpoint, options);

    const slot = this.limiter.reserve(MAX_RATE_WAIT_MS);
    if (!slot.granted) throw new RateLimitError(slot.waitMs);
    if (slot.waitMs > 0) await this.sleep(slot.waitMs);

    const headers: Record<string, string> = {
      Accept: ACCEPT,
      // Declared as required for every operation, including the ones without a body.
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.partnerToken}`,
      'User-Agent': `${SERVER_NAME}/${SERVER_VERSION}`,
    };
    const init: RequestInit = {
      method: endpoint.method,
      headers,
      signal: AbortSignal.timeout(this.config.timeoutMs),
      // A redirect would forward the partner token to another host, and a redirected
      // POST is repeated as a GET without its body. Neither may happen silently.
      redirect: 'manual',
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (error) {
      throw this.toTransportError(endpoint, error);
    }
    return this.parse<T>(endpoint, response);
  }

  private async parse<T>(endpoint: Endpoint, response: Response): Promise<T> {
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The headers arrived but the body did not: the timeout or the connection cut it off.
      throw this.toTransportError(endpoint, error);
    }

    const operation = `${endpoint.method} ${endpoint.path}`;
    if (response.status >= 300 && response.status < 400) {
      throw new UnexpectedResponseError(
        `${operation} was answered with a redirect (HTTP ${response.status}), which the server does not follow. Check that ALTEGIO_API_URL is the API origin itself.`,
      );
    }
    if (!response.ok) {
      throw this.toApiError(response.status, response.statusText, text);
    }
    if (text.trim() === '') {
      return null as T;
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new UnexpectedResponseError(
        `${operation} was answered with HTTP ${response.status} and a body that is not valid JSON.`,
      );
    }
    if (isObject(body) && body['success'] === false) {
      throw this.toApiError(response.status, response.statusText, text);
    }
    return body as T;
  }

  private toTransportError(endpoint: Endpoint, error: unknown): AltegioTransportError {
    const operation = `${endpoint.method} ${endpoint.path}`;
    if (isTimeout(error)) {
      return new AltegioTransportError('timeout', `${operation} timed out after ${this.config.timeoutMs / 1000} s.`);
    }
    return new AltegioTransportError(
      'network',
      this.scrub(`${operation} failed: no usable response from ${this.config.apiUrl} (${networkCause(error)}).`),
    );
  }

  /** Altegio error bodies look like `{ success: false, data: null, meta: { message, errors: [{ code, message }] } }`. */
  private toApiError(status: number, statusText: string, text: string): AltegioApiError {
    // Scrub before truncating: a secret cut in half by the limit would no longer be recognised.
    let message = this.scrub(text.trim()).slice(0, MAX_ERROR_BODY_CHARS) || statusText || 'Empty error response.';
    let details: ApiErrorDetail[] = [];

    try {
      const parsed: unknown = JSON.parse(text);
      const meta = isObject(parsed) ? parsed['meta'] : undefined;
      if (isObject(meta)) {
        details = errorDetails(meta['errors']).map((detail) => ({ ...detail, message: this.scrub(detail.message) }));
        const apiMessage = meta['message'];
        if (typeof apiMessage === 'string' && apiMessage !== '') {
          message = this.scrub(apiMessage).slice(0, MAX_ERROR_BODY_CHARS);
        } else if (details.length > 0) {
          message = 'The request was refused.';
        }
      }
    } catch {
      // Not JSON (for example an HTML error page from a proxy): keep the truncated text.
    }

    return new AltegioApiError(status, message, details);
  }

  /** Defence in depth: removes the partner token from any text that leaves the client. */
  private scrub(text: string): string {
    const { partnerToken } = this.config;
    return partnerToken.length >= 4 ? text.split(partnerToken).join(REDACTED) : text;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorDetails(errors: unknown): ApiErrorDetail[] {
  if (!Array.isArray(errors)) return [];
  const details: ApiErrorDetail[] = [];
  for (const item of errors) {
    if (!isObject(item) || typeof item['message'] !== 'string') continue;
    const code = item['code'];
    details.push({
      code: typeof code === 'number' ? code : undefined,
      message: item['message'].slice(0, MAX_ERROR_BODY_CHARS),
    });
  }
  return details;
}

function buildUrl(apiUrl: string, endpoint: Endpoint, options: RequestOptions): string {
  const path = endpoint.path.replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = options.pathParams?.[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing path parameter "${name}" for ${endpoint.path}.`);
    }
    // encodeURIComponent leaves dots alone, and URL parsing would resolve "." and ".."
    // as path segments, redirecting the request to a different endpoint.
    if (value === '.' || value === '..') {
      throw new Error(`Invalid value for path parameter "${name}".`);
    }
    return encodeURIComponent(String(value));
  });

  const url = new URL(apiUrl + API_BASE_PATH + path);
  for (const [name, value] of Object.entries(options.query ?? {})) {
    if (value === undefined) continue;
    if (typeof value === 'object') {
      // Lists of ids are sent the way PHP reads arrays: ?service_ids[]=1&service_ids[]=2
      for (const item of value) url.searchParams.append(`${name}[]`, String(item));
    } else {
      url.searchParams.append(name, String(value));
    }
  }
  return url.toString();
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

function networkCause(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  if (typeof cause?.code === 'string') return cause.code;
  if (typeof cause?.message === 'string') return cause.message;
  return error.message;
}
