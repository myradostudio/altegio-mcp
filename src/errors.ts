/**
 * Error types and the single place where an error becomes text for the model.
 *
 * Tool handlers never let a stack trace reach the MCP client: `describeError`
 * turns any thrown value into a short, actionable message.
 */

/** One entry of `meta.errors` in an Altegio error response. */
export interface ApiErrorDetail {
  readonly code: number | undefined;
  readonly message: string;
}

/** The API answered with a non-2xx status, or with `success: false`. */
export class AltegioApiError extends Error {
  readonly status: number;
  /** Entries of `meta.errors`: the booking error codes (431–438) arrive here. */
  readonly details: readonly ApiErrorDetail[];

  constructor(status: number, message: string, details: readonly ApiErrorDetail[] = []) {
    super(message);
    this.name = 'AltegioApiError';
    this.status = status;
    this.details = details;
  }
}

/** No usable HTTP response: the request timed out or the network failed. */
export class AltegioTransportError extends Error {
  readonly kind: 'timeout' | 'network';

  constructor(kind: 'timeout' | 'network', message: string) {
    super(message);
    this.name = 'AltegioTransportError';
    this.kind = kind;
  }
}

/**
 * A response arrived but cannot be interpreted: a redirect, or a success status
 * with a body that is not JSON. For a write this leaves the outcome unknown.
 */
export class UnexpectedResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnexpectedResponseError';
  }
}

/** The request was not sent because it would exceed the request rate Altegio documents. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(
      `Not sent: Altegio allows 200 requests per minute and 5 per second from one IP address, and this server has used that up. Try again in ${Math.ceil(retryAfterMs / 1000)} s.`,
    );
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A problem the tool itself detected (bad combination of arguments, unexpected response shape). */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

const STATUS_HINTS: Readonly<Record<number, string>> = {
  401: 'Altegio rejected the partner token. Check ALTEGIO_PARTNER_TOKEN.',
  403: 'Altegio refused the operation for this partner token. For a booking the documentation names a blacklisted client phone (code 434); otherwise check that the location allows this action for online booking.',
  404: 'Altegio did not find the location, team member, service or booking, or the team member does not provide the selected service.',
  429: 'Rate limit reached: Altegio allows 200 requests per minute and 5 per second from one IP address. Wait before retrying.',
};

export function describeError(error: unknown): string {
  if (error instanceof AltegioApiError) {
    const lines = [`Altegio API error (HTTP ${error.status}): ${error.message}`];
    for (const detail of error.details) {
      lines.push(detail.code === undefined ? `  - ${detail.message}` : `  - code ${detail.code}: ${detail.message}`);
    }
    const hint = STATUS_HINTS[error.status];
    if (hint !== undefined) lines.push(hint);
    return lines.join('\n');
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unexpected error.';
}
