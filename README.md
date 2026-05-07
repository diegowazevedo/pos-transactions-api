# pos-transactions-api

API orquestradora de transações POS (NestJS + PostgreSQL + Redis), com idempotência distribuída, resiliência ao upstream e observabilidade end-to-end.

## Visão geral

A API atua como **orquestradora** entre o POS e uma API externa de processamento. Aplica regras de negócio (idempotência, máquina de estados, segurança HMAC, resiliência) antes de delegar a operação real para o serviço externo.

### Mapa rápido de decisões

| Preocupação                    | Mecanismo principal                                  | Camada de defesa adicional                       |
| ------------------------------ | ---------------------------------------------------- | ------------------------------------------------ |
| Autenticação de request        | `HmacGuard` global (HMAC-SHA256 sobre raw body)      | Anti-replay via Redis (TTL = janela de tolerância) |
| Idempotência (authorize)       | `runOnce` (Redis lock + cache de resposta)           | Constraint `uq_terminal_nsu` no Postgres         |
| Idempotência (confirm/void)    | Lock distribuído + state machine                     | `@VersionColumn` (optimistic lock)               |
| Resiliência ao upstream        | `cockatiel`: bulkhead → breaker → retry → timeout    | `Idempotency-Key` propagado para retries seguros |
| Falha do upstream              | Mapeamento por classe de erro (4xx/5xx/timeout/rede) | Breaker isola o sistema; retorna `Retry-After`   |
| Observabilidade                | `X-Correlation-Id` + AsyncLocalStorage + Pino        | OpenTelemetry (traces ligados via `traceId`)     |
| Validação de input             | Zod (env + DTOs)                                     | Falha rápida no boot e por request               |

### Endpoints

| Método | Rota                                | Descrição                                                  |
| ------ | ----------------------------------- | ---------------------------------------------------------- |
| GET    | `/health`                           | Liveness + readiness (DB + Redis). Sem HMAC.               |
| POST   | `/v1/pos/transactions/authorize`    | Autoriza nova transação (idempotente por `terminalId+nsu`).|
| POST   | `/v1/pos/transactions/confirm`      | Confirma transação autorizada.                             |
| POST   | `/v1/pos/transactions/void`         | Cancela transação por `transactionId` ou `(terminalId,nsu)`.|

## Estrutura do projeto

```
src/
├── main.ts                              # Bootstrap NestJS (raw body habilitado)
├── app.module.ts                        # Wiring + APP_GUARD HMAC global + middleware ALS
├── config/
│   ├── configuration.ts                 # Carga tipada de env vars
│   └── validation.schema.ts             # Validação Zod (fail-fast no boot)
├── common/
│   ├── decorators/skip-hmac.decorator.ts  # @SkipHmac() para rotas públicas
│   ├── filters/domain-exception.filter.ts # Mapeia erros de domínio + upstream para HTTP
│   ├── guards/hmac.guard.ts             # Verifica X-Signature/X-Timestamp + anti-replay
│   └── pipes/zod-validation.pipe.ts     # Valida @Body com schema Zod
├── idempotency/
│   ├── idempotency.module.ts
│   └── idempotency.service.ts           # Lock distribuído + cache de resposta + runOnce()
├── external-api/
│   ├── external-api.module.ts
│   ├── external-api.client.ts           # POST authorize/confirm/void (idempotency-key forwarded)
│   ├── resilience.policy.ts             # cockatiel: bulkhead → breaker → retry → timeout
│   ├── external-api.types.ts            # Contratos de request/response
│   └── errors.ts                        # ExternalApiError + variantes (transient/client/timeout/circuit/bulkhead)
├── observability/
│   ├── correlation.context.ts           # AsyncLocalStorage + helpers (getCorrelationId, enrich)
│   ├── correlation-id.middleware.ts     # Lê/gera X-Correlation-Id e abre escopo ALS
│   ├── logger.module.ts                 # Pino: mixin com correlationId/traceId/transactionId
│   └── tracing.ts                       # Bootstrap do OpenTelemetry NodeSDK
├── transactions/
│   ├── entities/transaction.entity.ts   # Entidade com unique (terminalId, nsu) + version
│   ├── dto/                             # Schemas Zod + helpers de resposta
│   ├── transactions.controller.ts       # POST /v1/pos/transactions/{authorize,confirm,void}
│   ├── transactions.service.ts          # Orquestração + idempotência + state machine
│   ├── transactions.errors.ts           # TransactionNotFound + InvalidStateTransition
│   └── transactions.module.ts
├── redis/
│   ├── redis.module.ts                  # Cliente ioredis global
│   └── redis.service.ts
└── health/
    └── health.controller.ts             # GET /health (DB + Redis), @SkipHmac()
docker/
├── Dockerfile                           # Multi-stage (deps → build → runtime)
└── docker-compose.yml                   # app + postgres + redis + jaeger + mock-api
mock-api/                                # Fastify mock do upstream (ver mock-api/README.md)
├── src/server.ts                        # Idempotência por header + caos configurável
├── Dockerfile
├── package.json
└── tsconfig.json
test/
├── jest-e2e.json                        # Config Jest E2E
├── setup-env.ts                         # Defaults de env para testes
├── sign.ts                              # Helper canonical de assinatura HMAC
├── app.factory.ts                       # Boot do Nest com ExternalApiClient mockado
└── transactions.e2e-spec.ts             # Specs end-to-end
scripts/
└── sign-request.ts                      # CLI: imprime headers + curl prontos
```

