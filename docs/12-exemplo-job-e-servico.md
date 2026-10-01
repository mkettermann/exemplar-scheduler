# 12 - Exemplo de job e serviço

[← Utilitários](10-utilitarios.md) ·
[Índice](README.md)

> **Este capítulo documenta material descartável.**
> As pastas [`src/jobs/example/`](../src/jobs/example/),
> [`src/jobs/example-consulta/`](../src/jobs/example-consulta/) e
> [`src/jobs/example-envio/`](../src/jobs/example-envio/) e **este
> arquivo** existem para mostrar o formato. Ao implementar o sistema de
> verdade, apague os quatro, a variável `EXAMPLE_ENVIO_API_KEY` e a linha do
> índice - o [checklist](#checklist-antes-de-apagar-o-exemplo) lista tudo.
>
> Jobs e serviços reais **não** ganham capítulo próprio - a documentação deles
> é o código tipado mais o comentário no topo do arquivo. O que precisa estar
> documentado é a estrutura, e ela já está nos capítulos 01 a 11.

## O par job + serviço

A estrutura separa duas responsabilidades que costumam vir misturadas no código
legado:

| Peça | Responde | Arquivo |
| --- | --- | --- |
| **Job** | *Quando* rodar, por quanto tempo, sob qual nome | `src/jobs/<nome>/<nome>.job.ts` |
| **Serviço** | *O que* fazer | `src/jobs/<nome>/<nome>.service.ts` |
| **Teste** | Que os dois fazem o que dizem | `src/jobs/<nome>/<nome>.test.ts` |

A separação tem um efeito prático imediato: a regra de negócio fica testável sem
esperar o cron e sem subir o Fastify. É a diferença entre um teste de 3ms e um
teste que não existe.

Os três arquivos moram na mesma pasta, com o nome do job. Separar em arquivos
não é separar em lugares: quem abre a pasta vê o job inteiro, e apagar um job é
apagar uma pasta - mais a linha dele em [`jobs.ts`](../src/jobs/jobs.ts).

```text
src/jobs/
  jobs.ts                  # lista central - o boot só importa isto
  jobs.test.ts             # regras que valem para todo job da lista
  example/
    example.job.ts
    example.service.ts
    example.test.ts
```

## O serviço

```ts
// src/jobs/example/example.service.ts
const LIMITE_MEMORIA_MB = 512;

export async function coletarResumoDoProcesso(): Promise<ResumoDoProcesso> {
  const memoriaMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  return {
    uptimeSegundos: Math.floor(process.uptime()),
    memoriaMb,
    acimaDoLimite: memoriaMb > LIMITE_MEMORIA_MB,
  };
}
```

Três características que todo serviço desta estrutura compartilha:

1. **Exporta uma função com retorno tipado.** Nada de classe com estado; o
   estado compartilhado do processo mora no pool de conexão, não no serviço.
2. **As fontes de dados são declaradas aqui dentro.** `LIMITE_MEMORIA_MB` é uma
   constante do código. Poderia ser uma variável do
   [`esquemaAmbiente`](02-configuracao-de-ambiente.md) ou uma consulta ao banco
   ([capítulo 04](04-banco-de-dados.md)). O que **não** pode é vir de uma
   requisição HTTP - este serviço não tem endpoint que receba conteúdo.
3. **Não sabe que existe um job.** A função pode ser chamada por outro serviço,
   por um teste ou por vários jobs diferentes.

### Onde entra a regra dos endpoints hardcoded

O ponto de arquitetura mais importante desta estrutura
([índice](README.md#2-a-superfície-http-é-somente-leitura)): **o scheduler
nunca recebe conteúdo de fora**. Ele consulta fontes que ele próprio declara.

Quando um job precisar falar com um sistema externo, o formato é este:

```ts
// A origem é constante do código; o caminho pode variar dentro do serviço,
// nunca a partir de entrada externa.
const ERP_BASE_URL = 'https://erp.interno.empresa.com/api/v1';

export async function buscarPedidosPendentes(): Promise<Pedido[]> {
  const resposta = await fetch(`${ERP_BASE_URL}/pedidos?status=pendente`, {
    headers: { Authorization: `Bearer ${ambiente.ERP_TOKEN}` },
    // Sempre um teto: sem isso, uma chamada pendurada segura o job
    // até o tempoLimiteMs do runner, e mesmo depois continua rodando.
    signal: AbortSignal.timeout(10_000),
  });

  if (!resposta.ok) {
    throw new Error(`ERP respondeu ${resposta.status}`);
  }

  return esquemaPedido.array().parse(await resposta.json());
}
```

Quatro pontos desse trecho valem como regra geral:

- **URL base constante** ou vinda do `esquemaAmbiente` validado - nunca de
  parâmetro externo. Isso elimina uma classe inteira de SSRF por construção.
- **Segredo pelo `ambiente`**, nunca no código.
- **`AbortSignal.timeout`** em toda chamada de rede. O `tempoLimiteMs` do
  [job-runner](05-scheduler.md) para de *esperar*, mas não interrompe a
  chamada; só o `AbortSignal` interrompe de fato.
- **Resposta validada com zod** antes de ser usada. Um sistema externo pode
  mudar o contrato sem avisar, e o TypeScript não protege contra o que vem da
  rede - `resposta.json()` é `any`.

### Um segundo serviço: consulta ao banco

[`example-consulta.service.ts`](../src/jobs/example-consulta/example-consulta.service.ts)
é o outro modelo, e o que você vai copiar com mais frequência: ele lê o banco.
Não tem job vinculado - a pasta traz só o serviço e o teste dele. É material de
leitura, e sai junto com os demais exemplos.

Um serviço, uma consulta, três peças:

| Peça | Papel |
| --- | --- |
| `QUERY` | O SQL, constante do módulo |
| `montar()` | Converte a linha crua do banco no objeto de saída |
| `listarAcionamentos()` | Única função exportada: pega o pool, passa os parâmetros, devolve o resultado |

As duas internas têm nome genérico de propósito: quem abrir o próximo serviço
já sabe onde olhar sem ler o arquivo inteiro, e a forma se repete sem discussão
de nomenclatura a cada consulta nova. A exportada é a exceção, e por um motivo
prático - ela aparece fora do arquivo:

```ts
// no job da mesma pasta: src/jobs/example-consulta/example-consulta.job.ts
import { listarAcionamentos } from './example-consulta.service.js';
```

Um `listar` genérico obrigaria todo mundo a apelidar no import, ou a conviver
com uma chamada que não diz o que lista. Os tipos seguem a mesma lógica:
`AcionamentoComCliente`, `ClienteDoAcionamento` e `FiltroAcionamentos` são
específicos porque também atravessam a fronteira do módulo.

Se um dia o serviço precisar de uma segunda consulta, ele não precisa: crie
outro arquivo. Um serviço com duas funções de listagem já é dois serviços.

O corpo do `listarAcionamentos()`:

```ts
const pool = await obterPoolDb();

appInsightsInstance.trackTrace('listarAcionamentos: iniciando consulta');

const retorno = await pool
  .request()
  .input('inseridosApos', sql.DateTime2, inseridosApos)
  .input('limite', sql.Int, limite)
  .query<LinhaAcionamento>(QUERY);

appInsightsInstance.trackTrace(
  `listarAcionamentos: consulta concluída com ${retorno.recordset.length} linhas`,
);

return retorno.recordset.map(montar);
```

Os dois `trackTrace` são para dar visibilidade ao que
o job faz no Application Insights: um marco antes, outro depois, com o nome do
serviço na frente. A severidade é omitida e vale o padrão `1`
(`Information`). O que cada configuração do SDK faz está no
[capítulo 13](13-application-insights.md).

Quatro decisões que valem como regra para qualquer consulta desta estrutura:

- **A conexão vem de `obterPoolDb()`.** O serviço não conhece host, usuário nem
  configuração de TLS - só o pool ([capítulo 04](04-banco-de-dados.md)).
- **Um `.input()` por parâmetro, com o tipo do driver.** É o que manda o valor
  separado do texto da query no protocolo do SQL Server. Não é escapar aspas:
  o valor nunca chega a ser texto de comando. Vale até para o `TOP`, que o
  T-SQL aceita como `TOP (@limite)` - o que elimina a desculpa mais comum para
  concatenar.
- **`QUERY` é constante do módulo.** Fica legível, e fica evidente em revisão
  que nada é montado em tempo de execução.
- **O SQL devolve linha achatada; o serviço devolve objeto.** O `LEFT JOIN`
  traz as colunas do cliente lado a lado com as do acionamento, e `montar()`
  remonta o aninhamento antes de sair do serviço.

Sobre o `WITH (NOLOCK)` da `QUERY`: é uma escolha, não um enfeite. Ele dispensa
o bloqueio de leitura - a consulta não trava a escrita da aplicação - em troca
de poder ler linha que ainda vai ser revertida. Serve para relatório e
apuração; não serve para nada que decida escrita ou valor financeiro.

O tipo do resultado carrega o que o `LEFT JOIN` significa:

```ts
export interface AcionamentoComCliente {
  clienteId: number;
  notas: string | null;
  inseridoEm: Date;
  cliente: ClienteDoAcionamento | null;
}
```

`cliente` é anulável porque o `LEFT JOIN` pode não achar par - e quem chamar o
serviço é obrigado pelo compilador a tratar o acionamento órfão, em vez de
descobrir o caso em produção. Quem decide a ausência é a chave (o `ClienteID`
vindo da tabela de clientes), não o nome: nome nulo com vínculo existindo é
outra coisa, e `montar()` separa os dois casos.

Já `LinhaAcionamento` - o formato cru, com as colunas do cliente apelidadas
para não colidir com as do acionamento - não é exportado. Ele existe entre o
`.query()` e o `montar()`, e some ali.

O arquivo não tem comentário explicativo, de propósito: a explicação é este
capítulo, e o cabeçalho do serviço aponta para cá. Um modelo que só se entende
com dez linhas de comentário em volta não é um bom modelo para copiar.

### Um terceiro serviço: POST autenticado

[`example-envio.service.ts`](../src/jobs/example-envio/example-envio.service.ts)
aplica a [regra dos endpoints hardcoded](#onde-entra-a-regra-dos-endpoints-hardcoded)
ao caso mais comum de integração: o parceiro exige trocar uma apiKey por um
token temporário antes de aceitar o POST. Como o `example-consulta`, a pasta
traz só o serviço e o teste.

Um serviço, um envio, duas chamadas:

| Peça | Papel |
| --- | --- |
| `URL_AUTENTICACAO`, `URL_ENVIO` | As duas origens, constantes do módulo |
| `esquemaAutenticacao`, `esquemaResultado` | O contrato de cada resposta, em zod |
| `autenticar()` | Troca a apiKey pelo token - interna |
| `enviarRegistro()` | Única função exportada: autentica, faz o POST com o token no header `token-id`, devolve o resultado validado |

```ts
const token = await autenticar();

const resposta = await fetch(URL_ENVIO, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'token-id': token },
  body: JSON.stringify(registro),
  signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
});
```

Decisões que valem para qualquer integração desta forma:

- **As URLs são fixas; a apiKey não está no código.** A chave é igualmente
  fixa - não muda entre execuções -, mas é segredo, e segredo vem do
  [`ambiente`](02-configuracao-de-ambiente.md) validado. Aqui ela é
  `EXAMPLE_ENVIO_API_KEY`, opcional no schema para não exigir o valor de
  quem não roda o exemplo; sem ela, o serviço falha **antes** de qualquer
  chamada de rede, com mensagem que nomeia a variável. Num serviço real, a
  variável é obrigatória e derruba o boot.
- **O token é pedido a cada envio, nunca guardado.** Ele é temporário, e
  guardá-lo exigiria estado no módulo mais a lógica de expiração e de
  renovação no `401` - para economizar uma chamada a cada ciclo do cron. Só
  vale a pena quando o parceiro limita a emissão de tokens ou o job envia
  muitos registros por execução; nesse caso, autentique uma vez no início da
  execução e passe o token adiante, ainda sem guardá-lo entre execuções.
- **Cada chamada tem o seu `AbortSignal.timeout`.** São duas chamadas de rede,
  e qualquer uma pode pendurar.
- **Autenticação recusada para tudo.** O erro sobe com o status e o POST
  principal não acontece. Nenhuma mensagem de erro ou `trackTrace` leva a
  apiKey ou o token: o trace sai do cluster
  ([capítulo 13](13-application-insights.md)) e a mensagem de erro chega ao
  log do [job-runner](05-scheduler.md).
- **Resposta `2xx` fora do contrato é falha.** Um envio aceito sem
  `protocolo` não tem como ser conferido depois; o zod o transforma em erro em
  vez de sucesso silencioso.

O formato do corpo da autenticação (`{ apiKey }`) e das respostas
(`{ token }`, `{ protocolo }`) é ilustrativo: ajuste os dois esquemas e o
`JSON.stringify` ao contrato do parceiro real.

Sobre idempotência: diferente da consulta, este serviço **escreve** num sistema
externo. Um job que o chame precisa tolerar a reexecução que o
[lock](06-lock-distribuido.md) não impede - marcando o que já foi enviado, ou
contando com uma chave de deduplicação aceita pelo parceiro.

## O job

```ts
// src/jobs/example/example.job.ts
export const jobExemplo: DefinicaoJob = {
  nome: 'example-job',
  ambientes: ['development'],
  agendamento: '*/5 * * * *',
  tempoLimiteMs: 30_000,
  executar: async () => {
    const resumo = await coletarResumoDoProcesso();
    logger.info({ resumo }, 'example-job executado');
  },
};
```

O `executar` faz duas coisas: chama o serviço e loga o resultado. Não trata
erro, não mede tempo, não adquire lock, não grava histórico - o
[job-runner](05-scheduler.md) já faz tudo isso em volta.

`ambientes: ['development']` é deliberado: sendo um modelo, o exemplo não deve
disparar em nenhum ambiente compartilhado. No seu job, a lista é uma decisão de
verdade - DEV, QA e HML dividem o mesmo banco, então o mesmo job não pode
constar em dois deles. Ver [capítulo 05](05-scheduler.md), seção "Um job, um
ambiente".

Se o handler estiver com `try/catch`, medição de duração ou verificação de
"já está rodando", ele está reimplementando o runner.

## Os testes do exemplo

Cada pasta de exemplo vem com **um** arquivo de teste, no mesmo espírito
descartável:

| Teste | O que mostra |
| --- | --- |
| [`example/example.test.ts`](../src/jobs/example/example.test.ts) | Serviço sem banco (controla a entrada e verifica o resultado) e job (ambientes, agendamento, registro na lista e a execução passando pelo serviço) - lock e timeout ficam com o runner |
| [`example-consulta/example-consulta.test.ts`](../src/jobs/example-consulta/example-consulta.test.ts) | Serviço com banco: mocka `mssql.ts`, verifica parâmetros, defaults e mapeamento |
| [`example-envio/example-envio.test.ts`](../src/jobs/example-envio/example-envio.test.ts) | Serviço com sistema externo: troca o `fetch` global por `vi.stubGlobal`, verifica a ordem das chamadas, o `token-id` e a recusa de resposta fora do contrato |

Job e serviço dividem o arquivo, e por isso o mock fica só na fronteira de
infraestrutura - logger, `mssql.ts`, `fetch`, Application Insights -, nunca no
serviço. Um `vi.mock` vale para o arquivo inteiro: mockar o serviço para
testar o job esvaziaria os testes do próprio serviço. O teste do job, então,
controla a mesma entrada que o do serviço e verifica o que o job faz com o
resultado. Mais em [capítulo 09](09-testes.md#onde-os-testes-moram).

Copie-os junto com o código.

## Migrando um job do repositório legado

1. **Crie a pasta** `src/jobs/nome/` e, nela, o serviço `nome.service.ts`
   com a lógica de negócio. Tipe as entradas e saídas que antes não tinham
   tipo - é o momento em que os contratos implícitos aparecem.
2. **Crie o job** em `src/jobs/nome/nome.job.ts`, com `executar` chamando o
   serviço, e o teste em `src/jobs/nome/nome.test.ts`.
3. **Declare `ambientes`** - o compilador não deixa passar sem. Se o job legado
   roda em produção e você quer validá-lo antes, use um ambiente de teste por
   vez, nunca dois que dividam banco.
4. **Ajuste `tempoLimiteMs`** para algo realista. Olhe quanto o job legado leva
   no pior dia, não na média, e dê folga.
5. **Ajuste `agendamento`**, atento ao fuso ([capítulo 05](05-scheduler.md) -
   container sem `TZ` roda em UTC).
6. **Registre** em [`src/jobs/jobs.ts`](../src/jobs/jobs.ts).
7. **Rode em dry-run** (logando o que faria, sem efeito real) em paralelo com o
   job legado por alguns ciclos. Compare os logs.
8. **Só então** desative o job no repositório legado.

O passo 7 é o que mais economiza tempo. Os dois sistemas coexistindo por
alguns dias revelam diferença de fuso, de conexão e de dado - que aparecem
sozinhas no comparativo, em vez de aparecerem como incidente.

## Checklist antes de apagar o exemplo

- [ ] `jobExemplo` e o import dele removidos de `src/jobs/jobs.ts`
- [ ] Pastas `src/jobs/example/`, `src/jobs/example-consulta/` e
  `src/jobs/example-envio/` removidas, com os testes dentro - copie os
  `*.test.ts` antes, como ponto de partida dos testes do seu job
- [ ] `EXAMPLE_ENVIO_API_KEY` removida de `src/config/env.ts`, do
  `.env.example` e da tabela do [capítulo 02](02-configuracao-de-ambiente.md)
- [ ] `docs/12-exemplo-job-e-servico.md` removido
- [ ] Linha 12 removida do índice em `docs/README.md`
- [ ] `npm run typecheck && npm test && npm run build` passando

Nada mais referencia o exemplo: ele foi mantido nas pontas da estrutura
justamente para sair sem deixar rastro.
