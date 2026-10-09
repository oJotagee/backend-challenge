# ARCHITECTURE

Decisões, trade-offs e limitações do Distributed Wagering Processor.

## Princípio

> **O banco garante as invariantes; código e broker são otimizações.**

Duas instâncias podem passar pela mesma verificação em código ao mesmo tempo; uma constraint do
PostgreSQL não. Toda garantia que importa (unicidade, saldo não negativo, ledger imutável,
idempotência) tem uma barreira no schema, e o código existe para chegar nela com o caminho feliz
rápido e com erros legíveis.

```
Provedor ──HTTP──► [instância 1..N] ──┐
Provedor ──SQS───► [instância 1..N] ──┼──► PostgreSQL (fonte da verdade)
                                      │        └── outbox ──► publicador ──► SQS (eventos)
```

Um único serviço NestJS, rodando em N instâncias sobre o mesmo PostgreSQL. HTTP e SQS chamam o
mesmo use case.

---

## 1. Concorrência: lock pessimista por wallet

**Decisão.** `SELECT ... FROM wallets WHERE id = $1 FOR UPDATE` dentro da transação, com
`SET LOCAL lock_timeout = '5s'`. A unidade de concorrência é a wallet.

| Alternativa | Por que não |
|---|---|
| Otimista (`version` + retry) | numa wallet disputada a maioria das tentativas falha e refaz; o retry precisa de limite e ainda pode falhar |
| `UPDATE ... SET balance = balance - x WHERE balance >= x` | resolve o saldo, mas não serializa o resto da decisão (ler a referência, checar se já foi revertida) |
| Lock em memória / lock global | não vale entre instâncias / proibido pelo enunciado |

**Trade-off.** Correção simples de provar, sem cascata de retries. O custo: operações na mesma
wallet fazem fila — no teste de carga, a wallet disputada teve p50 ≈ 270 ms contra ≈ 67 ms das
demais. Wallets diferentes não se bloqueiam (lock por linha). Esperar mais que 5s vira falha
transitória (503 / retry da fila) em vez de espera indefinida.

Sem o lock, os testes de concorrência falham por *lost update* — e o `CHECK (balance >= 0)` não
detecta, porque as escritas se sobrescrevem e o saldo fica **errado**, não negativo. O lock é o
que protege; a constraint é a rede de segurança.

`version` é mantido e incrementado só quando o saldo muda (exigido), mas não é usado para controle
de concorrência.

## 2. Idempotência em duas camadas, no banco

**Decisão.**

| Camada | Protege | Garantia |
|---|---|---|
| `Idempotency-Key` | a operação (venha por HTTP ou fila) | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Inbox | a mensagem SQS reentregue | PK `(consumer_name, message_id)`, `INSERT ... ON CONFLICT DO NOTHING` |

- **Payload hash:** SHA-256 em hex do **JSON canônico** (chaves ordenadas recursivamente, sem
  espaços, `undefined` omitido) dos campos de negócio: `providerId, externalTransactionId,
  playerId, walletId, roundId, gameId, kind, money, referenceExternalTransactionId`. Header,
  `messageId`, `occurredAt` e `correlationId` ficam fora.
- Mesma key + mesmo hash → replay com o resultado original, **inclusive o saldo daquele momento**
  (`balance_after` gravado na transação). Vale também para REJECTED: a decisão não é refeita.
- Mesma key + hash diferente → conflito (409), nunca replay. Mesmo id do provedor com outra key →
  conflito.

**Por que a busca de idempotência vem depois do lock:** requisições iguais e simultâneas fazem fila
no lock e, ao acordar, enxergam a transação que a primeira confirmou → replay limpo. A corrida
residual (mesma key em wallets diferentes) é barrada pelo `UNIQUE` no COMMIT; o use case tenta de
novo (no máximo 3 vezes) e então enxerga a linha.

**Trade-off.** Nenhum estado de idempotência em memória (proibido e inútil com várias instâncias),
ao custo de uma consulta extra por operação.

