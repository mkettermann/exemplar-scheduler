# 05 — Scheduler

[← Banco de dados](04-banco-de-dados.md) ·
[Índice](README.md) ·
[Próximo: Lock distribuído →](06-lock-distribuido.md)

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
export interface DefinicaoJob {
  nome: string;           // identificador estável — usado no lock e nos logs
  agendamento: string;    // expressão cron
  tempoLimiteMs: number;  // teto de duração de uma execução
  executar: () => Promise<void>;
}
```

Quatro campos, e é isso. Um job **não** trata lock, não abre transação de log,
não mede tempo e não captura o próprio erro. Se um handler estiver fazendo
qualquer uma dessas coisas, ele está duplicando o runner.

Sobre `nome`: ele é a chave do lock distribuído e o campo `job` de todos os
logs. Renomear um job libera o lock antigo e corta a continuidade das consultas
de log. Trate como identificador imutável.

## O entorno

`executarJob` aplica, nesta ordem:

```text
executarComLock(nome)              <- só uma instância executa   (cap. 06)
  -> executarComTempoLimite(...)   <- Promise.race contra o timeout
  -> logger.info/error             <- status + duracaoMs no log  (cap. 03)
```

O desfecho de cada execução sai como log estruturado, com `status`
(`sucesso` | `falha` | `timeout`) e `duracaoMs` em campos próprios. É o que
permite responder "esse job rodou?" e "quanto demorou?" por query no Log
Analytics, sem tabela de histórico.

Dois detalhes que explicam o comportamento em falha:

- **O erro do handler não é relançado.** Ele é classificado (`timeout` se a
  mensagem começa com `Timeout`, senão `falha`) e logado. Um job que falha
  não derruba o processo nem impede a próxima execução agendada.
- **`registrarJob` envolve tudo em `.catch()` com `logger.fatal`.** Chegar ali
  significa que o próprio runner falhou (o banco recusou a transação do lock,
  por exemplo), não que o job falhou. É um alerta de infraestrutura.

### O timeout interrompe a espera, não o trabalho

```ts
await Promise.race([acao(), expiracao]);
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
2. Crie `src/jobs/meu-processo.job.ts` exportando um `DefinicaoJob` cujo
   `executar` só chama o serviço e loga o resultado.
3. Adicione ao array em [`src/jobs/jobs.ts`](../src/jobs/jobs.ts).

`server.ts` não é tocado: ele importa o array e faz `jobs.forEach(registrarJob)`.
Ver [capítulo 12](12-exemplo-job-e-servico.md) para o modelo completo.

## O entrypoint: boot e encerramento

[`src/server.ts`](../src/server.ts) é o único arquivo que amarra as peças, e a
ordem em que ele faz isso não é arbitrária.

No boot, `iniciar()` segue três passos:

1. **`obterPoolDb()`** — falha rápido. Um serviço que sobe sem banco só
   descobriria o problema no primeiro disparo de cron, possivelmente de
   madrugada.
2. **`jobs.forEach(registrarJob)`** — registra os jobs da lista central, e
   só acontece se `JOBS_ENABLED` estiver ligada (seção seguinte).
3. **`construirApp()` e `listen()`** — a superfície HTTP entra por último, e é
   o que faz o readiness passar a responder.

No encerramento, `encerrar(sinal)` inverte a lógica, na ordem que importa
durante um rolling update:

1. **`schedule.gracefulShutdown()`** — para de agendar novas execuções e
   **espera** as que já estão rodando terminarem. Um job cortado na metade é
   exatamente o que o lock distribuído não consegue desfazer
   ([capítulo 06](06-lock-distribuido.md)).
2. **`servidor.close()`** — para de aceitar novas requisições.
3. **`fecharPoolDb()`** — só depois que ninguém mais precisa do banco.

A flag `encerrando` garante que dois sinais seguidos não disparem o
procedimento duas vezes. `SIGTERM` e `SIGINT` levam ao mesmo caminho: o
primeiro é o que o Kubernetes envia, o segundo é o `Ctrl+C` local.

Para que esse encerramento aconteça de fato no container, o `SIGTERM` precisa
chegar ao processo Node — é o papel do `tini` como PID 1
([capítulo 11](11-container-e-deploy.md)).

