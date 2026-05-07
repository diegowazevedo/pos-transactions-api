import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ExternalApiClient } from '../src/external-api/external-api.client';
import { RedisService } from '../src/redis/redis.service';

export interface TestApp {
  app: INestApplication;
  externalApi: jest.Mocked<ExternalApiClient>;
  cleanDatabase: () => Promise<void>;
  cleanRedis: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Boots the full NestJS app for E2E tests with a stubbed ExternalApiClient
 * so we never hit a real upstream. Postgres and Redis are real — assumed
 * reachable via env vars (see test/setup-env.ts).
 */
export async function buildTestApp(): Promise<TestApp> {
  const externalApiMock: jest.Mocked<ExternalApiClient> = {
    authorize: jest.fn(),
    confirm: jest.fn(),
    void: jest.fn(),
    isCircuitOpen: jest.fn().mockReturnValue(false),
    onModuleInit: jest.fn(),
  } as unknown as jest.Mocked<ExternalApiClient>;

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(ExternalApiClient)
    .useValue(externalApiMock)
    .compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();

  const dataSource = app.get(DataSource);
  const redis = app.get(RedisService);

  return {
    app,
    externalApi: externalApiMock,
    cleanDatabase: async () => {
      await dataSource.query('TRUNCATE TABLE transactions');
    },
    cleanRedis: async () => {
      await redis.client.flushdb();
    },
    close: async () => {
      await app.close();
    },
  };
}
