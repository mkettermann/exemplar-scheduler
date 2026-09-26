# 13 — Application Insights

[← Container e deploy](11-container-e-deploy.md) ·
[Índice](README.md)

## Biblioteca

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`applicationinsights`](https://learn.microsoft.com/azure/azure-monitor/app/nodejs) | `1.8.2` (fixa) | Telemetria para o Azure Application Insights: traces manuais e coleta automática |

É o **SDK clássico**: ele mesmo coleta a telemetria, aplicando patches nos
módulos via `diagnostic-channel`, e a envia em lotes para o endpoint de
ingestão (`/v2/track`). Não há OpenTelemetry por baixo.

A versão é **fixa** (`1.8.2`, sem `^`) de propósito: é a mesma das outras
aplicações que usam esta configuração. Com ela, cada opção de
`iniciarCliente()` faz o que o nome diz, e o `operation_Id`, o formato dos
headers de correlação e os nomes da telemetria no portal são os mesmos. Consultas,
alertas e dashboards funcionam do mesmo jeito para todos os sistemas. Um
`^1.8.2` aceitaria as 1.8.x seguintes sem ninguém decidir isso.

A linha 3.x foi usada aqui antes, e o downgrade foi deliberado. O que muda ao
subir está em [Subir a versão do pacote](#subir-a-versão-do-pacote).

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
segundo é ignorado ("The default client is already setup"). Centralizar a
criação aqui impede que um job tente configurar o SDK de novo, com outras
opções, e fique achando que valeu.

Os jobs importam `appInsightsInstance` e pronto. `AppInsights` também é
exportada, mas só para os testes provarem que a instância é única.

### A chave vem do ambiente

O setup recebe `ambiente.APPINSIGHTSKEY`, validada pelo
[`esquemaAmbiente`](02-configuracao-de-ambiente.md), **como veio**. O SDK
1.8.2 aceita os dois formatos:

| Valor injetado | Para onde o SDK envia |
| --- | --- |
| Connection string (`InstrumentationKey=...;IngestionEndpoint=...`) | O endpoint regional do recurso |
| Só a iKey (um GUID) | O endpoint global padrão (`dc.services.visualstudio.com`) |

Prefira a connection string completa: a Microsoft encerrou o suporte à
ingestão só por iKey, e o endpoint global não tem garantia de continuar
aceitando telemetria.

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

A criação acontece no `import`. O [entrypoint](../src/server.ts) importa
primeiro o [`ciclo-de-vida.ts`](../src/ciclo-de-vida.ts), e é este que importa
o módulo **logo depois do `env.ts`**, antes de qualquer coisa que carregue o
Fastify:

```ts
import { ambiente, ambienteAssumido } from './config/env.js';
// Antes do Fastify, para a auto-coleta enxergar o `http` — ver docs/13.
import { appInsightsInstance } from './config/appInsights.js';
```

A ordem importa. A coleta automática funciona interceptando o `require` dos
módulos instrumentados, como o `http`. Se o Fastify carregar o `http` antes do
`start()`, as chamadas HTTP de saída deixam de ser coletadas como dependência
— sem erro, só sem dado.

No encerramento, `descarregar()` roda depois de `fecharPoolDb()`
([capítulo 05](05-scheduler.md)): o SDK envia em lote, e sem o flush os
últimos traces — justamente os do job que o `SIGTERM` esperou terminar — se
perderiam com o processo.

O `flush()` do 1.8.2 não devolve Promise: recebe um `callback`, que o SDK chama
tanto com a resposta da ingestão quanto com a mensagem do erro de rede. O
`descarregar()` embrulha esse callback numa Promise, e por isso um endpoint
fora do ar não trava o encerramento.

### Nunca derruba o job

`trackTrace` e `descarregar` capturam qualquer erro do SDK e o registram no
[logger](03-logger.md) como `warn`. Telemetria é observação: uma falha ao
observar não pode virar falha do job observado.

## O que cada configuração faz

Os valores abaixo estão aplicados em `iniciarCliente()`. No SDK 1.8.2 todos
são respeitados; a última coluna traz o detalhe de cada um.

| Configuração | Valor | O que faz | Observação |
| --- | --- | --- | --- |
| `setDistributedTracingMode` | `0` (`AI`) | Propaga só os headers de correlação próprios do Application Insights (`Request-Id`, `Request-Context`), sem o padrão W3C | É o padrão da 1.x. O `operation_Id` fica no formato hierárquico (`\|abc.def.`) |
| `setInternalLogging` | `false` | Desliga o log de **debug** do próprio SDK | O log de **aviso** continua ligado, porque o segundo parâmetro (omitido) tem default `true` |
| `setSendLiveMetrics` | `false` | Não abre o canal do Live Metrics (painel em tempo real) | — |
| `setAutoDependencyCorrelation` | `true` | Liga cada dependência à operação que a originou | Usa `cls-hooked` sobre `async_hooks` |
| `setAutoCollectRequests` | `false` | Não registra as requisições HTTP recebidas como `request` | Ver abaixo |
| `setAutoCollectPerformance` | `true, true` | Contadores de desempenho (CPU, memória, requisições por segundo) a cada 60 s; o segundo `true` pede as métricas estendidas | As estendidas (GC, event loop, heap) exigem o pacote opcional `applicationinsights-native-metrics`, que **não está instalado**: sem ele, o SDK não coleta nada e não avisa |
| `setAutoCollectExceptions` | `true` | Envia exceções não tratadas e rejeições de Promise não tratadas | No Node 24 usa `uncaughtExceptionMonitor`: observa, mas não muda o comportamento do processo |
| `setAutoCollectDependencies` | `true` | Registra chamadas de saída como `dependency` | `http`/`https`, SDKs do Azure, MongoDB, MySQL, PostgreSQL e Redis. **MSSQL não está na lista** |
| `setAutoCollectConsole` | `true` | Coleta logs das bibliotecas `winston` e `bunyan` | `console.log` só entraria com um segundo `true`; o `pino` deste projeto **não** é coletado |
| `setUseDiskRetryCaching` | `true` | Guarda em disco o que não pôde ser enviado e reenvia quando a rede volta | Em `os.tmpdir()/appInsights-node<iKey>`. No container o disco é efêmero: o cache só cobre quedas durante a vida do pod |
| `config.maxBatchSize` | `500` | Tamanho máximo do lote enviado de uma vez | O default é `250` |
| `config.maxBatchIntervalMs` | `15000` | Intervalo máximo entre envios | É o default; um trace leva até 15 s para sair do processo |
| `config.samplingPercentage` | `100` | Percentual da telemetria que é enviado | 100% = nada é descartado por amostragem |

### Por que as três últimas vêm antes do `start()`

No 1.8.2 o canal de envio lê `maxBatchSize` e `maxBatchIntervalMs` **a cada
envio**, e a amostragem é avaliada a cada item. Tecnicamente, escrevê-los
depois do `start()` também funcionaria. `iniciarCliente()` os escreve entre o
`setup()` e o `start()` para a configuração inteira ficar num lugar só — e
porque essa ordem continua correta numa versão futura, em que o `start()` lê
tudo de uma vez (ver [Subir a versão do pacote](#subir-a-versão-do-pacote)).

### Requisições não são coletadas

As únicas requisições HTTP que recebe são as
probes do Kubernetes em `/health` e `/health/ready`
([capítulo 08](08-health-check.md)), a cada poucos segundos. Com
`setAutoCollectRequests(true)`, cada uma viraria um item de telemetria —
ingestão cobrada sem valor de diagnóstico.

Desligar a coleta de requisições não desliga a de dependências: as chamadas
HTTP de saída continuam registradas.

Os jobs, por outro lado, **não** são requisições: uma execução do cron não
aparece como `request` no portal. O que a torna visível são justamente os
`trackTrace` manuais.

### Dependências: por que o `trackTrace` é necessário

O driver do SQL Server (`mssql`/`tedious`) **não é instrumentado** pelo 1.8.2.
O pacote `diagnostic-channel-publishers` até traz um publisher para o
`tedious`, mas só para as versões 6 a 8 — o `mssql` 11 usa o `tedious` 18 — e
o SDK não assina esse canal. As procedures, portanto, não aparecem sozinhas
como dependência no mapa da aplicação: os traces antes e depois são o único
registro delas no Application Insights.

## Severidade

O segundo parâmetro de `trackTrace` é opcional e segue a escala numérica do
`SeverityLevel` do SDK, repassada sem conversão. O padrão é **`1`**:

| Valor | Nome no portal | Quando usar |
| --- | --- | --- |
| `0` | `Verbose` | Detalhe de diagnóstico |
| `1` | `Information` | **Padrão** — início e fim de procedure |
| `2` | `Warning` | Situação anormal contornada |
| `3` | `Error` | Falha |
| `4` | `Critical` | Falha que exige ação imediata |

O tipo `Severidade` aceita só `0` a `4`, então um valor fora da escala é erro
de compilação.

Para registrar a falha de uma procedure no portal, trace e **relance** — quem
classifica e loga a falha do job continua sendo o
[job-runner](05-scheduler.md):

```ts
try {
  await pool.request().execute('sp_ProcessarCobranca');
} catch (error_) {
  appInsightsInstance.trackTrace('sp_ProcessarCobranca: falhou', 3);
  throw error_;
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
inteiro por um falso e prova o wrapper:

| Asserção | Por que importa |
| --- | --- |
| Sem `APPINSIGHTSKEY`, o SDK não é inicializado e o boot avisa | A ausência é visível, não silenciosa |
| Desligado, `trackTrace` e `descarregar` não fazem nada nem lançam | Job sem telemetria continua sendo job |
| Connection string e iKey pura passam intactas | O SDK 1.8.2 aceita os dois formatos |
| Cada configuração é chamada uma vez, com o valor definido, antes do `start()` | A configuração inteira fica num lugar só |
| Lote e amostragem já estão no `config` quando o `start()` roda | Mesmo motivo — e a ordem que uma versão futura exige |
| `obterInstancia()` devolve sempre a mesma instância; `setup()` roda uma vez | O SDK não admite dois setups |
| Sem severidade, o trace vai como `1`; `0` a `4` passam como vieram | O padrão `Information` e o `SeverityLevel` do SDK |
| O `descarregar()` espera o callback do `flush`, inclusive quando ele traz erro de rede | Endpoint fora do ar não trava o encerramento |
| Erro do SDK no trace ou no flush vira `warn`, não exceção | Telemetria não derruba job nem encerramento |

Como em [`mssql.test.ts`](../test/mssql.test.ts), a instância é estado de
módulo: cada teste recarrega `appInsights.ts` com `vi.resetModules()`. Que a telemetria
chegue de fato ao portal é afirmação sobre o Azure, e só se confere num
ambiente com a chave real.

## Upgrades futuros sem quebrar o que existe

**Voltar a coletar requisições** — se o serviço um dia ganhar endpoints além
do health, troque para `setAutoCollectRequests(true)` e descarte as probes
com um telemetry processor, registrado antes do `start()`:

```ts
cliente.addTelemetryProcessor((envelope) => {
  const dados = envelope.data as { baseType?: string; baseData?: { url?: string } };
  const ehProbe = dados.baseType === 'RequestData' && dados.baseData?.url?.includes('/health');
  return !ehProbe;
});
```

Atualize o valor esperado em `test/app-insights.test.ts` e confira no portal
que só as rotas novas aparecem como `request`.

**Trace automático em todo job** — se a convenção virar "todo job tem início e
fim no portal", o lugar é o [job-runner](05-scheduler.md), que já envolve cada
execução com lock, prazo e log. Um `trackTrace` antes e depois do handler ali
cobre todos os jobs de uma vez. Os traces por procedure, dentro dos serviços,
continuam úteis para jobs que chamam várias.

**Tornar a chave obrigatória** — se a telemetria virar requisito em produção,
troque `.optional()` por obrigatória no `esquemaAmbiente`. A ordem é a do
[capítulo 02](02-configuracao-de-ambiente.md): **primeiro** a pipeline injeta
em todos os ambientes, **depois** o schema exige.

### Subir a versão do pacote

A versão fica fixa enquanto as outras aplicações usarem a 1.8.2. Subir é
decisão conjunta, e não um `npm update`: a 3.x troca a engine inteira.

A linha 3.x é uma **camada de compatibilidade** (*shim*) sobre o
[Azure Monitor OpenTelemetry](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-enable?tabs=nodejs).
A API é a mesma — `setup()`, `setAutoCollect...()`, `start()`,
`defaultClient` —, então o código compila e sobe sem erro. As diferenças
aparecem **na telemetria**, não em exceções. Esta lista foi levantada contra a
3.16.0, mantendo exatamente a configuração de `iniciarCliente()`:

| Configuração | Na 1.8.2 | Na 3.16 | Impacto |
| --- | --- | --- | --- |
| `setup(chave)` | Aceita iKey pura | Só aceita connection string | O wrapper precisa embrulhar a iKey em `InstrumentationKey=<GUID>` |
| `setDistributedTracingMode(AI)` | Headers `Request-Id`/`Request-Context`; `operation_Id` no formato `\|abc.def.` | **Ignorado**, com aviso no boot. Só W3C (`traceparent`) | **O maior impacto.** O `operation_Id` vira hex de 32 caracteres; a correlação com serviços que só leem `Request-Id` quebra; consultas KQL e alertas que dependem do formato antigo deixam de casar |
| `setInternalLogging(false)` | Debug desligado, avisos ligados | Mesma semântica | Aparecem avisos novos no boot (modo AI, métricas estendidas, `maxBatchSize`) |
| `setSendLiveMetrics(false)` | Respeitado | Respeitado | Nenhum |
| `setAutoDependencyCorrelation(true)` | `cls-hooked` | Contexto do OpenTelemetry (`AsyncLocalStorage`), sempre ligado | Não dá mais para desligar |
| `setAutoCollectRequests(false)` | Não instrumenta requisições recebidas | Instrumenta o `http`, mas ignora as recebidas | Mesmo resultado na tabela `requests` |
| `setAutoCollectPerformance(true, true)` | Contadores; estendidas dependem do pacote nativo | Contadores via métricas OTel; **estendidas não suportadas** | Sem perda, já que o pacote nativo não está instalado. As *standard metrics* pré-agregadas passam a ser ligadas por padrão, com um pouco mais de volume |
| `setAutoCollectExceptions(true)` | `uncaughtExceptionMonitor` | Idem | Nenhum relevante |
| `setAutoCollectDependencies(true)` | Patches via `diagnostic-channel` | Instrumentações OTel | Nomes e tipos de dependência mudam para as convenções do OpenTelemetry. MSSQL continua fora |
| `setAutoCollectConsole(true)` | `winston`/`bunyan` | Idem | Nenhum |
| `setUseDiskRetryCaching(true)` | Respeitado | Respeitado (já é o default), em outro diretório | `resendInterval`/`maxBytesOnDisk` deixam de ser suportados |
| `config.maxBatchSize = 500` | Respeitado | **Ignorado**, com aviso | O lote passa a ser decidido pelo OpenTelemetry |
| `config.maxBatchIntervalMs = 15000` | Respeitado | Vira timeout dos exportadores OTLP — **sem efeito** | Os traces passam a sair em poucos segundos, em mais requisições |
| `config.samplingPercentage = 100` | Lido a cada item | Lido **uma vez**, dentro do `start()` | Só vale se escrito antes do `start()` — a ordem atual já cobre isso |

Fora das configurações:

- **`flush()`** passa a devolver Promise. O embrulho com `callback` em
  `descarregar()` precisa virar `await cliente.flush()`.
- **`trackTrace`** passa a esperar a severidade pelo **nome** (`'Information'`),
  não pelo número. O wrapper precisa converter `0`–`4` para os nomes.
- **`cloud_RoleName`** passa a vir do *resource* do OpenTelemetry
  (`service.name`). Sem `OTEL_SERVICE_NAME`, o valor tende a ser genérico, e
  dashboards, Application Map e alertas filtrados por role name quebram.
- **Statsbeat**: a 3.x envia por padrão estatísticas de uso do SDK para a
  Microsoft. Pode ser desligado por variável de ambiente, se a política exigir.
- **Tamanho e memória**: a árvore de dependências do OpenTelemetry é bem
  maior — boot um pouco mais lento e mais memória residente.
- **`addTelemetryProcessor`** e `context.tags` têm suporte parcial no shim.
  Qualquer uso deles precisa ser revalidado.

Roteiro, quando a decisão for tomada:

1. Confirme com os donos das outras aplicações: o modo de correlação e o
   formato do `operation_Id` precisam mudar **junto** em todos os sistemas que
   conversam entre si.
2. Revise consultas KQL, alertas e dashboards que dependam do formato antigo
   do `operation_Id`, de `Request-Id` ou de `cloud_RoleName`.
3. Ajuste o wrapper (`setup`, severidade, `flush`) e os testes.
4. Rode `npm run typecheck` e `npm test`, suba com uma chave real e confira os
   avisos de configuração não suportada no log do boot.
5. Atualize a versão aqui, no [índice](README.md) e esta lista de impactos
   com o que a versão de destino fizer de diferente.

**Migrar para o OpenTelemetry direto** — na 3.x, `useAzureMonitor()`
(exportado pelo mesmo pacote) substitui o shim. Como todo o sistema importa só
`appInsightsInstance`, a troca fica dentro de `appInsights.ts`: mantenha a
assinatura `trackTrace(mensagem, severidade = 1)` e o resto não percebe.
