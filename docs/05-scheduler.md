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
  nome: string;                  // identificador estável — lock e logs
  ambientes: AmbienteDeploy[];   // onde este job roda — obrigatório
  agendamento: string;           // expressão cron
  tempoLimiteMs: number;         // teto de duração de uma execução
  executar: () => Promise<void>;
}
```

Cinco campos, e é isso. Um job **não** trata lock, não abre transação de log,
não mede tempo e não captura o próprio erro. Se um handler estiver fazendo
qualquer uma dessas coisas, ele está duplicando o runner.

Sobre `nome`: ele é a chave do lock distribuído e o campo `job` de todos os
logs. Renomear um job libera o lock antigo e corta a continuidade das consultas
de log. Trate como identificador imutável.

Sobre `ambientes`: é a seção a seguir, inteira.

## Um job, um ambiente

DEV, QA e HML costumam **compartilhar o mesmo banco**. Nesse arranjo, dois
ambientes com o mesmo job registrado disparam duas vezes sobre as mesmas
linhas. O lock distribuído ([capítulo 06](06-lock-distribuido.md)) não resolve:
ele impede a execução *simultânea*, não a *sequencial* — se DEV termina o job
em 800 ms e HML dispara 300 ms depois, a trava já está livre e o trabalho roda
de novo.

`JOBS_ENABLED` também não resolve, porque ela é uma decisão **local de cada
processo** enquanto o problema é **global ao banco**. Nada impede que dois
ambientes a liguem ao mesmo tempo.

Por isso todo job declara onde roda, e o campo é obrigatório:

```ts
export const jobCobranca: DefinicaoJob = {
  nome: 'cobranca-diaria',
  ambientes: ['hml', 'production'],
  // ...
};
```

O corte acontece no registro, em
[`separarJobsPorAmbiente`](../src/scheduler/job-runner.ts):

```ts
const { ativos, ignorados } = separarJobsPorAmbiente(jobs, ambiente.NODE_ENV);
```

Lista, e não valor único, porque um job legitimamente roda em `production`
**e** em um dos ambientes de teste — PRD tem banco próprio, não há conflito. O
que não pode é o mesmo job constar em dois ambientes que dividem banco.

Os dois interruptores respondem perguntas diferentes e se complementam:

| Mecanismo | Pergunta | Onde mora |
| --- | --- | --- |
| `ambientes` | Este job pertence a este ambiente? | Código, revisado em PR |
| `JOBS_ENABLED` | Este processo deve rodar jobs? | Variável de deploy |

### Por que obrigatório, sem default

Um campo opcional com default reintroduz o problema no primeiro job que alguém
adiciona sem pensar no assunto. Sendo obrigatório, o **compilador** exige que
todo job novo responda onde roda — a garantia deixa de depender de alguém
lembrar.

É por isso que [`test/jobs-ambiente.test.ts`](../test/jobs-ambiente.test.ts)
tem um teste de tipo com `@ts-expect-error`: se alguém tornar o campo opcional,
`npm run typecheck` quebra. A proteção não pode virar convenção.

Para desligar um job em todos os ambientes, esvazie a lista (`ambientes: []`).
É explícito e continua visível no diff.

### Por que no código e não numa tabela de configuração

Guardar o dono dos jobs numa tabela do banco compartilhado seria mais forte num
ponto: ela é única para os três ambientes, então nem versões divergentes de
código conseguiriam furá-la. O código não dá essa garantia — se DEV roda um
branch onde alguém acrescentou `'development'` à lista, os dois disparam.

A troca, ainda assim, compensa:

- **Zero infraestrutura.** Nenhuma tabela para criar, migrar e manter em quatro
  ambientes, e nenhum estado de runtime para alguém dessincronizar com um
  `UPDATE` às três da manhã.
- **O compilador cobre o caso comum**, que é o job novo sem declaração. Tabela
  nenhuma faz isso.
- **A mudança fica visível.** `JOBS_ENABLED=true` numa variável de pipeline é
  invisível: sem review, sem diff, sem histórico. Uma lista de ambientes num
  arquivo `.job.ts` aparece no PR e fica no `git blame`. A chave saiu de um
  lugar que ninguém olha para um lugar que todo mundo lê.

O preço é que trocar o ambiente de um job exige commit e deploy. Dado que o
problema nasceu de alguém virar uma chave sem cerimônia, isso é mais recurso
do que defeito.

### A identidade do ambiente precisa ser real

Tudo isso depende de `NODE_ENV` ser **genuinamente diferente em cada deploy**.
Se os quatro ambientes se identificarem como `production`, o filtro é avaliado
contra o mesmo valor em todo lugar e a duplicação volta inteira — agora com
falsa sensação de proteção, porque `production` é valor válido do enum e a
validação passa calada.

Duas defesas, as duas já no código:

- O [`Dockerfile`](../Dockerfile) **não** fixa `NODE_ENV`. A imagem é a mesma
  nos quatro ambientes; quem define a identidade é o ConfigMap
  ([capítulo 11](11-container-e-deploy.md)).
- `ambienteAssumido`, em [`env.ts`](../src/config/env.ts), marca quando a
  variável não foi injetada e o default assumiu. O boot emite um `warn`
  nominal, para que "nenhum job rodou hoje" não passe por normalidade.

### O que isto não resolve

A janela de **rolling update**, que é a razão original do lock existir. Dois
pods do *mesmo* ambiente, ambos com o job registrado: o pod velho dispara às
10:00:00.000 e termina em 800 ms; o novo dispara às 10:00:00.300 e encontra a
trava livre. Mesma ocorrência, duas execuções, em sequência.

Responder "alguém já rodou a ocorrência das 10:00?" depois que a trava foi
liberada exigiria estado durável — uma tabela de execuções, que este serviço
decidiu não ter. A mitigação é a que o contrato já exige: **handlers
idempotentes**. Ver [capítulo 06](06-lock-distribuido.md).

## O entorno

`executarJob` aplica, nesta ordem:

```text
executarComLock(nome)              <- só uma instância executa   (cap. 06)
  -> executarComTempoLimite(...)   <- Promise.race contra o timeout
  -> logger.info/error             <- desfecho + duração no log  (cap. 03)
