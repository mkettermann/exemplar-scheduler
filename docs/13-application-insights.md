# 13 - Application Insights

[← Container e deploy](11-container-e-deploy.md) ·
[Índice](README.md)

## Biblioteca

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`applicationinsights`](https://learn.microsoft.com/azure/azure-monitor/app/nodejs) | `3.17.0` (fixa) | Telemetria para o Azure Application Insights: traces, exceções, eventos, métricas e dependências manuais, mais coleta automática |

A linha 3.x é uma **camada de compatibilidade** (*shim*) sobre o
[Azure Monitor OpenTelemetry](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-enable?tabs=nodejs).
A API é a do SDK clássico - `setup()`, `setAutoCollect...()`, `start()`,
`defaultClient`, `trackTrace` -, mas por baixo quem coleta e envia é o
OpenTelemetry, para o endpoint de ingestão `/v2.1/track`.

A versão é **fixa** (`3.17.0`, sem `^`) de propósito: as outras aplicações que
usam esta configuração precisam estar na mesma versão para o `operation_Id`, o
formato dos headers de correlação e os nomes da telemetria no portal serem os
mesmos. Um `^3.17.0` aceitaria as 3.x seguintes sem ninguém decidir isso - e a
própria 3.17 mudou nomes de dependência de banco num *minor*.

Até 2026-10-13 este exemplar usava a `1.8.2`. A subida para a `3.17.0` veio
depois que os sistemas criados a partir dele validaram a telemetria. O que
mudou está em [Subir a versão do pacote](#subir-a-versão-do-pacote).

## Responsabilidade

Dar aos jobs **uma única instância** do Application Insights, já configurada.
O uso principal é o `trackTrace` antes e depois de cada procedure:

```ts
import { appInsightsInstance } from '../config/appInsights.js';

appInsightsInstance.trackTrace('sp_ProcessarCobranca: iniciando');
await pool.request().execute('sp_ProcessarCobranca');
appInsightsInstance.trackTrace('sp_ProcessarCobranca: concluída');
```

Para dar visibilidade ao que cada job faz: no portal,
os pares "iniciando/concluída" mostram quando a procedure começou, quando
terminou e - pela ausência do segundo trace - onde uma execução parou.

As **exceções** dos jobs não dependem do serviço: o
[job-runner](05-scheduler.md) envia toda falha e todo timeout com
`trackException` ([Exceções dos jobs](#exceções-dos-jobs)).

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
  trackException(erro: unknown, propriedades?: Propriedades, severidade: Severidade = 3): void { }
  trackEvent(nome: string, propriedades?: Propriedades): void { }
  trackMetric(nome: string, valor: number, propriedades?: Propriedades): void { }
  trackDependency(dependencia: Dependencia): void { }
  async descarregar(): Promise<void> { }
}

export const appInsightsInstance = AppInsights.obterInstancia();
```

O construtor é privado e `obterInstancia()` devolve sempre o mesmo objeto. Não
é zelo de padrão de projeto: o SDK só admite **um** `setup()` por processo - o
segundo é ignorado ("Setup has already been called once"). Centralizar a
criação aqui impede que um job tente configurar o SDK de novo, com outras
opções, e fique achando que valeu.

Os jobs importam `appInsightsInstance` e pronto. `AppInsights` também é
exportada, mas só para os testes provarem que a instância é única.

### A chave vem do ambiente

O setup recebe `ambiente.APPINSIGHTSKEY`, validada pelo
[`esquemaAmbiente`](02-configuracao-de-ambiente.md). A 3.x **só aceita
connection string**, então o wrapper trata os dois formatos:

| Valor injetado | O que o wrapper entrega ao SDK | Para onde o SDK envia |
| --- | --- | --- |
| Connection string (`InstrumentationKey=...;IngestionEndpoint=...`) | Como veio | O endpoint regional do recurso |
| Só a iKey (um GUID) | `InstrumentationKey=<GUID>` | O endpoint global padrão (`dc.services.visualstudio.com`) |

Prefira a connection string completa: a Microsoft encerrou o suporte à
ingestão só por iKey, e o endpoint global não tem garantia de continuar
aceitando telemetria.

A variável é **opcional**. Sem ela, a instância nasce desligada: todos os
`track*` e o `descarregar` viram no-op.

É o critério do [capítulo 02](02-configuracao-de-ambiente.md) para defaults:
ausência de telemetria nunca produz dado errado, só perde visibilidade. Por
isso `npm run dev` e o vitest funcionam sem a chave. Em ambiente de deploy,
confira esse aviso no primeiro boot - ele é a única pista de que a pipeline
não injetou a variável.

Trate o valor como segredo: ele fica no variable group da pipeline, junto das
credenciais do banco, com o bloco `|-` no manifesto (o `textoObrigatorio`
recusa quebra de linha nas pontas, como nos campos de conexão).

### `cloud_RoleName`

O nome do sistema no portal - Application Map, filtros por *role*, alertas -
vem do *resource* do OpenTelemetry, e o SDK o lê da variável
**`OTEL_SERVICE_NAME`**. A leitura é automática: o `envDetector` do
`@opentelemetry/resources` a busca em `process.env` dentro do `start()`, e
nada no código precisa repassá-la. Por isso ela não passa pelo
`esquemaAmbiente` - basta estar no ambiente do processo antes do boot
(manifesto, pipeline ou o `.env` do `npm run dev`).

Sem ela, o `cloud_RoleName` fica `unknown_service:node` (o `argv0` do `CMD`
do container) - igual para todo serviço Node do recurso. Injete-a na pipeline
com o nome do sistema (`exemplar-scheduler`, no caso deste repositório). O
`cloud_RoleInstance` continua sendo o hostname - no Kubernetes, o nome do pod.

### Statsbeat desligado

A 3.x envia por padrão o **Statsbeat** - estatísticas de uso do próprio SDK
(contagem de envios, falhas, tempo de resposta, recursos ligados) - para
recursos de Application Insights **da Microsoft**, não para o deste sistema.
`iniciarCliente()` desliga isso antes do `setup()`, escrevendo duas variáveis
em `process.env`:

| Variável | O que desliga |
| --- | --- |
| `APPLICATION_INSIGHTS_NO_STATSBEAT` | **Tudo**: o exporter nasce com `trackStatsbeat = false` e o gerenciador de Statsbeat nunca é inicializado |
| `APPLICATIONINSIGHTS_STATSBEAT_DISABLED` | Só as métricas "não essenciais" (falhas de leitura e escrita do cache em disco). Sozinha, o resto continua sendo enviado |

Quem corta o envio é a primeira, embora o código do exporter a chame de
"legada". As duas ficam para o caso de uma versão futura trocar os papéis. O
exporter as lê **ao ser criado**, dentro do `start()`, e por isso a escrita
vem antes dele.

O desligamento fica no código, e não na pipeline, para valer em todo ambiente
sem depender de configuração. Para religar, apague `desligarStatsbeat()`.

Um tráfego para a Microsoft **continua**: o exporter consulta de hora em hora
`settings.sdk.monitor.azure.com` (o "OneSettings") para buscar configuração
dinâmica do SDK. É um `GET` sem dados da telemetria, e a 3.17 não tem variável
que o desligue - se a rede do cluster bloquear o domínio, o SDK segue com os
valores padrão.

### Onde a instância é criada

A criação acontece no `import`. O [entrypoint](../src/server.ts) importa
primeiro o [`ciclo-de-vida.ts`](../src/ciclo-de-vida.ts), e é este que importa
o módulo **logo depois do `env.ts`**, antes de qualquer coisa que carregue o
Fastify:

```ts
import { ambiente, ambienteAssumido } from './config/env.js';
// Antes do Fastify, para a auto-coleta enxergar o `http` - ver docs/13.
import { appInsightsInstance } from './config/appInsights.js';
```

A ordem importa. As instrumentações do OpenTelemetry funcionam interceptando o
`require` dos módulos instrumentados, como o `http`. Se o Fastify carregar o
`http` antes do `start()`, as chamadas HTTP de saída deixam de ser coletadas
como dependência - sem erro, só sem dado.

No encerramento, `descarregar()` roda depois de `fecharPoolDb()`
([capítulo 05](05-scheduler.md)): o SDK envia em lote, e sem o flush os
últimos itens - justamente os do job que o `SIGTERM` esperou terminar - se
perderiam com o processo.

O `flush()` da 3.x devolve Promise, e engole os próprios erros de rede. Mas
cada `forceFlush` do OpenTelemetry pode esperar até 30 s pelo exportador, e
são três (métricas, spans e logs) em sequência. Por isso `descarregar()` corre
o flush contra um prazo de **5 s**: se o endpoint estiver fora do ar, o
encerramento segue com um `warn`, e o que não saiu fica no cache em disco.

### Nunca derruba o job

Todo `track*` e o `descarregar` capturam qualquer erro do SDK e o registram no
[logger](03-logger.md) como `warn`. Telemetria é observação: uma falha ao
observar não pode virar falha do job observado.

## Comandos

| Método | Tabela no portal | Para quê |
| --- | --- | --- |
| `trackTrace(mensagem, severidade = 1)` | `traces` | Marco de execução: início e fim de procedure |
| `trackException(erro, propriedades?, severidade = 3)` | `exceptions` | Erro com stack. O job-runner já chama por você |
| `trackEvent(nome, propriedades?)` | `customEvents` | Ocorrência de negócio com nome próprio: "lote fechado" |
| `trackMetric(nome, valor, propriedades?)` | `customMetrics` | Número que se quer somar ou ver em gráfico: registros enviados |
| `trackDependency(dependencia)` | `dependencies` | Chamada de saída que a coleta automática não vê - procedures |

`Propriedades` é um `Record<string, string | number | boolean>` e vira
`customDimensions` no portal. Todo argumento opcional ausente é **omitido** do
item, nunca enviado como `undefined`.

### Exceções dos jobs

Antes desta versão, o erro de um job não chegava à tabela `exceptions`. O
motivo: o job-runner **captura** o erro do handler para classificar e logar
([capítulo 05](05-scheduler.md)). A coleta automática do SDK só vê exceções
**não tratadas**, e o `pino` não é coletado. A falha ficava só no
`kubectl logs`.

Agora o próprio runner envia a exceção, logo depois da linha de log:

| Desfecho | `severity` | `customDimensions` | `type` |
| --- | --- | --- | --- |
| Handler lançou | `Error` | `job`, `status: falha` | A classe do erro (`RequestError`, `Error`...) |
| Passou de `tempoLimiteMs` | `Error` | `job`, `status: timeout` | `ErroTempoLimite` |
| Handler falhou **depois** do timeout | `Warning` | `job`, `aposTimeout: true` | A classe do erro |
| O próprio runner falhou (lock) | `Critical` | `job` | A classe do erro |

Para ver as falhas de um job:

```kusto
exceptions
| where customDimensions.job == "cobranca"
| project timestamp, type, outerMessage, status = tostring(customDimensions.status)
```

O serviço, portanto, **não precisa** chamar `trackException`: basta deixar o
erro subir até o runner. Chame-o só quando o serviço **trata** o erro e segue
em frente - um registro inválido pulado no meio de um lote, por exemplo -,
porque aí o runner nunca o verá:

```ts
try {
  await enviarRegistro(registro);
} catch (error_) {
  appInsightsInstance.trackException(error_, { registro: registro.id }, 2);
  // segue para o próximo
}
```

`trackException` aceita o `unknown` do `catch` como veio. Um `throw` de algo
que não é `Error` (uma string, por exemplo) é embrulhado em `Error`, para o
portal ter mensagem e tipo.

### Dependências: procedures com `trackDependency`

O driver do SQL Server (`mssql`/`tedious`) **não é instrumentado** pela 3.x:
as procedures não aparecem sozinhas como dependência no mapa da aplicação.
Os traces antes e depois registram que ela rodou; para a duração e o sucesso
aparecerem na tabela `dependencies` - e no Application Map -, meça e envie:

```ts
const inicio = Date.now();
let sucesso = false;

try {
  await pool.request().execute('sp_ProcessarCobranca');
  sucesso = true;
} finally {
  appInsightsInstance.trackDependency({
    nome: 'sp_ProcessarCobranca',
    tipo: 'SQL',
    alvo: ambiente.DB_SERVER,
    dados: 'sp_ProcessarCobranca',
    duracaoMs: Date.now() - inicio,
    sucesso,
  });
}
```

O `alvo` é obrigatório no tipo: sem ele, o SDK tenta extrair o host de `dados`
como URL e loga um aviso a cada chamada. Com `tipo: 'SQL'`, o item aparece no
portal com o tipo `SQL`, `alvo` em `target` e `dados` em `data`.

### Eventos e métricas

`trackEvent` gera **um item por chamada**. Use para marcos de negócio que
alguém vai contar ou procurar pelo nome.

`trackMetric` não: o valor entra num histograma do OpenTelemetry, e o que chega
ao portal é o **agregado** do intervalo de exportação (60 s) - soma, contagem,
mínimo e máximo por combinação de nome e propriedades. Propriedades com
muitos valores distintos (um id por chamada) multiplicam as séries; prefira
`trackEvent` nesses casos.

## O que cada configuração faz

Os valores abaixo estão aplicados em `iniciarCliente()`. Na 3.17 todos são
respeitados - o que a versão ignora foi retirado (ver
[Subir a versão do pacote](#subir-a-versão-do-pacote)).

| Configuração | Valor | O que faz | Observação |
| --- | --- | --- | --- |
| `setInternalLogging` | `false` | Desliga o log de **debug** do próprio SDK | O log de **aviso** continua ligado, porque o segundo parâmetro (omitido) tem default `true` |
| `setSendLiveMetrics` | `false` | Não abre o canal do Live Metrics (painel em tempo real) | - |
| `setAutoDependencyCorrelation` | `true` | Liga cada dependência à operação que a originou | Na 3.x é sempre ligado (contexto do OpenTelemetry); `false` seria ignorado com aviso |
| `setAutoCollectRequests` | `false` | Não registra as requisições HTTP recebidas como `request` | Ver abaixo |
| `setAutoCollectPerformance` | `true, false` | Contadores de desempenho (CPU, memória, requisições por segundo) | O segundo parâmetro (métricas estendidas) fica `false`: a 3.x não as suporta e avisaria no boot |
| `setAutoCollectExceptions` | `true` | Envia exceções não tratadas e rejeições de Promise não tratadas | Muda o comportamento do processo - ver abaixo |
| `setAutoCollectDependencies` | `true` | Registra chamadas de saída como `dependency` | `http`/`https`, SDKs do Azure, MongoDB, MySQL, PostgreSQL e Redis. **MSSQL não está na lista** |
| `setAutoCollectConsole` | `true` | Coleta logs das bibliotecas `winston` e `bunyan` | `console.log` só entraria com um segundo `true`; o `pino` deste projeto **não** é coletado |
| `setUseDiskRetryCaching` | `true` | Guarda em disco o que não pôde ser enviado e reenvia quando a rede volta | No container o disco é efêmero: o cache só cobre quedas durante a vida do pod |
| `setAzureMonitorOptions` | `{ tracesPerSecond: 0 }` | Desliga o limitador de spans por segundo | Sem isto, o padrão de 5 spans/s tem precedência sobre `samplingPercentage` - ver abaixo |
| `config.samplingPercentage` | `100` | Percentual da telemetria que é enviado | 100% = nada é descartado por amostragem. Lido **uma vez**, dentro do `start()` |

### Por que a amostragem vem antes do `start()`

A 3.x converte o `config` em opções do OpenTelemetry **uma única vez**, dentro
do `start()`. Escrito depois dele, o `samplingPercentage` seria ignorado em
silêncio. Por isso `iniciarCliente()` o escreve entre o `setup()` e o
`start()`, e o teste confere que ele já está lá quando o `start()` roda.

### O limitador de 5 spans por segundo

O `@azure/monitor-opentelemetry` que vem com a 3.17 usa, por padrão, um
amostrador **limitado por taxa** (`tracesPerSecond: 5`), e ele tem precedência
sobre o `samplingPercentage`. É adaptativo: depois de um intervalo ocioso
aceita o primeiro span, mas numa rajada - várias procedures seguidas num job,
cada uma com seu `trackDependency` - descarta a maior parte. Logo depois do
boot, descarta até o primeiro.

`tracesPerSecond: 0` desliga o limitador e faz o `samplingPercentage = 100`
valer de novo para spans (dependências e requisições). Traces, exceções e
eventos não passam por esse amostrador.

### Requisições não são coletadas

As únicas requisições HTTP que recebe são as
probes do Kubernetes em `/health` e `/health/ready`
([capítulo 08](08-health-check.md)), a cada poucos segundos. Com
`setAutoCollectRequests(true)`, cada uma viraria um item de telemetria -
ingestão cobrada sem valor de diagnóstico.

Desligar a coleta de requisições não desliga a de dependências: as chamadas
HTTP de saída continuam registradas.

Os jobs, por outro lado, **não** são requisições: uma execução do cron não
aparece como `request` no portal. O que a torna visível são os `trackTrace`
manuais, o evento `job` que o runner envia em sucesso e, em falha, o
`trackException` do runner.

### Exceções não tratadas mudam o processo

Para coletar exceções não tratadas, a 3.x registra ouvintes em
`process.on('uncaughtException')` e `process.on('unhandledRejection')`:

- **`uncaughtException`**: o SDK envia a exceção, força o flush e chama
  `process.exit(1)`. O processo morre como antes, só um pouco depois.
- **`unhandledRejection`**: o SDK envia a exceção e **não** encerra. Sem o
  SDK, o Node 24 derrubaria o processo; com ele, o processo segue vivo.

Neste serviço, nenhum caminho conhecido gera rejeição não tratada: o
job-runner captura tudo o que o handler lança, e o `registrarJob` tem `.catch`
com `logger.fatal`. Mas uma Promise solta num serviço novo não reinicia mais o
pod - aparece só na tabela `exceptions`. A coleta também é limitada a 50
exceções por minuto; acima disso, sai um item de resumo com a contagem.

## Severidade

O parâmetro `severidade` de `trackTrace` e `trackException` segue a escala
numérica do SDK clássico. A 3.x espera o **nome**, e o wrapper converte:

| Valor | Nome enviado | Quando usar |
| --- | --- | --- |
| `0` | `Verbose` | Detalhe de diagnóstico |
| `1` | `Information` | **Padrão do `trackTrace`** - início e fim de procedure |
| `2` | `Warning` | Situação anormal contornada |
| `3` | `Error` | **Padrão do `trackException`** - falha |
| `4` | `Critical` | Falha que exige ação imediata |

A conversão não é cosmética: a 3.x usa `severity || 'Information'`, então um
`0` numérico passaria como falso e viraria `Information`. O tipo `Severidade`
aceita só `0` a `4`, então um valor fora da escala é erro de compilação.

## Convenções de uso

- **Mensagem com o nome da procedure (ou do serviço) na frente**, seguido do
  momento: `sp_X: iniciando`, `sp_X: concluída`. É o que se filtra no portal.
- **Contagens e identificadores de lote cabem; dado pessoal não.** O item sai
  do cluster e fica retido no Azure. O redact do [logger](03-logger.md) não
  alcança o Application Insights - nem mensagens, nem `propriedades`.
- **Deixe o erro subir.** O job-runner já envia a exceção com `job` e
  `status`. Um `trackException` no serviço seguido de `throw` gera dois itens
  para a mesma falha.
- **Não substitui o `logger`.** O `pino` continua sendo o log do processo, em
  `stdout`; o Application Insights recebe os marcos e as falhas. Os dois
  convivem.

O modelo em
[`example-consulta.service.ts`](../src/jobs/example-consulta/example-consulta.service.ts)
mostra o uso em volta de uma consulta
([capítulo 12](12-exemplo-job-e-servico.md)).

## Testes

[`appInsights.test.ts`](../src/config/appInsights.test.ts) substitui o SDK
inteiro por um falso e prova o wrapper:

| Asserção | Por que importa |
| --- | --- |
| Sem `APPINSIGHTSKEY`, o SDK não é inicializado e o boot avisa | A ausência é visível, não silenciosa |
| Desligado, todo `track*` e o `descarregar` não fazem nada nem lançam | Job sem telemetria continua sendo job |
| Connection string passa intacta; iKey pura vira `InstrumentationKey=<GUID>` | A 3.x só aceita connection string |
| Cada configuração é chamada uma vez, com o valor definido, antes do `start()` | A configuração inteira fica num lugar só |
| `setDistributedTracingMode` não é chamado | A 3.x o ignora e avisaria no boot |
| A amostragem já está no `config` quando o `start()` roda | A 3.x lê o `config` uma vez, dentro dele |
| As duas variáveis de Statsbeat já valem `true` quando o `start()` roda; desligado, o ambiente não é tocado | O exporter as lê ao ser criado |
| `obterInstancia()` devolve sempre a mesma instância; `setup()` roda uma vez | O SDK não admite dois setups |
| Severidade `0` a `4` vai pelo nome; o padrão é `Information` no trace e `Error` na exceção | A 3.x espera o nome |
| `trackException` converte o que não é `Error` | O `catch` entrega `unknown` |
| `trackEvent`, `trackMetric` e `trackDependency` traduzem os campos e omitem os opcionais ausentes | O contrato do SDK, com `exactOptionalPropertyTypes` |
| Erro do SDK em qualquer `track*` vira `warn`, não exceção | Telemetria não derruba job |
| `descarregar()` espera o flush, desiste em 5 s e loga falha do flush | Endpoint fora do ar não trava o encerramento |

E [`job-runner.test.ts`](../src/scheduler/job-runner.test.ts) prova que falha,
timeout, falha depois do timeout e falha do runner viram `trackException` com
`job` e `status`, que o sucesso vira o evento `job` e que sucesso e lock
ocupado não enviam exceção.

Como em [`mssql.test.ts`](../src/db/mssql.test.ts), a instância é estado de
módulo: cada teste recarrega `appInsights.ts` com `vi.resetModules()`. Que a
telemetria chegue de fato ao portal é afirmação sobre o Azure, e só se confere
num ambiente com a chave real.

## Upgrades futuros sem quebrar o que existe

**Voltar a coletar requisições** - se o serviço um dia ganhar endpoints além
do health, troque para `setAutoCollectRequests(true)` e descarte as probes. Na
3.x, o `addTelemetryProcessor` do SDK clássico **não funciona** (é no-op com
aviso): o filtro é o `ignoreIncomingRequestHook` da instrumentação `http`,
passado em `instrumentationOptions.http` dentro do mesmo
`setAzureMonitorOptions` que já leva o `tracesPerSecond: 0`. Atualize o valor
esperado em `src/config/appInsights.test.ts` e confira no portal que só as
rotas novas aparecem como `request`.

**Trace automático em todo job** - as exceções já saem do
[job-runner](05-scheduler.md). Se a convenção virar "todo job tem início e fim
no portal", o mesmo lugar serve: um `trackTrace` antes e depois do handler ali
cobre todos os jobs de uma vez. Os traces por procedure, dentro dos serviços,
continuam úteis para jobs que chamam várias.

**Tornar a chave obrigatória** - se a telemetria virar requisito em produção,
troque `.optional()` por obrigatória no `esquemaAmbiente`. A ordem é a do
[capítulo 02](02-configuracao-de-ambiente.md): **primeiro** a pipeline injeta
em todos os ambientes, **depois** o schema exige.

### Subir a versão do pacote

A versão fica fixa e sobe junto com as outras aplicações que usam esta
configuração. Subir é decisão conjunta, e não um `npm update`.

#### De `1.8.2` para `3.17.0`

A 1.8.2 é o SDK clássico: ele mesmo coletava a telemetria, aplicando patches
nos módulos via `diagnostic-channel`, e a enviava para `/v2/track`. A 3.17 é o
shim sobre o OpenTelemetry. A API é a mesma, então o código compila e sobe sem
erro - as diferenças aparecem **na telemetria**, não em exceções. Esta lista
foi levantada lendo o código das duas versões em `node_modules`, com a
configuração que `iniciarCliente()` tinha na 1.8.2:

| Configuração | Na 1.8.2 | Na 3.17 | Impacto | O que o wrapper fez |
| --- | --- | --- | --- | --- |
| `setup(chave)` | Aceita iKey pura | Só aceita connection string | iKey pura deixaria de enviar | Embrulha a iKey em `InstrumentationKey=<GUID>` |
| `setDistributedTracingMode(AI)` | Headers `Request-Id`/`Request-Context`; `operation_Id` no formato `\|abc.def.` | **Ignorado**, com aviso no boot. Só W3C (`traceparent`) | **O maior impacto.** O `operation_Id` vira hex de 32 caracteres; a correlação com serviços que só leem `Request-Id` quebra; consultas KQL e alertas que dependem do formato antigo deixam de casar | Removido - não tinha efeito |
| `setInternalLogging(false)` | Debug desligado, avisos ligados | Mesma semântica | Nenhum, com a configuração atual | - |
| `setSendLiveMetrics(false)` | Respeitado | Respeitado | Nenhum | - |
| `setAutoDependencyCorrelation(true)` | `cls-hooked` | Contexto do OpenTelemetry (`AsyncLocalStorage`), sempre ligado | Não dá mais para desligar | Mantido: documenta a intenção e não gera aviso |
| `setAutoCollectRequests(false)` | Não instrumenta requisições recebidas | Instrumenta o `http`, mas ignora as recebidas | Mesmo resultado na tabela `requests` | - |
| `setAutoCollectPerformance(true, true)` | Contadores; estendidas dependem do pacote nativo, que não estava instalado | Contadores via métricas OTel; **estendidas não suportadas**, com aviso | Sem perda. As *standard metrics* pré-agregadas passam a ser ligadas por padrão, com um pouco mais de volume | Segundo parâmetro passou a `false` |
| `setAutoCollectExceptions(true)` | `uncaughtExceptionMonitor`: só observa | `uncaughtException` + `unhandledRejection`, com limite de 50/min | **Rejeição não tratada deixa de derrubar o processo** - ver [Exceções não tratadas](#exceções-não-tratadas-mudam-o-processo) | Mantido; documentado |
| `setAutoCollectDependencies(true)` | Patches via `diagnostic-channel` | Instrumentações OTel | Nomes e tipos de dependência seguem as convenções do OpenTelemetry - e a 3.17 trocou os de banco (`mongodb.insert` → `insert <coleção>`). MSSQL continua fora | - |
| `setAutoCollectConsole(true)` | `winston`/`bunyan` | Idem | Nenhum | - |
| `setUseDiskRetryCaching(true)` | Respeitado, em `os.tmpdir()/appInsights-node<iKey>` | Respeitado (já é o default), em outro diretório | `resendInterval`/`maxBytesOnDisk` deixam de ser suportados | - |
| `config.maxBatchSize = 500` | Respeitado | **Ignorado**, com aviso | O lote passa a ser decidido pelo OpenTelemetry | Removido |
| `config.maxBatchIntervalMs = 15000` | Respeitado | Vira timeout dos exportadores OTLP, que não são usados - **sem efeito** | Os itens saem em poucos segundos, em mais requisições | Removido |
| `config.samplingPercentage = 100` | Lido a cada item | Lido **uma vez**, dentro do `start()` - e, para spans, **vencido pelo limitador de 5/s** | Dependências em rajada seriam descartadas | Mantido antes do `start()`; `setAzureMonitorOptions({ tracesPerSecond: 0 })` adicionado |

Fora das configurações:

- **`flush()`** passa a devolver Promise. O embrulho com `callback` virou
  `await cliente.flush()`, com o prazo de 5 s em volta.
- **`trackTrace`** passa a esperar a severidade pelo **nome**. O wrapper
  converte `0`–`4`.
- **`cloud_RoleName`** era fixo em `Web` na 1.8.2. Na 3.17 vem de
  `OTEL_SERVICE_NAME`; sem ela, vira `unknown_service:node`.
  Dashboards, Application Map e alertas filtrados por `cloud_RoleName == "Web"`
  quebram - injete a variável e ajuste as consultas
  (ver [`cloud_RoleName`](#cloud_rolename)).
- **Statsbeat**: a 3.x envia por padrão estatísticas de uso do SDK para a
  Microsoft. O wrapper o desliga
  (ver [Statsbeat desligado](#statsbeat-desligado)).
- **Tamanho e memória**: o `npm install` acrescentou 150 pacotes e removeu 12.
  Boot um pouco mais lento e mais memória residente.
- **`addTelemetryProcessor`** é no-op com aviso, e `context.tags` tem suporte
  parcial. Nenhum dos dois é usado hoje.
- **Node.js**: a 3.17 exige Node 22 ou superior. Este projeto já exige 24.

#### Próximas versões

1. Confirme com os donos das outras aplicações: todos sobem **juntos**.
2. Leia o `CHANGELOG.md` do pacote e o código de
   `out/src/shim/shim-config.js` - é onde cada configuração vira opção do
   OpenTelemetry, ou um aviso de "não suportado".
3. Revise consultas KQL, alertas e dashboards que dependam de nomes de
   dependência, de `operation_Id` ou de `cloud_RoleName`.
4. Ajuste o wrapper e os testes. Rode `npm run typecheck` e `npm test`, suba
   com uma chave real e confira os avisos de configuração não suportada no log
   do boot.
5. Atualize a versão aqui, no [índice](README.md), e acrescente a lista de
   impactos da versão de destino.

**Migrar para o OpenTelemetry direto** - `useAzureMonitor()` (exportado pelo
mesmo pacote) substitui o shim. Como todo o sistema importa só
`appInsightsInstance`, a troca fica dentro de `appInsights.ts`: mantenha as
assinaturas dos `track*` e o resto não percebe.