## 3. Atomicidade e Transactional Outbox

**Decisão.** Inbox, transação, saldo, lançamento e eventos (outbox) são gravados na **mesma**
transação SQL. Um publicador separado lê a outbox com `FOR UPDATE SKIP LOCKED`, publica no SQS e
marca como publicado.

- `SKIP LOCKED` permite vários publicadores em paralelo, cada um com um lote diferente.
- Se o processo morrer depois de publicar e antes do COMMIT, o lock é liberado e outra instância
  publica de novo — com o **mesmo `eventId`**, então a duplicata é segura para o consumidor.
- Retentativa com backoff (1s → 5 min), **sem limite**: evento confirmado não pode se perder.

**Trade-offs.**
- A transação do publicador fica aberta durante a chamada ao SQS (é o que impede dois publicadores
  de pegarem o mesmo evento); o lote é limitado para isso ser curto.
- Publicação com **`SendMessageBatch`, 10 eventos por chamada**. A primeira versão enviava um
  `SendMessage` por evento e o teste de carga mostrou o gargalo: lag de até ~19s com 3 instâncias a
  ~430 req/s. Com o envio em lote, no mesmo cenário, o lag máximo caiu para ~0,6–2,5s e a outbox
  esvazia em ~1s depois da carga. Nenhum evento foi perdido em nenhum dos casos.
- O lote pode ser aceito em parte (o SQS responde por evento): só os aceitos são marcados como
  publicados; os demais voltam com backoff. Se um evento de um agregado falha, os seguintes do
  **mesmo agregado** não são enviados naquela rodada, para não chegarem fora de ordem.
- Eventos vão para uma fila SQS FIFO (`MessageGroupId = aggregateId`, `MessageDeduplicationId =
  eventId`). Em produção seria SNS → filas, para mais de um consumidor.

## 4. Consumidor SQS

**Decisão.** O consumidor chama o mesmo use case do HTTP e só faz `DeleteMessage` depois que ele
retorna — ou seja, depois do COMMIT. Se o processo morrer antes do ack, a mensagem volta pelo
visibility timeout e a inbox transforma a reentrega em replay.

| Situação | Ação | Por quê |
|---|---|---|
| Resultado (PROCESSED, REJECTED, PENDING_REFERENCE, replay) | ack | rejeição é resultado gravado, não falha |
| Negócio (wallet inexistente, conflito de idempotência) | ack + log | reenviar dá o mesmo resultado |
| Permanente (mensagem malformada, valor inválido) | DLQ imediata | nunca vai passar; a DLQ guarda para análise |
| Transitório (banco, lock timeout, **erro inesperado**) | `ChangeMessageVisibility` com backoff; DLQ ao atingir o limite | pode passar na próxima |

- Erro inesperado é tratado como transitório de propósito: melhor tentar N vezes e cair na DLQ do
  que descartar uma operação financeira por causa de um bug.
- Tentativas contadas pelo `ApproximateReceiveCount` do próprio SQS (sobrevive a restart). A DLQ é
  enviada explicitamente pelo consumidor, com `failureCode` e motivo; a `RedrivePolicy` da fila
  fica como segunda barreira.
- `SIGTERM`: para de receber, conclui a mensagem em andamento e devolve as não iniciadas com
  visibility 0 (disponíveis na hora para outra instância).
- Mensagens de um lote são processadas em sequência: na FIFO o lote vem do mesmo grupo
  (`walletId`), e paralelizar só geraria disputa pelo mesmo lock.

**Workers sem líder.** Consumidor, publicador da outbox e worker de referências pendentes rodam em
todas as instâncias. A exclusão mútua vem do banco (inbox, `SKIP LOCKED`, lock da wallet).
Trade-off: sem eleição e sem ponto único de falha, ao custo de consultas redundantes.

## 5. Referências fora de ordem

