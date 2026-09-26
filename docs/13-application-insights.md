# 13 — Application Insights

[← Container e deploy](11-container-e-deploy.md) ·
[Índice](README.md)

## Biblioteca

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`applicationinsights`](https://learn.microsoft.com/azure/azure-monitor/app/nodejs) | `^3.16` | Telemetria para o Azure Application Insights: traces manuais e coleta automática |

A versão 3 do pacote é uma **camada de compatibilidade** sobre o
[Azure Monitor OpenTelemetry](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-enable?tabs=nodejs).
A API é a mesma do SDK clássico (v2) — `setup()`, `setAutoCollect...()`,
`start()`, `defaultClient.trackTrace()` —, mas por baixo quem coleta e envia é
o OpenTelemetry. Isso explica quase todas as ressalvas deste capítulo: algumas
opções do v2 foram mantidas só na assinatura, e o momento em que a
configuração é lida mudou.

## Responsabilidade

Dar aos jobs **uma única instância** do Application Insights, já configurada,
para registrar `trackTrace` antes e depois de cada procedure:

```ts
import { appInsightsInstance } from '../config/appInsights.js';

appInsightsInstance.trackTrace('sp_ProcessarCobranca: iniciando');
await pool.request().execute('sp_ProcessarCobranca');
appInsightsInstance.trackTrace('sp_ProcessarCobranca: concluída');
```

Para dar visibilidade ao que cada job faz: no portal,
os pares "iniciando/concluída" mostram quando a procedure começou, quando
terminou e — pela ausência do segundo trace — onde uma execução parou.

[`src/config/appInsights.ts`](../src/config/appInsights.ts) é o **dono
exclusivo** do SDK, do mesmo jeito que [`mssql.ts`](04-banco-de-dados.md) é
dono do pool. Nenhum outro arquivo chama `appInsights.setup()`.

## Como funciona

### Uma instância estática

```ts
export class AppInsights {
  private static instancia: AppInsights | undefined;

  static obterInstancia(): AppInsights { /* cria na primeira chamada */ }

  trackTrace(mensagem: string, severidade: Severidade = 1): void { }
  async descarregar(): Promise<void> { }
}

export const appInsightsInstance = AppInsights.obterInstancia();
```

O construtor é privado e `obterInstancia()` devolve sempre o mesmo objeto. Não
é zelo de padrão de projeto: o SDK só admite **um** `setup()` por processo — o
segundo é ignorado com um aviso. Centralizar a criação aqui impede que um job
tente configurar o SDK de novo, com outras opções, e fique achando que valeu.

Os jobs importam `appInsightsInstance` e pronto. `AppInsights` também é
exportada, mas só para os testes provarem que a instância é única.

### A chave vem do ambiente

O setup recebe `ambiente.APPINSIGHTSKEY`, validada pelo
[`esquemaAmbiente`](02-configuracao-de-ambiente.md). Ela aceita dois formatos:

| Valor injetado | O que o SDK recebe |
| --- | --- |
| Connection string (`InstrumentationKey=...;IngestionEndpoint=...`) | O valor como veio |
| Só a iKey (um GUID) | `InstrumentationKey=<GUID>` |

O embrulho existe porque o SDK v3 **só aceita connection string**. Com a iKey
pura, o envio vai para o endpoint global padrão. Funciona, mas a Microsoft
encerrou o suporte à ingestão só por iKey: prefira injetar a connection string
completa, que carrega o endpoint regional do recurso.

A variável é **opcional**. Sem ela, a instância nasce desligada: `trackTrace` e
`descarregar` viram no-op, o job segue normalmente e o boot avisa:

```text
APPINSIGHTSKEY ausente — Application Insights desligado
```

É o critério do [capítulo 02](02-configuracao-de-ambiente.md) para defaults:
ausência de telemetria nunca produz dado errado, só perde visibilidade. Por
isso `npm run dev` e o vitest funcionam sem a chave. Em ambiente de deploy,
confira esse aviso no primeiro boot — ele é a única pista de que a pipeline
não injetou a variável.

Trate o valor como segredo: ele fica no variable group da pipeline, junto das
credenciais do banco, com o bloco `|-` no manifesto (o `textoObrigatorio`
recusa quebra de linha nas pontas, como nos campos de conexão).

### Onde a instância é criada

A criação acontece no `import`. O [entrypoint](../src/server.ts) importa o
módulo **logo depois do `env.ts`**, antes de qualquer coisa que carregue o
Fastify:

```ts
import { ambiente, ambienteAssumido } from './config/env.js';
// Antes do Fastify, para a auto-coleta enxergar o `http` — ver docs/13.
import { appInsightsInstance } from './config/appInsights.js';
```

A ordem importa. A coleta automática do OpenTelemetry funciona interceptando
o `require` dos módulos que ela instrumenta, como o `http`. Se o Fastify
carregar o `http` antes do `start()`, as chamadas HTTP de saída deixam de ser
coletadas como dependência — sem erro, só sem dado.

No encerramento, `descarregar()` roda depois de `fecharPoolDb()`
([capítulo 05](05-scheduler.md)): o SDK envia em lote, e sem o flush os
últimos traces — justamente os do job que o `SIGTERM` esperou terminar — se
perderiam com o processo.

### Nunca derruba o job

`trackTrace` e `descarregar` capturam qualquer erro do SDK e o registram no
[logger](03-logger.md) como `warn`. Telemetria é observação: uma falha ao
observar não pode virar falha do job observado.

## O que cada configuração faz

Os valores abaixo estão aplicados em
`iniciarCliente()`. A última coluna é o que o SDK **v3.16** efetivamente faz
com cada um — e em alguns casos é diferente do que o nome sugere.

| Configuração | Valor | O que faz | No SDK v3 |
| --- | --- | --- | --- |
| `setDistributedTracingMode` | `0` (`AI`) | Propaga só os headers de correlação próprios do Application Insights, sem o padrão W3C | **Não suportado.** O v3 só propaga W3C Trace Context; o valor é registrado e ignorado |
| `setInternalLogging` | `false` | Desliga o log de **debug** do próprio SDK | O log de **aviso** continua ligado, porque o segundo parâmetro (omitido) tem default `true` |
| `setSendLiveMetrics` | `false` | Não abre o canal do Live Metrics (painel em tempo real) | Respeitado |
| `setAutoDependencyCorrelation` | `true` | Liga cada dependência à operação que a originou | Respeitado — no v3 a correlação é sempre ligada |
| `setAutoCollectRequests` | `false` | Não registra as requisições HTTP recebidas como `request` | Respeitado. — ver abaixo |
| `setAutoCollectPerformance` | `true, true` | Contadores de desempenho (CPU, memória, requisições por segundo); o segundo `true` pede as métricas estendidas | Os contadores são respeitados; **métricas estendidas não são suportadas** |
| `setAutoCollectExceptions` | `true` | Envia exceções não tratadas do processo | Respeitado |
| `setAutoCollectDependencies` | `true` | Registra chamadas de saída como `dependency` | Respeitado para `http`/`https` e SDKs do Azure. **MSSQL não está na lista** de instrumentações |
| `setAutoCollectConsole` | `true` | Coleta logs das bibliotecas `winston` e `bunyan` | Respeitado. `console.log` só entraria com um segundo `true`; o `pino` deste projeto **não** é coletado |
| `setUseDiskRetryCaching` | `true` | Guarda em disco o que não pôde ser enviado e reenvia quando a rede volta | Respeitado (já é o default) |
| `config.maxBatchSize` | `500` | Tamanho máximo do lote enviado de uma vez | **Não suportado.** O lote é decidido pelo OpenTelemetry |
| `config.maxBatchIntervalMs` | `15000` | Intervalo máximo entre envios | Vira o timeout dos exportadores OTLP, que este projeto não usa — **sem efeito prático** |
| `config.samplingPercentage` | `100` | Percentual da telemetria que é enviado | Respeitado: 100% = nada é descartado por amostragem |

### Por que as três últimas vêm antes do `start()`

No SDK v2, `maxBatchSize`, `maxBatchIntervalMs` e `samplingPercentage` eram
lidos a cada envio, e por isso era comum ajustá-los **depois** do `start()`.
No v3 isso mudou: o `start()` lê a configuração inteira **uma vez**, converte
para as opções do OpenTelemetry e não olha mais para `defaultClient.config`.
Qualquer valor escrito depois é ignorado em silêncio.

Por isso `iniciarCliente()` escreve os três em `defaultClient.config` entre o
`setup()` e o `start()`. Os testes provam essa ordem (ver abaixo).

### Opções mantidas mesmo sem efeito

`DistributedTracingMode = 0`, `maxBatchSize` e o segundo `true` de
`setAutoCollectPerformance` não fazem nada no v3. Foram mantidos para o
arquivo espelhar a configuração padrão, e para que a comparação com
os outros sistemas continue direta. O SDK registra cada um como opção não
suportada no seu log de diagnóstico interno.

Se um dia o padrão for revisto para o v3, esses três podem sair sem
mudar comportamento algum.

### Requisições não são coletadas

As únicas requisições HTTP que recebe são as
probes do Kubernetes em `/health` e `/health/ready`
([capítulo 08](08-health-check.md)), a cada poucos segundos. Com
`setAutoCollectRequests(true)`, cada uma viraria um item de telemetria —
ingestão cobrada sem valor de diagnóstico.

Desligar a coleta de requisições não desliga a de dependências: no v3 o
SDK mantém a instrumentação do `http` ativa e só passa a ignorar as
requisições **recebidas**. As chamadas HTTP de saída continuam registradas.

Os jobs, por outro lado, **não** são requisições: uma execução do cron não
aparece como `request` no portal. O que a torna visível são justamente os
`trackTrace` manuais.

### Dependências: por que o `trackTrace` é necessário

A lista de instrumentações do SDK v3 cobre `http`/`https`, SDKs do Azure,
MongoDB, MySQL, PostgreSQL e Redis. O driver do SQL Server (`mssql`/`tedious`)
**não está nela**. As procedures, portanto, não aparecem sozinhas como
dependência no mapa da aplicação — os traces antes e depois são o único
registro delas no Application Insights.

## Severidade

O segundo parâmetro de `trackTrace` é opcional e segue a escala numérica do
SDK clássico. O padrão é **`1`**:

| Valor | Nome enviado | Quando usar |
| --- | --- | --- |
| `0` | `Verbose` | Detalhe de diagnóstico |
| `1` | `Information` | **Padrão** — início e fim de procedure |
| `2` | `Warning` | Situação anormal contornada |
| `3` | `Error` | Falha |
| `4` | `Critical` | Falha que exige ação imediata |

O v3 espera o **nome** da severidade, não o número; o wrapper faz a conversão.
O tipo `Severidade` aceita só `0` a `4`, então um valor fora da escala é erro
de compilação.

Para registrar a falha de uma procedure no portal, trace e **relance** — quem
classifica e loga a falha do job continua sendo o
[job-runner](05-scheduler.md):

```ts
try {
  await pool.request().execute('sp_ProcessarCobranca');
} catch (erro) {
  appInsightsInstance.trackTrace('sp_ProcessarCobranca: falhou', 3);
  throw erro;
}
```

## Convenções de uso

- **Mensagem com o nome da procedure (ou do serviço) na frente**, seguido do
  momento: `sp_X: iniciando`, `sp_X: concluída`. É o que se filtra no portal.
- **Contagens e identificadores de lote cabem; dado pessoal não.** O trace sai
  do cluster e fica retido no Azure. O redact do [logger](03-logger.md) não
  alcança o `trackTrace`.
- **Não substitui o `logger`.** O `pino` continua sendo o log do processo, em
  `stdout`; o `trackTrace` é o marco de negócio que acompanha no
  Application Insights. Os dois convivem.

O modelo em
[`example-consulta.service.ts`](../src/services/example-consulta.service.ts)
mostra o uso em volta de uma consulta
([capítulo 12](12-exemplo-job-e-servico.md)).

## Testes

[`test/app-insights.test.ts`](../test/app-insights.test.ts) substitui o SDK
inteiro por um falso e prova o wrapper, com 100% de cobertura do arquivo:

| Asserção | Por que importa |
| --- | --- |
| Sem `APPINSIGHTSKEY`, o SDK não é inicializado e o boot avisa | A ausência é visível, não silenciosa |
| Desligado, `trackTrace` e `descarregar` não fazem nada nem lançam | Job sem telemetria continua sendo job |
| Connection string passa intacta; iKey pura é embrulhada | O SDK v3 só aceita connection string |
| Cada configuração é chamada uma vez, com o valor definido, antes do `start()` | É o padrão antigo, e depois do `start()` nada vale |
| Lote e amostragem já estão no `config` quando o `start()` roda | A armadilha da migração v2 → v3 |
| `obterInstancia()` devolve sempre a mesma instância; `setup()` roda uma vez | O SDK não admite dois setups |
| Sem severidade, o trace vai como `Information`; `0` a `4` viram os nomes | O padrão `1` e a conversão para o v3 |
| Erro do SDK no trace ou no flush vira `warn`, não exceção | Telemetria não derruba job nem encerramento |

Como em [`mssql.test.ts`](../test/mssql.test.ts), a instância é estado de
módulo: cada teste recarrega `appInsights.ts` com `vi.resetModules()`. Que a telemetria
chegue de fato ao portal é afirmação sobre o Azure, e só se confere num
ambiente com a chave real.

## Upgrades futuros sem quebrar o que existe

**Voltar a coletar requisições** — se o serviço um dia ganhar endpoints além
do health, troque para `setAutoCollectRequests(true)` e filtre as probes pelo
`setAzureMonitorOptions`, antes do `start()`:

```ts
.setAzureMonitorOptions({
  instrumentationOptions: {
    http: {
      enabled: true,
      ignoreIncomingRequestHook: (requisicao) => requisicao.url?.startsWith('/health') ?? false,
    },
  },
})
```

Atualize o valor esperado em `test/app-insights.test.ts` e confira no portal
que só as rotas novas aparecem como `request`.

**Trace automático em todo job** — se a convenção virar "todo job tem início e
fim no portal", o lugar é o [job-runner](05-scheduler.md), que já envolve cada
execução com lock, prazo e log. Um `trackTrace` antes e depois do handler ali
cobre todos os jobs de uma vez. Os traces por procedure, dentro dos serviços,
continuam úteis para jobs que chamam várias.

**Subir a versão do pacote** — o risco está nas opções marcadas como "não
suportado" na tabela: uma versão nova pode passar a honrá-las, ou removê-las
da assinatura. Depois de subir, rode `npm run typecheck` e `npm test`, e
suba o serviço com uma chave real para conferir o log de diagnóstico do SDK.

**Migrar para o OpenTelemetry direto** — `useAzureMonitor()` (exportado pelo
mesmo pacote) substitui o shim. Como todo o sistema importa só
`appInsightsInstance`, a troca fica dentro de `appInsights.ts`: mantenha a
assinatura `trackTrace(mensagem, severidade = 1)` e o resto não percebe.

**Tornar a chave obrigatória** — se a telemetria virar requisito em produção,
troque `.optional()` por obrigatória no `esquemaAmbiente`. A ordem é a do
[capítulo 02](02-configuracao-de-ambiente.md): **primeiro** a pipeline injeta
em todos os ambientes, **depois** o schema exige.