## Como rodar

### Pré-requisitos
- Docker Desktop com Compose v2
- Node 20+ (apenas para rodar fora do Docker)

### Setup

```bash
cp .env.example .env
docker compose -f docker/docker-compose.yml up --build
```

Após subir:

```bash
curl http://localhost:3000/health
```

Resposta esperada:

```json
{
  "status": "ok",
  "checks": { "database": "up", "redis": "up" },
  "timestamp": "2026-05-05T..."
}
```

### Modo desenvolvimento (sem Docker para o app)

```bash
docker compose -f docker/docker-compose.yml up -d postgres redis jaeger
npm install
npm run start:dev
```

### Fazendo uma chamada autenticada manualmente

O helper `npm run sign` gera os headers HMAC e imprime um `curl` pronto para colar:

```bash
npm run sign POST /v1/pos/transactions/authorize \
  '{"terminalId":"T1","nsu":"0001","amount":"10.00"}'
```

O arquivo [`requests.http`](requests.http) tem exemplos para o REST Client (VS Code) e IntelliJ HTTP Client.

## Modelo de dados

| Coluna            ''        | Tipo ''           | Observação                                                           |
| ------------------------- | --------------- | -------------------------------------------------------------------- |
| `transaction_id` (PK)     | `varchar(26)`   | ULID gerado pela API. Fonte de verdade exposta para o cliente.       |
| `terminal_id` + `nsu`     | `varchar(50)` × 2 | **Constraint única `uq_terminal_nsu`** — pilar da idempotência no DB. |
| `amount`                  | `numeric(15,2)` | Decimal para evitar imprecisão de ponto flutuante em valores monetários. |
| `currency`                | `varchar(3)`    | Default `BRL`.                                                       |
| `status`                  | `enum`          | `AUTHORIZED` → `CONFIRMED` → `VOIDED`.                               |
| `external_*`              | `varchar(100)`  | IDs e auth code retornados pelo upstream.                            |
| `created_at`/`updated_at` | `timestamptz`   | Gerenciados pelo TypeORM.                                            |
| `confirmed_at`/`voided_at`| `timestamptz`   | Marcam transições.                                                   |
| `version`                 | `int`           | `@VersionColumn` — optimistic locking.                               |

## Segurança (HMAC)

Todas as rotas autenticadas exigem dois headers:

| Header        | Descrição                                                              |
| ------------- | ---------------------------------------------------------------------- |
| `X-Timestamp` | Unix timestamp (segundos) do momento de assinatura                     |
| `X-Signature` | HMAC-SHA256 hex sobre `${timestamp}.${METHOD}.${path}.${rawBody}`      |

**Proteções aplicadas:**
- **Anti-replay grosseiro:** rejeita timestamps fora de `HMAC_TIMESTAMP_TOLERANCE_SECONDS` (default 300s).
- **Anti-replay fino:** assinaturas vistas são guardadas no Redis (`hmac:seen:<sig>` com TTL = janela de tolerância) — uma mesma assinatura não pode ser usada duas vezes nem dentro da janela válida.
- **Comparação em tempo constante:** `crypto.timingSafeEqual` evita timing attacks.
- **Raw body preservado:** `NestFactory.create({ rawBody: true })` garante que a assinatura é calculada sobre os bytes exatos enviados, antes de qualquer parse.

