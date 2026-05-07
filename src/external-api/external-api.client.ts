import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getCorrelationId } from '../observability/correlation.context';
import {
  ExternalApiClientError,
  ExternalApiError,
  ExternalApiTransientError,
} from './errors';
import {
  ExternalAuthorizeRequest,
  ExternalAuthorizeResponse,
  ExternalConfirmRequest,
  ExternalVoidRequest,
} from './external-api.types';
import {
  ResilienceConfig,
  ResiliencePolicy,
  buildResiliencePolicy,
} from './resilience.policy';

export const FETCH_FN = Symbol('FETCH_FN');
export type FetchFn = typeof fetch;

@Injectable()
export class ExternalApiClient implements OnModuleInit {
  private readonly logger = new Logger(ExternalApiClient.name);
  private readonly baseUrl: string;
  private readonly resilience: ResiliencePolicy;

  constructor(
    private readonly config: ConfigService,
    @Inject(FETCH_FN) private readonly fetchImpl: FetchFn,
  ) {
    this.baseUrl = this.config
      .getOrThrow<string>('externalApi.url')
      .replace(/\/$/, '');

    const cfg: ResilienceConfig = {
      timeoutMs: this.config.getOrThrow<number>('externalApi.timeoutMs'),
      retry: this.config.getOrThrow('externalApi.retry'),
      breaker: this.config.getOrThrow('externalApi.breaker'),
      bulkhead: this.config.getOrThrow('externalApi.bulkhead'),
    };
    this.resilience = buildResiliencePolicy(cfg, this.logger);
  }

  onModuleInit(): void {
    this.logger.log(
      `External API client ready (baseUrl=${this.baseUrl}, breaker open after ${
        this.config.get('externalApi.breaker.consecutiveFailures') as number
      } failures)`,
    );
  }

  isCircuitOpen(): boolean {
    return this.resilience.isCircuitOpen();
  }

  authorize(
    req: ExternalAuthorizeRequest,
  ): Promise<ExternalAuthorizeResponse> {
    return this.send<ExternalAuthorizeResponse>(
      'POST',
      '/transactions/authorize',
      req,
      req.idempotencyKey,
    );
  }

  confirm(req: ExternalConfirmRequest): Promise<void> {
    return this.send<void>(
      'POST',
      `/transactions/${encodeURIComponent(req.externalTransactionId)}/confirm`,
      req,
      req.idempotencyKey,
    );
  }

  void(req: ExternalVoidRequest): Promise<void> {
    return this.send<void>(
      'POST',
      `/transactions/${encodeURIComponent(req.externalTransactionId)}/void`,
      req,
      req.idempotencyKey,
    );
  }

  private async send<T>(
    method: 'POST',
    path: string,
    body: unknown,
    idempotencyKey: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    try {
      return await this.resilience.policy.execute(({ signal }) =>
        this.doRequest<T>(url, method, body, idempotencyKey, signal),
      );
    } catch (err) {
      throw this.resilience.remap(err);
    }
  }

  private async doRequest<T>(
    url: string,
    method: string,
    body: unknown,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      'idempotency-key': idempotencyKey,
    };
    const correlationId = getCorrelationId();
    if (correlationId) headers['x-correlation-id'] = correlationId;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        signal,
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-layer failure (DNS, ECONNREFUSED, socket reset, abort)
      // — treat as transient so retry/breaker can act on it.
      if (err instanceof Error) {
        throw new ExternalApiTransientError(`Network failure: ${err.message}`);
      }
      throw new ExternalApiTransientError('Unknown network failure');
    }

    if (response.ok) {
      return this.parseBody<T>(response);
    }

    const errorBody = await this.safeParseBody(response);
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      throw new ExternalApiTransientError(
        `External API responded ${response.status}`,
        response.status,
        errorBody,
      );
    }
    throw new ExternalApiClientError(
      `External API rejected request: ${response.status}`,
      response.status,
      errorBody,
    );
  }

  private async parseBody<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as unknown as T;
    const text = await response.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ExternalApiError(
        `Invalid JSON response from external API: ${(err as Error).message}`,
      );
    }
  }

  private async safeParseBody(response: Response): Promise<unknown> {
    try {
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch {
      return null;
    }
  }
}
