/**
 * Environment-based configuration.
 *
 * Everything is validated once at startup. Problems are collected and reported
 * together so a user fixing their MCP client config does not have to restart
 * the server once per mistake.
 */

export const DEFAULT_API_URL = 'https://api.alteg.io';
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface Config {
  /** API origin without a trailing slash, e.g. `https://api.alteg.io`. */
  readonly apiUrl: string;
  /** Partner token from the Altegio developer account (`Authorization: Bearer …`). */
  readonly partnerToken: string;
  /** When set, every tool that takes a location works with this one only. */
  readonly locationId: number | undefined;
  /** When false (the default) no write tool is registered at all. */
  readonly allowWrite: boolean;
  readonly timeoutMs: number;
  /** Non-fatal remarks to print on stderr at startup. Never contain secrets. */
  readonly notices: readonly string[];
}

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Reads a variable, treating blank values (common in config templates) as unset. */
function read(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function parseApiUrl(raw: string | undefined, problems: string[]): string {
  if (raw === undefined) return DEFAULT_API_URL;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    problems.push(`ALTEGIO_API_URL is not a valid URL (expected something like ${DEFAULT_API_URL}).`);
    return DEFAULT_API_URL;
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    problems.push('ALTEGIO_API_URL must use https:// (plain http:// is accepted only for localhost).');
  }
  if (url.username !== '' || url.password !== '') {
    problems.push('ALTEGIO_API_URL must not contain credentials.');
  }
  if (url.pathname.replace(/\/+$/, '') !== '' || url.search !== '' || url.hash !== '') {
    problems.push(
      `ALTEGIO_API_URL must be the API origin only, without a path or query (for example ${DEFAULT_API_URL}).`,
    );
  }
  return url.origin;
}

function parseAllowWrite(raw: string | undefined, problems: string[]): boolean {
  const value = (raw ?? '').toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  // Fail closed and loudly: a typo must never silently enable or disable bookings.
  problems.push('ALTEGIO_ALLOW_WRITE must be 1 (enable write tools) or 0 (read-only, the default).');
  return false;
}

/**
 * The token goes into `Authorization: Bearer <token>`. Altegio writes a user token
 * into the same header after a comma (`Bearer <partner>, User <user>`), so a comma
 * or a space inside the value would silently change who the request acts as.
 */
function parsePartnerToken(raw: string | undefined, problems: string[], notices: string[]): string {
  if (raw === undefined) {
    problems.push(
      'ALTEGIO_PARTNER_TOKEN is not set. The partner token is shown in the Altegio developer account under Account settings → Account details.',
    );
    return '';
  }
  let token = raw;
  if (/^bearer\s+/i.test(token)) {
    token = token.replace(/^bearer\s+/i, '');
    notices.push('ALTEGIO_PARTNER_TOKEN started with "Bearer "; the prefix was dropped, the server adds it itself.');
  }
  if (/[\s,]/.test(token)) {
    problems.push(
      'ALTEGIO_PARTNER_TOKEN must be the partner token alone, without spaces or commas. A user token ("…, User …") is not supported by this server.',
    );
  } else if (!/^[\x21-\x7e]+$/.test(token)) {
    // A header value cannot carry anything else: every request would fail inside fetch before it is sent.
    problems.push(
      'ALTEGIO_PARTNER_TOKEN contains a character that is not a plain Latin letter, digit or sign (a curly quote or an invisible space, often picked up when copying from a document). Copy the token again.',
    );
  }
  return token;
}

function parseLocationId(raw: string | undefined, problems: string[]): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d{0,14}$/.test(raw)) {
    problems.push('ALTEGIO_LOCATION_ID must be the numeric id of a location, for example 4564.');
    return undefined;
  }
  return Number(raw);
}

/**
 * Builds the configuration from environment variables.
 * @throws {ConfigError} listing every problem found.
 */
export function loadConfig(env: Env): Config {
  const problems: string[] = [];
  const notices: string[] = [];

  const partnerToken = parsePartnerToken(read(env, 'ALTEGIO_PARTNER_TOKEN'), problems, notices);
  const locationId = parseLocationId(read(env, 'ALTEGIO_LOCATION_ID'), problems);
  const apiUrl = parseApiUrl(read(env, 'ALTEGIO_API_URL'), problems);
  const allowWrite = parseAllowWrite(read(env, 'ALTEGIO_ALLOW_WRITE'), problems);

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  if (allowWrite && locationId === undefined) {
    notices.push(
      'Write tools are enabled and ALTEGIO_LOCATION_ID is not set: bookings can be created at any location the partner token can reach.',
    );
  }

  return { apiUrl, partnerToken, locationId, allowWrite, timeoutMs: DEFAULT_TIMEOUT_MS, notices };
}
