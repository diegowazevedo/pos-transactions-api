/**
 * E2E env defaults. Postgres and Redis are expected to be reachable on
 * localhost (start them with: `docker compose -f docker/docker-compose.yml up -d postgres redis`).
 */
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.PORT ?? '0';

process.env.DB_HOST = process.env.DB_HOST ?? 'localhost';
process.env.DB_PORT = process.env.DB_PORT ?? '5432';
process.env.DB_USER = process.env.DB_USER ?? 'pos';
process.env.DB_PASSWORD = process.env.DB_PASSWORD ?? 'pos';
process.env.DB_NAME = process.env.DB_NAME ?? 'pos';
process.env.DB_SYNCHRONIZE = process.env.DB_SYNCHRONIZE ?? 'true';

process.env.REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT ?? '6379';

process.env.HMAC_SECRET =
  process.env.HMAC_SECRET ?? 'e2e-test-secret-please-replace-1234567890';

process.env.EXTERNAL_API_URL =
  process.env.EXTERNAL_API_URL ?? 'http://upstream.invalid';

// Disable OTel SDK in tests — we don't want background exporters complaining
// about missing collectors.
process.env.OTEL_SDK_DISABLED = 'true';
