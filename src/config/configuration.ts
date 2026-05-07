export interface AppConfig {
  nodeEnv: string;
  port: number;
  db: {
    host: string;
    port: number;
    username: string;
    password: string;
    database: string;
    synchronize: boolean;
    logging: boolean;
  };
  redis: {
    host: string;
    port: number;
  };
  hmac: {
    secret: string;
    timestampToleranceSeconds: number;
  };
  externalApi: {
    url: string;
    timeoutMs: number;
    retry: {
      maxAttempts: number;
      initialDelayMs: number;
      maxDelayMs: number;
    };
    breaker: {
      consecutiveFailures: number;
      halfOpenAfterMs: number;
    };
    bulkhead: {
      maxConcurrent: number;
      maxQueue: number;
    };
  };
}

export default (): AppConfig => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  db: {
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    database: process.env.DB_NAME!,
    synchronize: process.env.DB_SYNCHRONIZE === 'true',
    logging: process.env.DB_LOGGING === 'true',
  },
  redis: {
    host: process.env.REDIS_HOST!,
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
  },
  hmac: {
    secret: process.env.HMAC_SECRET!,
    timestampToleranceSeconds: parseInt(
      process.env.HMAC_TIMESTAMP_TOLERANCE_SECONDS ?? '300',
      10,
    ),
  },
  externalApi: {
    url: process.env.EXTERNAL_API_URL!,
    timeoutMs: parseInt(process.env.EXTERNAL_API_TIMEOUT_MS ?? '3000', 10),
    retry: {
      maxAttempts: parseInt(process.env.EXTERNAL_API_RETRY_MAX_ATTEMPTS ?? '2', 10),
      initialDelayMs: parseInt(
        process.env.EXTERNAL_API_RETRY_INITIAL_DELAY_MS ?? '100',
        10,
      ),
      maxDelayMs: parseInt(
        process.env.EXTERNAL_API_RETRY_MAX_DELAY_MS ?? '1000',
        10,
      ),
    },
    breaker: {
      consecutiveFailures: parseInt(
        process.env.EXTERNAL_API_BREAKER_CONSECUTIVE_FAILURES ?? '5',
        10,
      ),
      halfOpenAfterMs: parseInt(
        process.env.EXTERNAL_API_BREAKER_HALF_OPEN_AFTER_MS ?? '10000',
        10,
      ),
    },
    bulkhead: {
      maxConcurrent: parseInt(
        process.env.EXTERNAL_API_BULKHEAD_MAX_CONCURRENT ?? '20',
        10,
      ),
      maxQueue: parseInt(
        process.env.EXTERNAL_API_BULKHEAD_MAX_QUEUE ?? '50',
        10,
      ),
    },
  },
});
