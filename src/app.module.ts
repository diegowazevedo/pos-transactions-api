import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { validateEnv } from './config/validation.schema';
import { Transaction } from './transactions/entities/transaction.entity';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { ExternalApiModule } from './external-api/external-api.module';
import { TransactionsModule } from './transactions/transactions.module';
import { HmacGuard } from './common/guards/hmac.guard';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { AppLoggerModule } from './observability/logger.module';
import { CorrelationIdMiddleware } from './observability/correlation-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate: validateEnv,
    }),
    AppLoggerModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.getOrThrow<string>('db.host'),
        port: config.getOrThrow<number>('db.port'),
        username: config.getOrThrow<string>('db.username'),
        password: config.getOrThrow<string>('db.password'),
        database: config.getOrThrow<string>('db.database'),
        entities: [Transaction],
        synchronize: config.get<boolean>('db.synchronize') ?? false,
        logging: config.get<boolean>('db.logging') ?? false,
      }),
    }),
    RedisModule,
    IdempotencyModule,
    ExternalApiModule,
    TransactionsModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: HmacGuard,
    },
    {
      provide: APP_FILTER,
      useClass: DomainExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Correlation middleware must run BEFORE any guard/handler so that
    // anything downstream (including the HMAC guard's logs) sees the context.
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