## Ligar e desligar os jobs por ambiente

Em qualidade e homologação é comum não querer job nenhum rodando: o serviço
precisa subir, responder às probes e não disparar efeito colateral. Em produção
eles ficam ligados. Quem decide isso é a variável `JOBS_ENABLED`
([capítulo 02](02-configuracao-de-ambiente.md)):

```ts
// src/server.ts
if (ambiente.JOBS_ENABLED) {
  jobs.forEach(registrarJob);
} else {
  logger.warn({ jobsDeclarados: jobs.length }, 'JOBS_ENABLED=false — nenhum job registrado');
}
```

Três decisões explicam o desenho:

- **O corte é no registro, não na execução.** Com a flag desligada, nada chega
  ao `node-schedule`: não há timer armado, não há disputa de lock e não há uma
  linha de log por disparo. O oposto — registrar tudo e abortar dentro do
  handler — encheria o log de ruído e ainda dependeria do banco para decidir
  não fazer nada.
- **O default é `true`.** Um deploy que não declara a variável se comporta
  exatamente como antes dela existir. Desligar é sempre um ato explícito.
- **O estado mora no deploy, não em memória.** Não existe endpoint para ligar
  ou desligar job, porque a superfície HTTP é somente leitura por decisão de
  arquitetura ([índice](README.md#2-a-superfície-http-é-somente-leitura)).

O log de boot conta a verdade nos dois casos: com a flag desligada sai um
`warn` nominal e a linha final fecha com `Total de jobs: 0`.

A flag desliga os jobs, e só. O pool do banco continua sendo aberto no boot e o
readiness continua dependendo dele — um scheduler sem jobs registrados ainda é
um serviço que precisa provar que está pronto.

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
agendamento: { rule: '0 3 * * *', tz: 'America/Sao_Paulo' }
```

Isso exige alargar o tipo de `DefinicaoJob.agendamento` — ver upgrades abaixo.

## Upgrades futuros sem quebrar o que existe

**Adicionar um campo opcional ao `DefinicaoJob`** — seguro, porque jobs
existentes continuam válidos. É como adicionar `enabled?: boolean`,
`description?: string` ou `tz?: string`. Regra: o comportamento quando o campo
está ausente tem de ser exatamente o de hoje.

**Suportar fuso por job** — alargue o tipo e repasse ao `node-schedule`, que já
aceita o objeto:

```ts
agendamento: string | { rule: string; tz: string };
```

Nenhum job existente quebra, porque `string` continua no union.

**Passar contexto ao handler** — `executar: (ctx: ContextoJob) => Promise<void>`,
com `ctx` trazendo `execucaoId`, um `logger` filho e um `AbortSignal`. Essa é
uma **quebra de contrato**: todo handler precisa ser revisado. Para migrar sem
parada, torne o parâmetro opcional primeiro (`(ctx?: ContextoJob)`), migre os
handlers um a um, e só depois torne obrigatório.

**Ligar e desligar jobs individualmente** — o interruptor global já existe
(`JOBS_ENABLED`, seção [acima](#ligar-e-desligar-os-jobs-por-ambiente)). Para
granularidade por job, o caminho é o mesmo: uma variável validada no
`esquemaAmbiente` — por exemplo `JOBS_DESABILITADOS`, lista separada por
vírgula — filtrando o array antes do `forEach`. Resista a fazer isso por
endpoint: o estado precisa ficar auditável no deploy, não em memória.

**Trocar `node-schedule` por `croner` ou `toad-scheduler`** — o acoplamento
está em duas linhas de `registrarJob` e uma de `shutdown`. Requisitos para o
substituto: aceitar expressão cron em string, permitir cancelamento gracioso no
SIGTERM, e não disparar execuções concorrentes do mesmo job. Mantenha
`DefinicaoJob` intacto e a troca fica invisível para os jobs.

**Escalar para mais de uma réplica** — não faça sem antes ler o
[capítulo 06](06-lock-distribuido.md). O lock protege a janela de rolling
update, não um cenário de N réplicas permanentes com jobs não idempotentes.