**Decisão.** REFUND/ROLLBACK cuja referência ainda não chegou é gravado como `PENDING_REFERENCE` e
reprocessado por um worker com backoff exponencial: **8 tentativas, de 1s a 64s (~2 min no
total)**. Esgotado → `REJECTED` com `REFERENCE_NOT_FOUND` e evento.

**Justificativa do limite.** Atrasos normais de entrega fora de ordem são de segundos; uma BET que
não chegou em ~2 minutos provavelmente não vai chegar, e o provedor precisa de uma resposta
definitiva para fechar a rodada. Configurável por variável de ambiente.

Quando a transação referenciada é gravada, as pendências que esperam por ela têm o próximo retry
antecipado para agora, no mesmo COMMIT — sem isso, uma reversão na 6ª espera aguardaria até 64s
com a referência já disponível. O worker trava a wallet **antes** de reler a transação (mesma
ordem de lock do fluxo principal → sem deadlock; duas instâncias que peguem o mesmo id se
serializam).

## 6. Modelo de domínio

**Decisão: domínio sem ORM.** As tabelas são *models* do MikroORM na infraestrutura; as regras são
entidades de domínio em TypeScript puro; mappers traduzem um no outro. Trade-off: duas classes e
um mapper por conceito, em troca de um domínio que não depende do ORM (exigido) e é testado sem
banco.

**Saldo ⇔ ledger.** O único método que altera o saldo da `Wallet` é o mesmo que cria o
lançamento, e só altera depois que o lançamento foi validado. A `Wallet` não carrega a lista de
lançamentos (volume, e verificação em memória não protege contra outra instância).

**Regras num domain service.** As regras da seção 7 envolvem transação, wallet e referência; ficam
em `WagerTransactionProcessor` (sem I/O), não na `Wallet`.

**Máquina de estados.**
```
PENDING ─────────────► PROCESSED | REJECTED | FAILED   (terminais)
   │
   ▼
PENDING_REFERENCE ──► PROCESSED | REJECTED | FAILED
   ▲        │
   └────────┘ nova tentativa (attempts++, backoff)
```
Transição a partir de estado terminal lança erro (é bug, não caminho de negócio) e também é
bloqueada por trigger no banco.

**Adaptações de assinatura** (permitidas pelo enunciado):

| Esqueleto | Implementado | Motivo |
|---|---|---|
| `Wallet.open(props): Wallet` | devolve `{ wallet, openingEntry? }` | saldo inicial > 0 gera o lançamento da transação OPENING |
| `markProcessed(ref, at)` | `markProcessed(ref, balanceAfter, at)` | replay devolve o saldo do momento |
| `markPendingReference()` | `markPendingReference(now, policy)` | backoff explícito e testável |
| `reject(code)` / `fail(code)` | recebem também a data (e o saldo observado no reject) | auditoria |
| — | `WagerTransaction.opening(...)` | OPENING é interno; `create` o recusa |

**Interpretações das regras:**

| Situação | Decisão |
|---|---|
| WIN com referência que ainda não chegou | processado sem ela: o enunciado diz que WIN "pode" referenciar, e travar um prêmio pela ordem de chegada prejudica o jogador |
| WIN com referência presente | validada: BET do mesmo provider, player, wallet, moeda e rodada |
| Reversão cuja referência ainda está pendente | aguarda: o desfecho da referência é desconhecido |
| Valor de LOSS | aceita 0; os demais tipos exigem valor > 0 |
| `providerId = "internal"` | reservado para a transação OPENING; recusado na entrada |

## 7. Dinheiro

**Decisão.** `Money` usa `Decimal` (decimal.js, base 10, precisão 40, arredondamento bancário).
No banco, `numeric(20,2)` com a moeda em coluna separada; o driver devolve **string**; o JSON usa
`{ "amount": "25.00", "currency": "BRL" }`.

- A entrada é validada por regex **antes** do `Decimal`, que aceitaria `1e3` e `Infinity`. Mais de
  2 casas é rejeitado, não arredondado.