Exemplo de assinatura (Node.js):

```js
const ts = Math.floor(Date.now() / 1000).toString();
const body = JSON.stringify({ terminalId: 'T1', nsu: '123', amount: '10.00' });
const payload = `${ts}.POST./v1/pos/transactions/authorize.${body}`;
const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
// Headers: X-Timestamp: ts, X-Signature: sig
```

Rotas públicas (como `/health`) usam o decorator `@SkipHmac()`.

## Idempotência distribuída

### Defense in depth (authorize)

A operação `authorize` é o caso mais crítico — duas autorizações para o mesmo `(terminalId, nsu)` representariam cobrança duplicada. Quatro camadas de defesa, do mais barato para o mais caro:

1. **Cache de resposta** no Redis (TTL 1h, chave `idem:cache:authorize:<terminalId>:<nsu>`) — replays rápidos retornam instantaneamente sem tocar em DB nem upstream.
2. **Lock distribuído** (`SET NX EX`, chave `idem:lock:authorize:<terminalId>:<nsu>`) — serializa requests concorrentes do mesmo par.
3. **`SELECT` re-checado dentro da seção crítica** — *double-checked locking*: cobre execuções anteriores bem-sucedidas que ainda não populariam o cache.
4. **Constraint `uq_terminal_nsu`** — barreira final no Postgres. Se um worker perde a corrida (TTL do lock expira, Redis indisponível), o `INSERT` falha com `unique_violation` e a transação existente é retornada — comportamento totalmente idempotente.

### Confirm e Void

Em vez de cache de resposta, o que é natural para essas operações é:
- **Lock distribuído curto** (30s) para evitar duas chamadas externas concorrentes.
- **Re-leitura sob o lock** (em void) para detectar mudança de estado entre o resolve e o lock.
- **`@VersionColumn` (optimistic lock)** protege contra escritas concorrentes não cobertas pelo Redis.
- A própria **state machine** garante idempotência: chamar `confirm` numa transação já `CONFIRMED` retorna `204` sem efeito colateral; o mesmo vale para `void` em `VOIDED`.
- Transições inválidas (`VOIDED → CONFIRMED`, etc.) lançam `InvalidStateTransitionError` → HTTP `409`.

### Liberação segura do lock

A liberação usa script Lua atômico — só faz `DEL` se o token gravado bater com o do dono. Isso evita o bug clássico: se o TTL expira durante uma operação lenta, o lock é re-adquirido por outro worker; sem a checagem, o primeiro worker liberaria um lock que não é mais dele.

## Resiliência ao upstream

