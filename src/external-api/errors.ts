/**
 * Errors raised by the external API client. The transactions service translates
 * these into domain-appropriate HTTP responses (e.g. 502, 503, 504).
 */

export class ExternalApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'ExternalApiError';
  }
}

/** Network/transport failure or non-2xx response that the caller may want to retry. */
export class ExternalApiTransientError extends ExternalApiError {
  constructor(message: string, statusCode?: number, responseBody?: unknown) {
    super(message, statusCode, responseBody);
    this.name = 'ExternalApiTransientError';
  }
}

/** Non-2xx response classified as a permanent client error (4xx). */
export class ExternalApiClientError extends ExternalApiError {
  constructor(message: string, statusCode: number, responseBody?: unknown) {
    super(message, statusCode, responseBody);
    this.name = 'ExternalApiClientError';
  }
}

/** Operation aborted because the per-request timeout fired. */
export class ExternalApiTimeoutError extends ExternalApiTransientError {
  constructor(timeoutMs: number) {
    super(`External API call exceeded ${timeoutMs}ms`);
    this.name = 'ExternalApiTimeoutError';
  }
}

/** Circuit breaker is open — the upstream is being shielded from traffic. */
export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super('External API circuit is open');
    this.name = 'CircuitOpenError';
  }
}

/** Bulkhead has rejected the call: too many concurrent + queued requests. */
export class BulkheadRejectedError extends Error {
  constructor() {
    super('External API bulkhead is saturated');
    this.name = 'BulkheadRejectedError';
  }
}
