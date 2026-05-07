import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import {
  BulkheadRejectedError,
  CircuitOpenError,
  ExternalApiClientError,
  ExternalApiTimeoutError,
  ExternalApiTransientError,
} from '../../external-api/errors';
import { LockBusyError } from '../../idempotency/idempotency.service';
import {
  InvalidStateTransitionError,
  TransactionNotFoundError,
} from '../../transactions/transactions.errors';

interface ErrorBody {
  status: number;
  error: string;
  message: string;
  details?: unknown;
}

/**
 * Maps domain and external-API errors to HTTP responses with consistent
 * shape. Anything not mapped here falls through to Nest's default handler.
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();

    const mapped = this.map(exception);
    if (!mapped) {
      // Let Nest's default filter handle HttpException + unknowns.
      if (exception instanceof HttpException) {
        const status = exception.getStatus();
        res.status(status).json(this.fromHttpException(exception));
        return;
      }
      this.logger.error('Unhandled exception', exception as Error);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'InternalServerError',
        message: 'Unexpected error',
      });
      return;
    }

    if (mapped.retryAfterSeconds) {
      res.setHeader('Retry-After', String(mapped.retryAfterSeconds));
    }
    res.status(mapped.body.status).json(mapped.body);
  }

  private map(
    err: unknown,
  ): { body: ErrorBody; retryAfterSeconds?: number } | null {
    if (err instanceof TransactionNotFoundError) {
      return {
        body: {
          status: HttpStatus.NOT_FOUND,
          error: 'TransactionNotFound',
          message: err.message,
        },
      };
    }
    if (err instanceof InvalidStateTransitionError) {
      return {
        body: {
          status: HttpStatus.CONFLICT,
          error: 'InvalidStateTransition',
          message: err.message,
          details: {
            transactionId: err.transactionId,
            from: err.from,
            to: err.to,
          },
        },
      };
    }
    if (err instanceof LockBusyError) {
      return {
        body: {
          status: HttpStatus.CONFLICT,
          error: 'OperationInProgress',
          message: err.message,
        },
      };
    }
    if (err instanceof CircuitOpenError) {
      return {
        body: {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'UpstreamCircuitOpen',
          message: 'External API is currently unavailable; circuit breaker is open',
        },
        retryAfterSeconds: Math.ceil(err.retryAfterMs / 1000),
      };
    }
    if (err instanceof BulkheadRejectedError) {
      return {
        body: {
          status: HttpStatus.SERVICE_UNAVAILABLE,
          error: 'UpstreamBulkheadSaturated',
          message: 'Too many concurrent requests to the external API',
        },
        retryAfterSeconds: 1,
      };
    }
    if (err instanceof ExternalApiTimeoutError) {
      return {
        body: {
          status: HttpStatus.GATEWAY_TIMEOUT,
          error: 'UpstreamTimeout',
          message: err.message,
        },
      };
    }
    if (err instanceof ExternalApiClientError) {
      return {
        body: {
          status: HttpStatus.BAD_GATEWAY,
          error: 'UpstreamRejected',
          message: err.message,
          details: err.responseBody,
        },
      };
    }
    if (err instanceof ExternalApiTransientError) {
      return {
        body: {
          status: HttpStatus.BAD_GATEWAY,
          error: 'UpstreamUnavailable',
          message: err.message,
        },
      };
    }
    return null;
  }

  private fromHttpException(exception: HttpException): ErrorBody {
    const status = exception.getStatus();
    const response = exception.getResponse();
    if (typeof response === 'string') {
      return { status, error: exception.name, message: response };
    }
    const obj = response as Record<string, unknown>;
    return {
      status,
      error: (obj.error as string) ?? exception.name,
      message:
        (obj.message as string) ??
        (Array.isArray(obj.message) ? (obj.message as string[]).join('; ') : exception.message),
      details: obj.errors ?? obj.details,
    };
  }
}
