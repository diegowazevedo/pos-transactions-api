import { Global, Module } from '@nestjs/common';
import { ExternalApiClient, FETCH_FN } from './external-api.client';

@Global()
@Module({
  providers: [
    {
      provide: FETCH_FN,
      useValue: globalThis.fetch.bind(globalThis),
    },
    ExternalApiClient,
  ],
  exports: [ExternalApiClient],
})
export class ExternalApiModule {}