```

O desfecho de cada execução sai em **uma linha por evento**, em texto puro —
`Job <nome> concluido em <n>ms com sucesso` ou `Job <nome> falhou (<status>)
apos <n>ms`, com `status` sendo `sucesso`, `falha` ou `timeout`. É o que
permite responder "esse job rodou?" e "quanto demorou?" por busca no Log
Analytics, sem tabela de histórico.

A linha única é uma escolha, não um descuido: ela é legível direto no `kubectl
logs`. O custo é que `status` e `duracaoMs` não são campos consultáveis — para
isso seria preciso passá-los como objeto ao pino, o que muda o formato de
todas essas linhas. Ver upgrades.

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
   `executar` só chama o serviço e loga o resultado. **Decida `ambientes`
   agora** — o compilador não deixa passar sem.
3. Adicione ao array em [`src/jobs/jobs.ts`](../src/jobs/jobs.ts).

`server.ts` não é tocado: ele importa o array, filtra por ambiente e registra o
que sobrou. Ver [capítulo 12](12-exemplo-job-e-servico.md) para o modelo
completo.

## O entrypoint: boot e encerramento

[`src/server.ts`](../src/server.ts) é o único arquivo que amarra as peças, e a
ordem em que ele faz isso não é arbitrária.

No boot, `iniciar()` segue três passos:

1. **`obterPoolDb()`** — falha rápido. Um serviço que sobe sem banco só
   descobriria o problema no primeiro disparo de cron, possivelmente de
   madrugada.
2. **`separarJobsPorAmbiente()` e `registrarJob`** — filtra a lista central
   pelo `NODE_ENV` atual e registra o que pertence a este ambiente, e só
   acontece se `JOBS_ENABLED` estiver ligada. Os jobs de outros ambientes
   saem em log nominal, com a lista que declaram.
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
4. **`appInsightsInstance.descarregar()`** — envia os traces ainda no buffer,
   inclusive os do job que acabou de terminar
   ([capítulo 13](13-application-insights.md)).

A flag `encerrando` garante que dois sinais seguidos não disparem o
procedimento duas vezes. `SIGTERM` e `SIGINT` levam ao mesmo caminho: o
primeiro é o que o Kubernetes envia, o segundo é o `Ctrl+C` local.

Para que esse encerramento aconteça de fato no container, o `SIGTERM` precisa
chegar ao processo Node — é o papel do `tini` como PID 1
([capítulo 11](11-container-e-deploy.md)).

## Ligar e desligar todos os jobs de um processo

`ambientes` decide **quais** jobs pertencem a este ambiente. `JOBS_ENABLED`
decide se este processo roda **algum**. É o interruptor geral, útil quando o
serviço precisa subir, responder às probes e não disparar efeito colateral
nenhum ([capítulo 02](02-configuracao-de-ambiente.md)):

```ts
// src/server.ts
const { ativos, ignorados } = separarJobsPorAmbiente(jobs, ambiente.NODE_ENV);

