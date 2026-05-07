import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule, Params } from 'nestjs-pino';
import { trace } from '@opentelemetry/api';
import { CORRELATION_HEADER } from './correlation-id.middleware';
import { getRequestContext } from './correlation.context';

function buildPinoOptions(config: ConfigService): Params {
  const isProd = config.get<string>('nodeEnv') === 'production';

  return {
    pinoHttp: {
      level: isProd ? 'info' : 'debug',
      // Pull the correlation id from the per-request ALS context, falling back
      // to whatever the middleware put on the response. Each log line also gets
      // the active OTel trace/span ids so backends can pivot between logs and traces.
      mixin() {
        const ctx = getRequestContext();
        const span = trace.getActiveSpan();
        const spanCtx = span?.spanContext();
        return {
          correlationId: ctx?.correlationId,
          terminalId: ctx?.terminalId,
          transactionId: ctx?.transactionId,
          nsu: ctx?.nsu,
          traceId: spanCtx?.traceId,
          spanId: spanCtx?.spanId,
        };
      },
      customProps: (req) => ({
        correlationId: req.headers[CORRELATION_HEADER],
      }),
      // Reduce noisiness of common health-check polls.
      autoLogging: {
        ignore: (req) => req.url === '/health',
      },
      redact: {
        paths: [
          'req.headers["x-signature"]',
          'req.headers.authorization',
          'req.headers.cookie',
        ],
        censor: '[REDACTED]',
      },
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
    },
  };
}

@Module({
  imports: [
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: buildPinoOptions,
    }),
  ],
})
export class AppLoggerModule {}