- Alternativa descartada: centavos em `bigint` (também exato, sem dependência). Ficou `Decimal` por
  seguir o tipo do esqueleto do enunciado e suportar outra escala sem mudar a representação.

## 8. Schema como garantia

**Decisão.** As invariantes vivem no schema, declaradas nos models do MikroORM (`@Unique`,
`@Check`, índices parciais, `@Trigger`) e materializadas em migrations versionadas e reversíveis:

| Invariante | Mecanismo |
|---|---|
| Uma wallet por player + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` |
| Idempotência | `UNIQUE (idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)` |
| Uma reversão por referência e tipo | índice único **parcial** em `(reference_transaction_id, kind)` para REFUND/ROLLBACK processados |
| Status terminal imutável | trigger `BEFORE UPDATE` |
| Um lançamento por transação por wallet | `UNIQUE (transaction_id, wallet_id)` |
| Lançamento aritmeticamente correto | `CHECK (balance_after = balance_before ± amount)` |
| Ledger append-only | triggers contra `UPDATE`, `DELETE` e `TRUNCATE` |
| Moeda do lançamento = moeda da wallet | trigger `BEFORE INSERT` |
| Inbox deduplica | PK `(consumer_name, message_id)` |

**Trade-offs do MikroORM:**
- O trigger de `TRUNCATE` está numa migration escrita à mão: trigger por statement não aparece na
  introspecção do ORM, que acusaria diferença para sempre.
- A moeda do lançamento é garantida por trigger, não por FK composta `(wallet_id, currency)`: a FK
  escrita à mão não é relida pelo ORM e o mesmo problema de diferença apareceria.
- Migrations rodam num passo próprio, nunca no boot: várias instâncias migrando ao mesmo tempo
  seria uma corrida.

**Por que MikroORM** (preferencial no enunciado): `em.transactional()` dá o "tudo ou nada" com
flush automático (Unit of Work), e `LockMode` gera o `FOR UPDATE` e o `SKIP LOCKED` sem SQL à mão.

## 9. API HTTP

**Decisão: um status por situação**, igual em todos os endpoints, para o provedor decidir sem ler
mensagem de erro:

| Status | Situação | O provedor deve |
|---|---|---|
| 201 / 200 | aplicada agora / replay ou consulta | seguir |
| 202 | aguardando referência | aguardar |
| 400 | payload inválido (nada gravado) | corrigir |
| 404 | wallet ou transação inexistente | corrigir o id |
| 409 | conflito de idempotência / wallet duplicada | não reenviar igual |
| 422 | rejeição de negócio, com `failureCode` (gravada; replay continua 422) | ler o código |
| 503 | falha transitória, `Retry-After` | reenviar com a mesma key |

- **`WALLET_NOT_FOUND` é 404, não 422:** nada é gravado (a FK impede transação para wallet
  inexistente), então não é um resultado da transação.
- Validação de **formato** com zod na borda (campos desconhecidos são rejeitados); validação de
  **significado** no domínio. A regra do valor monetário fica num lugar só.
- **Leitura separada da escrita:** as consultas leem por uma porta própria, sem transação e sem
  lock; a escrita passa pelo runner transacional com lock.
- **Ledger por cursor**, não offset: `base64url({"s": sequence})`, página seguinte por
  `sequence > cursor`. Estável porque inserções na mesma wallet são serializadas pelo lock.
- **Reconciliação nunca corrige:** trava a wallet, soma o ledger no banco e, se divergir, registra
  log de erro e métrica e responde `consistent: false`. Corrigir sozinho esconderia um bug ou uma
  fraude.

**Taxonomia de `failureCode`:**

| Código | Ação do provedor |
|---|---|
| `INSUFFICIENT_FUNDS` | desistir |
| `REVERSAL_INSUFFICIENT_FUNDS` | desistir; análise manual — distinto da aposta sem saldo, porque é uma anomalia operacional (prêmio pago e já gasto) |
| `WALLET_NOT_FOUND`, `WALLET_PLAYER_MISMATCH`, `CURRENCY_MISMATCH` | corrigir |
| `REFERENCE_MISMATCH`, `REFERENCE_KIND_NOT_ALLOWED`, `REVERSAL_AMOUNT_MISMATCH` | corrigir |
| `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`, `REFERENCE_ALREADY_REVERSED` | desistir |
| `PERMANENT_PROCESSING_ERROR` | investigar |

Falha transitória nunca vira REJECTED: transformaria um problema nosso em "não" definitivo.

## 10. Observabilidade

**Decisão.** Toda decisão de transação (HTTP, fila ou worker) e toda divergência de reconciliação
passam por uma única porta de observabilidade, chamada depois do COMMIT; a implementação na
infraestrutura incrementa as métricas Prometheus e escreve logs JSON. A aplicação não conhece
`prom-client` nem logger, e nada é contado duas vezes ou contado antes de um ROLLBACK.

- Logs com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`; **sem** corpo de
  requisição, `authorization`, valores ou saldos.