if (ambiente.JOBS_ENABLED) {
  ativos.forEach(registrarJob);
} else {
  logger.warn(`${jobs.length} jobs, JOBS_ENABLED=false — nenhum job ativo`);
}
```

Três decisões explicam o desenho:

- **O corte é no registro, não na execução.** Com a flag desligada, nada chega
  ao `node-schedule`: não há timer armado, não há disputa de lock e não há uma
  linha de log por disparo. O oposto — registrar tudo e abortar dentro do
  handler — encheria o log de ruído e ainda dependeria do banco para decidir
  não fazer nada. Vale igual para o filtro de ambiente.
- **O default é `true`.** Um deploy que não declara a variável se comporta
  exatamente como antes dela existir. Desligar é sempre um ato explícito.
- **O estado mora no deploy, não em memória.** Não existe endpoint para ligar
  ou desligar job, porque a superfície HTTP é somente leitura por decisão de
  arquitetura ([índice](README.md#2-a-superfície-http-é-somente-leitura)).

O log de boot conta a verdade nos dois casos, e distingue os dois motivos de um
job não estar rodando: `JOBS_ENABLED=false` sai como `warn` único, enquanto job
de outro ambiente sai como uma linha por job, com a lista declarada.

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
existentes continuam válidos. É como adicionar `description?: string` ou
`tz?: string`. Regra: o comportamento quando o campo está ausente tem de ser
exatamente o de hoje. `ambientes` é a exceção deliberada a essa regra — ver
"Por que obrigatório, sem default" acima.

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

**Fechar a janela de rolling update** — exige estado durável: uma tabela com
chave primária em (job, ocorrência agendada), com o `INSERT` feito dentro da
transação que já segura o applock. Violação de chave significa que a ocorrência
já rodou, e a execução é pulada. O `fireDate` que o `node-schedule` entrega ao
callback — hoje ignorado em `registrarJob` — é o instante agendado e serve de
chave. Só vale a pena quando houver job cuja não-idempotência seja inevitável.

**Expor quais jobs estão ativos por HTTP** — uma rota somente leitura listando
nome, agendamento e ambientes declarados. Útil para responder "por que meu job
não rodou?" sem abrir log. Respeite o [capítulo 07](07-servidor-http.md): é
leitura, nunca um endpoint que registre ou cancele job.

**Trocar `node-schedule` por `croner` ou `toad-scheduler`** — o acoplamento
está em duas linhas de `registrarJob` e uma de `shutdown`. Requisitos para o
substituto: aceitar expressão cron em string, permitir cancelamento gracioso no
SIGTERM, e não disparar execuções concorrentes do mesmo job. Mantenha
`DefinicaoJob` intacto e a troca fica invisível para os jobs.

**Escalar para mais de uma réplica** — não faça sem antes ler o
[capítulo 06](06-lock-distribuido.md). O lock protege a janela de rolling
update, não um cenário de N réplicas permanentes com jobs não idempotentes.
