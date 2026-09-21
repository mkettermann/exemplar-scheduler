# 05 — Scheduler

[← Banco de dados](04-banco-de-dados.md) · [Índice](README.md) · [Próximo: Lock distribuído →](06-lock-distribuido.md)

## Bibliotecas

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`node-schedule`](https://www.npmjs.com/package/node-schedule) | `^2.1` | Dispara funções em expressões cron, dentro do próprio processo |
| [`@types/node-schedule`](https://www.npmjs.com/package/@types/node-schedule) | `^2.1` | Tipos |

Por que `node-schedule` e não um CronJob do Kubernetes: um CronJob sobe um pod
novo a cada disparo, o que significa pagar cold start e reconexão de banco toda
vez — caro para um job de 2 segundos que roda a cada 5 minutos. Um processo
residente com agendamento interno também dá acesso ao estado compartilhado
(pool de conexão, cache) entre execuções.

## Responsabilidade

Três arquivos, três papéis distintos:

| Arquivo | Papel |
| --- | --- |
| [`job.types.ts`](../src/scheduler/job.types.ts) | O **contrato**: o que é um job |
| [`job-runner.ts`](../src/scheduler/job-runner.ts) | O **entorno**: o que acontece em volta de todo job |
| [`jobs/jobs.ts`](../src/jobs/jobs.ts) | A **lista**: quais jobs estão ativos |

## O contrato

```ts
export interface JobDefinition {
  name: string;        // identificador estável — usado no lock e nos logs
  schedule: string;    // expressão cron
  timeoutMs: number;   // teto de duração de uma execução
  handler: () => Promise<void>;
}
```

Quatro campos, e é isso. Um job **não** trata lock, não abre transação de log,
não mede tempo e não captura o próprio erro. Se um handler estiver fazendo
qualquer uma dessas coisas, ele está duplicando o runner.

Sobre `name`: ele é a chave do lock distribuído e o campo `job` de todos os
logs. Renomear um job libera o lock antigo e corta a continuidade das consultas
de log. Trate como identificador imutável.

## O entorno

`executeJob` aplica, nesta ordem:

```text
withJobLock(name)          <- só uma instância executa      (cap. 06)
  -> runWithTimeout(...)   <- Promise.race contra o timeout
  -> logger.info/error     <- status + durationMs no log     (cap. 03)
```

O desfecho de cada execução sai como log estruturado, com `status`
(`success` | `failure` | `timeout`) e `durationMs` em campos próprios. É o que
permite responder "esse job rodou?" e "quanto demorou?" por query no Log
Analytics, sem tabela de histórico.

Dois detalhes que explicam o comportamento em falha:

- **O erro do handler não é relançado.** Ele é classificado (`timeout` se a
  mensagem começa com `Timeout`, senão `failure`) e logado. Um job que falha
  não derruba o processo nem impede a próxima execução agendada.
- **`registerJob` envolve tudo em `.catch()` com `logger.fatal`.** Chegar ali
  significa que o próprio runner falhou (o banco recusou a transação do lock,
  por exemplo), não que o job falhou. É um alerta de infraestrutura.

### O timeout interrompe a espera, não o trabalho

```ts
await Promise.race([fn(), timeout]);
```

Quando o timeout vence, o runner para de **esperar** o handler — mas o handler
continua rodando em segundo plano até terminar sozinho. O JavaScript não tem
como abortar uma função arbitrária.

A consequência prática: um job que trava em uma query de 20 minutos será
marcado como `timeout` no histórico, e ainda assim manterá a conexão ocupada.
Para que o timeout realmente interrompa o trabalho, o handler precisa cooperar,
propagando um `AbortSignal`:

```ts
// no handler, para chamadas HTTP
await fetch(url, { signal: AbortSignal.timeout(10_000) });
```

## Registrar um job novo

1. Crie `src/services/meu-processo.service.ts` com a regra de negócio.
2. Crie `src/jobs/meu-processo.job.ts` exportando um `JobDefinition` cujo
   `handler` só chama o serviço e loga o resultado.
3. Adicione ao array em [`src/jobs/jobs.ts`](../src/jobs/jobs.ts).

`server.ts` não é tocado: ele importa o array e faz `jobs.forEach(registerJob)`.
Ver [capítulo 11](11-exemplo-job-e-servico.md) para o modelo completo.

## Expressões cron

O `node-schedule` aceita o formato de 6 campos, com **segundos** opcionais na
frente:

```text
 *    *    *    *    *    *
 seg  min  hora dia  mês  dia-da-semana
```

| Expressão | Significado |
| --- | --- |
| `*/5 * * * *` | A cada 5 minutos |
| `0 3 * * *` | Todo dia às 03:00 |
| `0 0 * * 1` | Toda segunda-feira à meia-noite |
| `0 */6 * * *` | A cada 6 horas, no minuto zero |

Cuidado com o fuso: o cron usa o fuso do **processo**. Um container sem `TZ`
definido roda em UTC, e `0 3 * * *` dispara às 00:00 em Brasília. Defina `TZ`
no deployment ou use a forma com objeto:

```ts
schedule: { rule: '0 3 * * *', tz: 'America/Sao_Paulo' }
```

Isso exige alargar o tipo de `JobDefinition.schedule` — ver upgrades abaixo.

## Upgrades futuros sem quebrar o que existe

**Adicionar um campo opcional ao `JobDefinition`** — seguro, porque jobs
existentes continuam válidos. É como adicionar `enabled?: boolean`,
`description?: string` ou `tz?: string`. Regra: o comportamento quando o campo
está ausente tem de ser exatamente o de hoje.

**Suportar fuso por job** — alargue o tipo e repasse ao `node-schedule`, que já
aceita o objeto:

```ts
schedule: string | { rule: string; tz: string };
```

Nenhum job existente quebra, porque `string` continua no union.

**Passar contexto ao handler** — `handler: (ctx: JobContext) => Promise<void>`,
com `ctx` trazendo `executionId`, um `logger` filho e um `AbortSignal`. Essa é
uma **quebra de contrato**: todo handler precisa ser revisado. Para migrar sem
parada, torne o parâmetro opcional primeiro (`(ctx?: JobContext)`), migre os
handlers um a um, e só depois torne obrigatório.

**Ligar e desligar jobs por configuração** — resista a fazer isso por endpoint:
a superfície HTTP é somente leitura por decisão de arquitetura
([índice](README.md#2-a-superfície-http-é-somente-leitura)). O caminho correto é
uma variável de ambiente validada no `envSchema` (por exemplo
`JOBS_DESABILITADOS` como lista separada por vírgula), filtrando o array antes
do `forEach`. Isso mantém o estado auditável no deploy, não em memória.

**Trocar `node-schedule` por `croner` ou `toad-scheduler`** — o acoplamento
está em duas linhas de `registerJob` e uma de `shutdown`. Requisitos para o
substituto: aceitar expressão cron em string, permitir cancelamento gracioso no
SIGTERM, e não disparar execuções concorrentes do mesmo job. Mantenha
`JobDefinition` intacto e a troca fica invisível para os jobs.

**Escalar para mais de uma réplica** — não faça sem antes ler o
[capítulo 06](06-lock-distribuido.md). O lock protege a janela de rolling
update, não um cenário de N réplicas permanentes com jobs não idempotentes.