- Labels de métrica só com cardinalidade baixa e fixa (enums); ids nunca viram label.
- `/health/live` só confirma o processo (reiniciar); `/health/ready` testa PostgreSQL e SQS (tirar
  do balanceamento). Separados porque reiniciar não resolve banco fora do ar.

## 11. Autenticação

**Decisão: não implementada.** Não pontua; o tempo foi para concorrência e idempotência. O ponto de
extensão é um `AuthGuard` global (hoje sem efeito) e `@Public()` nas rotas abertas (health,
métricas).

Desenho alvo: Keycloak com um client confidencial por provedor (`client_credentials`); o guard
valida o JWT pela JWKS (assinatura, `exp`, `iss`, `aud`) e exige que o `azp` seja igual ao
`providerId` do corpo — o provedor A não opera como o B. Mensagens SQS são canal interno confiável,
mas o `providerId` delas continua sujeito às mesmas validações de domínio.

---

## Trade-offs, em resumo

| Decisão | Ganho | Custo |
|---|---|---|
| Lock pessimista por wallet | correção simples de provar; sem retries em cascata | operações na mesma wallet são serializadas |
| Idempotência e inbox no banco | correto com N instâncias e após restart | uma consulta extra por operação |
| Domínio separado dos models do ORM | domínio sem ORM, testável sem banco | duas classes + mapper por conceito |
| Workers em todas as instâncias, sem líder | sem ponto único de falha | consultas redundantes |
| Outbox publicada dentro da transação com lock | um evento nunca é pego por dois publicadores | transação aberta durante a chamada ao SQS |
| Outbox em lotes de 10, em sequência | ~10× menos chamadas ao SQS; ordem por agregado preservada mesmo com falha parcial | um evento que falha segura os seguintes do mesmo agregado até o próximo envio |
| Mensagens de um lote em sequência | ordem por wallet sem disputa de lock | paralelismo só entre instâncias e grupos |
| Erro inesperado tratado como transitório | nenhuma operação descartada por bug | um bug persistente consome as tentativas antes da DLQ |
| Backoff sem jitter | comportamento determinístico | retries podem sincronizar; `SKIP LOCKED` e o lock por wallet mitigam |
| Eventos numa fila SQS FIFO | simples | sem fan-out (produção: SNS) |

## Limitações conhecidas

| Item | Situação |
|---|---|
| Status `FAILED` | modelado e protegido no schema, mas não gravado: uma mensagem que esgota as tentativas por falha de infraestrutura não chegou a gravar a transação. A DLQ, com `failureCode`, é a trilha de auditoria. Melhoria: replay da DLQ gravando FAILED |
| Calibração | o limite de tentativas de PENDING_REFERENCE e o `lock_timeout` de 5s não foram exercitados sob carga |
| Autenticação | não implementada (seção 11) |
| Reversão parcial | fora de escopo |
| SIGTERM | testado pelo mesmo caminho do hook de shutdown; o sinal real não foi testado no Windows |