Toda chamada para a API externa passa por um pipeline de policies do [cockatiel](https://github.com/connor4312/cockatiel):

```
bulkhead  →  circuitBreaker  →  retry  →  timeout  →  fetch()
   ▲              ▲                ▲          ▲
   │              │                │          └─ aborta a tentativa em N ms
   │              │                └─ tentativa adicional com backoff exponencial + jitter
   │              └─ abre após N falhas consecutivas; meia-aberto após X ms
   └─ limita concorrência total + fila para isolar falhas (bulkhead pattern)
```

### Por que essa ordem?

- **`bulkhead` no nível mais externo** — rejeita imediatamente se já há saturação, antes de ocupar slot do breaker.
- **`circuitBreaker` antes do `retry`** — quando o breaker está aberto, nem tentamos; quando está fechado, o retry pode insistir nas tentativas individuais.
- **`timeout` no mais interno** — cada *tentativa* tem seu próprio deadline. Sem isso, um hang da rede congelaria o retry indefinidamente.

### Classificação de erros (decisão crítica)

A política `retry` só dispara em `ExternalApiTransientError`. Classificação aplicada em `external-api.client.ts`:

| Resultado upstream         | Classificação                  | Retry? | Conta para o breaker? |
| -------------------------- | ------------------------------ | ------ | --------------------- |
| 2xx                        | sucesso                        | —      | reseta contador       |
| 4xx (exceto 408/429)       | `ExternalApiClientError`       | não    | não                   |
| 408, 429, 5xx              | `ExternalApiTransientError`    | sim    | sim                   |
| Falha de rede / DNS / RST  | `ExternalApiTransientError`    | sim    | sim                   |
| Timeout (AbortError)       | `ExternalApiTimeoutError`      | sim    | sim                   |

A motivação é evitar **retry storm em 4xx** (corrigível só por mudança de input) e **acionamento indevido do breaker em erros de cliente**, que são previsíveis e não indicam upstream doente.

### Idempotência das chamadas externas

Todo request envia `Idempotency-Key` no header (valor: `${terminalId}:${nsu}` em `authorize`; `confirm:${transactionId}`/`void:${transactionId}` nas demais). Isso atende o requisito de "evitar duplicidade na chamada externa": mesmo que um retry seja disparado após uma resposta parcialmente entregue, o upstream tem como deduplicar.

### Comportamento sob breaker aberto

- `ExternalApiClient` propaga `CircuitOpenError`.
- O filtro de exceções traduz em `503 Service Unavailable` com header `Retry-After`.
- Operações já persistidas no banco **não** são tocadas — o estado fica consistente para retomar quando o upstream se recuperar.

### Configuração (defaults sensatos)

```env
EXTERNAL_API_TIMEOUT_MS=3000
EXTERNAL_API_RETRY_MAX_ATTEMPTS=2
EXTERNAL_API_RETRY_INITIAL_DELAY_MS=100
EXTERNAL_API_RETRY_MAX_DELAY_MS=1000
EXTERNAL_API_BREAKER_CONSECUTIVE_FAILURES=5
EXTERNAL_API_BREAKER_HALF_OPEN_AFTER_MS=10000
EXTERNAL_API_BULKHEAD_MAX_CONCURRENT=20
EXTERNAL_API_BULKHEAD_MAX_QUEUE=50
```

## Referência da API

Todas as rotas (exceto `/health`) exigem `X-Signature` + `X-Timestamp`.

### `POST /v1/pos/transactions/authorize`

```json
{
  "terminalId": "T1",
  "nsu": "0001",
  "amount": "10.00",
  "currency": "BRL"
}
```

| Cenário                                          | Status | Body                               |
| ------------------------------------------------ | ------ | ---------------------------------- |
| Primeira autorização para `(terminalId, nsu)`    | `201`  | `TransactionResponse`              |
| Replay (mesmo `terminalId` + `nsu`)              | `200`  | `TransactionResponse` (mesmo objeto) |
| Lock ocupado e nenhum peer respondeu em 2s       | `409`  | `OperationInProgress`              |
| API externa indisponível (breaker aberto)        | `503`  | `UpstreamCircuitOpen` + `Retry-After` |
| API externa rejeitou input                       | `502`  | `UpstreamRejected`                 |
| Timeout no upstream                              | `504`  | `UpstreamTimeout`                  |

### `POST /v1/pos/transactions/confirm`

Request: `{ "transactionId": "01HY..." }` — Resposta: `204 No Content`

| Cenário                              | Status |
| ------------------------------------ | ------ |
| Sucesso (AUTHORIZED → CONFIRMED)     | `204`  |
| Já estava CONFIRMED (idempotente)    | `204`  |
| Estava VOIDED (transição inválida)   | `409`  |
| `transactionId` não encontrado       | `404`  |

### `POST /v1/pos/transactions/void`

Aceita lookup por `transactionId` OU por `(terminalId, nsu)`. Resposta: `204 No Content`.

```json
{ "transactionId": "01HY..." }
// ou
{ "terminalId": "T1", "nsu": "0001" }
```

| Cenário                          | Status |
| -------------------------------- | ------ |
| Sucesso                          | `204`  |
| Já estava VOIDED (idempotente)   | `204`  |
| Transação não encontrada         | `404`  |

### Mapeamento de erros (`DomainExceptionFilter`)

| Erro                             | HTTP | Header `Retry-After`        |
| -------------------------------- | ---- | --------------------------- |
| `TransactionNotFoundError`       | 404  | —                           |
| `InvalidStateTransitionError`    | 409  | —                           |
| `LockBusyError`                  | 409  | —                           |
| `CircuitOpenError`               | 503  | `halfOpenAfterMs / 1000`    |
| `BulkheadRejectedError`          | 503  | `1`                         |
| `ExternalApiTimeoutError`        | 504  | —                           |
| `ExternalApiClientError` (4xx)   | 502  | —                           |
| `ExternalApiTransientError`      | 502  | —                           |

## Observabilidade

### Correlation ID

- Middleware (`CorrelationIdMiddleware`) executa antes de qualquer guard ou handler.
- Lê `X-Correlation-Id` do request; se ausente, gera um ULID.
- Abre um escopo `AsyncLocalStorage` que envelopa toda a requisição — qualquer código (service, cliente externo, log) pode ler o ID via `getCorrelationId()` sem precisar receber por parâmetro.
- O mesmo ID é ecoado no header de resposta e propagado ao upstream em `X-Correlation-Id`.
- O context aceita enrichment: o `TransactionsService` chama `enrichRequestContext({ terminalId, nsu, transactionId })` assim que conhece esses valores, fazendo com que **todos os logs subsequentes daquela request** já saiam com esses campos.

### Logs estruturados (`nestjs-pino`)

Cada linha de log carrega automaticamente:

```json
{
  "level": "info",
  "time": "2026-05-05T12:34:56.789Z",
  "correlationId": "01HYZ...",
  "transactionId": "01HYTX...",
  "terminalId": "T1",
  "nsu": "0001",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "msg": "Authorize succeeded"
}
```

- Em **dev** sai bonito via `pino-pretty`; em **prod** sai como NDJSON (uma linha por evento, ideal para ingestão em Loki/ELK/Datadog).
- **Redaction automática** de `x-signature`, `authorization` e `cookie` — assinaturas HMAC nunca aparecem em log.
- `/health` é silenciado para não poluir.
- Os campos `traceId`/`spanId` permitem pivotar entre logs e traces no backend de observabilidade.

### Tracing distribuído (OpenTelemetry)

- `tracing.ts` é importado **antes de qualquer outra coisa** em `main.ts` — sem isso o monkey-patching das instrumentações automáticas não pega.
- Auto-instrumentações ativas: `http`, `express`, `pg` (TypeORM por baixo), `ioredis`, `nestjs-core`.
- Exporter **OTLP/HTTP** envia para Jaeger via porta 4318 (configurável via `OTEL_EXPORTER_OTLP_ENDPOINT`).
- `/health` é ignorado pela instrumentação HTTP para não criar ruído.
- `OTEL_SDK_DISABLED=true` desliga tudo limpo (útil em testes ou quando não há collector).

### Como visualizar localmente

- Logs do app: `docker compose logs -f app` (sai pretty-printed em dev).
- UI do Jaeger: <http://localhost:16686> — selecione o serviço `pos-transactions-api` e busque por `correlationId` ou `transactionId` nos atributos do span.

### Fluxo do correlation ID, ponta a ponta

```
POS → POST /v1/pos/.../authorize  (X-Correlation-Id: abc)
        │
        ├─ Middleware: abre ALS com correlationId=abc, ecoa no response
        │
        ├─ HmacGuard: log de aceite/rejeição já carrega correlationId
        │
        ├─ TransactionsService.authorize:
        │     enrichRequestContext({ terminalId, nsu })  → logs ganham campos
        │
        ├─ ExternalApiClient: header X-Correlation-Id: abc é forwardado
        │     instrumentação OTel cria span filho, ligado ao span do request
        │
        └─ Persistência (TypeORM): instrumentação pg gera spans de query
```

O operador consegue rastrear uma única transação, ponta a ponta, em **logs**, **traces** e na **API externa** usando o mesmo identificador.

## Testes

### Testes unitários

```bash
npm test
```

Cobertura agregada: **36 cenários**.

| Suíte                                | Cenários | O que valida                                                            |
| ------------------------------------ | -------- | ----------------------------------------------------------------------- |
| `HmacGuard`                          | 7        | skip, missing headers, expired ts, valid sig, tampered body, wrong secret, replay |
| `IdempotencyService`                 | 6        | acquire/release, ownership, runOnce cache hit, lock busy, no-cache-on-failure   |
| `ExternalApiClient`                  | 6        | sucesso + idempotency-key, 4xx sem retry, 5xx com retry, falha de rede, breaker abre, timeout |
| `TransactionsService`                | 12       | authorize cache/race/external-fail/unique-violation; confirm idempotência/transições inválidas; void por id/par |
| `CorrelationIdMiddleware`            | 5        | reuse, geração, isolamento entre concurrent requests, enrichment, escopo fora de request |

### Testes E2E

Spinup de **toda a aplicação** (NestJS, Postgres, Redis) com o `ExternalApiClient` substituído por um mock — assim validamos o pipeline real (HMAC, raw body, ALS, idempotência, máquina de estados, filtros HTTP) sem dependência de upstream.

```bash
# Sobe Postgres + Redis necessários (Jaeger é opcional)
npm run test:e2e:up

# Roda os specs E2E
npm run test:e2e

# Quando terminar:
npm run test:e2e:down
```

Cenários cobertos por [`test/transactions.e2e-spec.ts`](test/transactions.e2e-spec.ts):

1. **Autenticação:** rejeita request sem headers HMAC; rejeita body adulterado.
2. **Idempotência:** primeira autorização retorna `201`; replay imediato retorna `200` com o **mesmo `transactionId`**, e o upstream é chamado **uma única vez**.
3. **Idempotency-Key forwarded:** valor enviado ao upstream é `${terminalId}:${nsu}`.
4. **Mapeamento de erros:** 4xx do upstream vira `502`; circuit open vira `503` com header `Retry-After`.
5. **Validação:** payload inválido retorna `400` com lista estruturada de erros Zod.
6. **Lifecycle completo:** `authorize → confirm → confirm (replay) → void → void (replay)` — cada passo é idempotente, e o upstream recebe **exatamente uma chamada** por operação.
7. **Transição inválida:** confirmar uma transação `VOIDED` retorna `409`.
8. **Void por par:** localiza por `(terminalId, nsu)` quando o POS não retém o `transactionId`.
9. **Concorrência:** três `authorize` paralelos para a mesma `(terminalId, nsu)` resultam em **uma única chamada externa**, **um único `transactionId`**, e respostas com mix `201 + 200/409`.

## Limitações conhecidas e próximos passos em produção

Decisões pragmáticas que precisariam de cuidado em produção:

- **`synchronize: true` no TypeORM** — conveniente para o ambiente local; em produção use migrações versionadas (a estrutura para `migration:generate`/`migration:run` já está em `package.json`).
- **`HMAC_SECRET` único e simétrico** — para múltiplos integradores, evoluir para `key_id` no header (ex.: `X-Key-Id`) e segredo por integrador, com rotação.
- **Anti-replay no Redis** — single-region. Em deploys multi-região, o Redis precisa ser replicado ou a janela de tolerância encurtada para evitar replay cross-region.
- **Cache de idempotência (TTL 1h)** — adequado para o cenário POS típico. Para janelas mais longas, mover o cache para o próprio Postgres (uma coluna JSON com a resposta + TTL via `created_at`) elimina a dependência operacional do Redis.
- **`Retry-After` do bulkhead = 1s fixo** — para cargas reais, calcular dinamicamente com base na fila atual.
- **Sampling de traces** — atualmente `parentbased_always_on`. Em produção, head-based sampling (~5–10%) ou tail-based no collector reduz custo sem perder erros (que sempre devem ser amostrados).
- **Rate limiting** — não implementado. Em produção, adicionar `@nestjs/throttler` por `terminalId` antes do guard HMAC.
- **Métricas** — só temos traces/logs. Para SLOs precisamos de métricas: contadores de status do breaker, latência por endpoint (p50/p95/p99), taxa de idempotency-replay. Habilitar `MetricReader` do OTel e exportar via OTLP/Prometheus.
- **Graceful drain do bulkhead** — no shutdown, esperar a fila esvaziar antes de fechar conexões (atualmente só temos `enableShutdownHooks`).

## Como explorar o código

- A **fonte de verdade arquitetural** está em [`src/transactions/transactions.service.ts`](src/transactions/transactions.service.ts) — comece por lá.
- A política de resiliência está isolada em [`src/external-api/resilience.policy.ts`](src/external-api/resilience.policy.ts) — fácil de tunar sem mexer no client.
- As decisões críticas de idempotência estão concentradas em [`src/idempotency/idempotency.service.ts`](src/idempotency/idempotency.service.ts) (em particular o método `runOnce`).
- Para entender o fluxo de uma request, leia em ordem: middleware → guard → controller → pipe → service → cliente externo → filter.
