import { z } from 'zod';

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return value.toLowerCase() === 'true';
  });

const intFromString = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    const parsed = typeof value === 'number' ? value : parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'must be an integer',
      });
      return z.NEVER;
    }
    return parsed;
  });

const port = intFromString.pipe(z.number().int().min(1).max(65535));

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: port.default(3000),

  DB_HOST: z.string().min(1),
  DB_PORT: port.default(5432),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().min(1),
  DB_NAME: z.string().min(1),
  DB_SYNCHRONIZE: booleanFromString.default(false),
  DB_LOGGING: booleanFromString.default(false),

  REDIS_HOST: z.string().min(1),
  REDIS_PORT: port.default(6379),

  HMAC_SECRET: z.string().min(16),
  HMAC_TIMESTAMP_TOLERANCE_SECONDS: intFromString
    .pipe(z.number().int().min(30))
    .default(300),

  EXTERNAL_API_URL: z.string().url(),
  EXTERNAL_API_TIMEOUT_MS: intFromString
    .pipe(z.number().int().min(100))
    .default(3000),
  EXTERNAL_API_RETRY_MAX_ATTEMPTS: intFromString
    .pipe(z.number().int().min(0).max(10))
    .default(2),
  EXTERNAL_API_RETRY_INITIAL_DELAY_MS: intFromString
    .pipe(z.number().int().min(10))
    .default(100),
  EXTERNAL_API_RETRY_MAX_DELAY_MS: intFromString
    .pipe(z.number().int().min(50))
    .default(1000),
  EXTERNAL_API_BREAKER_CONSECUTIVE_FAILURES: intFromString
    .pipe(z.number().int().min(1))
    .default(5),
  EXTERNAL_API_BREAKER_HALF_OPEN_AFTER_MS: intFromString
    .pipe(z.number().int().min(1000))
    .default(10000),
  EXTERNAL_API_BULKHEAD_MAX_CONCURRENT: intFromString
    .pipe(z.number().int().min(1))
    .default(20),
  EXTERNAL_API_BULKHEAD_MAX_QUEUE: intFromString
    .pipe(z.number().int().min(0))
    .default(50),
});

export type EnvVars = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
