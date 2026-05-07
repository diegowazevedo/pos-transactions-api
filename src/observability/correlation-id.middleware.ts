import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ulid } from 'ulid';
import { correlationStorage } from './correlation.context';

export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Sets up the per-request AsyncLocalStorage context. Reads the incoming
 * X-Correlation-Id (or generates one) and exposes it on the response so the
 * caller can join their logs to ours.
 */
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId =
      (Array.isArray(incoming) ? incoming[0] : incoming) ?? ulid();

    res.setHeader(CORRELATION_HEADER, correlationId);

    correlationStorage.run({ correlationId }, () => next());
  }
}
