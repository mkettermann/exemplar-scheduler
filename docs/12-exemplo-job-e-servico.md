# 12 — Exemplo de job e serviço

[← Utilitários](10-utilitarios.md) ·
[Índice](README.md)

> **Este capítulo documenta material descartável.**
> [`example.job.ts`](../src/jobs/example.job.ts),
> [`example.service.ts`](../src/services/example.service.ts),
> [`example-consulta.service.ts`](../src/services/example-consulta.service.ts)
> e **este arquivo** existem para mostrar o formato. Ao implementar o
> sistema de verdade, apague os quatro e remova a linha do índice.
>
> Jobs e serviços reais **não** ganham capítulo próprio — a documentação deles
> é o código tipado mais o comentário no topo do arquivo. O que precisa estar
> documentado é a estrutura, e ela já está nos capítulos 01 a 11.

## O par job + serviço

A estrutura separa duas responsabilidades que costumam vir misturadas no código
legado:

| Peça | Responde | Arquivo |
| --- | --- | --- |
| **Job** | *Quando* rodar, por quanto tempo, sob qual nome | `src/jobs/*.job.ts` |
| **Serviço** | *O que* fazer | `src/services/*.service.ts` |

A separação tem um efeito prático imediato: a regra de negócio fica testável sem
esperar o cron e sem subir o Fastify. É a diferença entre um teste de 3ms e um
teste que não existe.

## O serviço

```ts
// src/services/example.service.ts
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
   requisição HTTP — este serviço não tem endpoint que receba conteúdo.
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

- **URL base constante** ou vinda do `esquemaAmbiente` validado — nunca de
  parâmetro externo. Isso elimina uma classe inteira de SSRF por construção.
- **Segredo pelo `ambiente`**, nunca no código.
- **`AbortSignal.timeout`** em toda chamada de rede. O `tempoLimiteMs` do
  [job-runner](05-scheduler.md) para de *esperar*, mas não interrompe a
  chamada; só o `AbortSignal` interrompe de fato.
- **Resposta validada com zod** antes de ser usada. Um sistema externo pode
  mudar o contrato sem avisar, e o TypeScript não protege contra o que vem da
  rede — `resposta.json()` é `any`.

### Um segundo serviço: consulta ao banco

[`example-consulta.service.ts`](../src/services/example-consulta.service.ts) é o
outro modelo, e o que você vai copiar com mais frequência: ele lê o banco. Não
tem job vinculado nem teste — é material de leitura, e sai junto com os demais
exemplos.

Um serviço, uma consulta, três peças:

| Peça | Papel |
| --- | --- |
| `QUERY` | O SQL, constante do módulo |
| `montar()` | Converte a linha crua do banco no objeto de saída |
| `listarAcionamentos()` | Única função exportada: pega o pool, passa os parâmetros, devolve o resultado |

As duas internas têm nome genérico de propósito: quem abrir o próximo serviço
já sabe onde olhar sem ler o arquivo inteiro, e a forma se repete sem discussão
de nomenclatura a cada consulta nova. A exportada é a exceção, e por um motivo
prático — ela aparece fora do arquivo:

```ts
import { listarAcionamentos } from '../services/example-consulta.service.js';
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
  configuração de TLS — só o pool ([capítulo 04](04-banco-de-dados.md)).
- **Um `.input()` por parâmetro, com o tipo do driver.** É o que manda o valor
  separado do texto da query no protocolo do SQL Server. Não é escapar aspas:
  o valor nunca chega a ser texto de comando. Vale até para o `TOP`, que o
  T-SQL aceita como `TOP (@limite)` — o que elimina a desculpa mais comum para
  concatenar.
- **`QUERY` é constante do módulo.** Fica legível, e fica evidente em revisão
  que nada é montado em tempo de execução.
- **O SQL devolve linha achatada; o serviço devolve objeto.** O `LEFT JOIN`
  traz as colunas do cliente lado a lado com as do acionamento, e `montar()`
  remonta o aninhamento antes de sair do serviço.

Sobre o `WITH (NOLOCK)` da `QUERY`: é uma escolha, não um enfeite. Ele dispensa
o bloqueio de leitura — a consulta não trava a escrita da aplicação — em troca
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

`cliente` é anulável porque o `LEFT JOIN` pode não achar par — e quem chamar o
serviço é obrigado pelo compilador a tratar o acionamento órfão, em vez de
descobrir o caso em produção. Quem decide a ausência é a chave (o `ClienteID`
vindo da tabela de clientes), não o nome: nome nulo com vínculo existindo é
outra coisa, e `montar()` separa os dois casos.

Já `LinhaAcionamento` — o formato cru, com as colunas do cliente apelidadas
para não colidir com as do acionamento — não é exportado. Ele existe entre o
`.query()` e o `montar()`, e some ali.

O arquivo não tem comentário explicativo, de propósito: a explicação é este
capítulo, e o cabeçalho do serviço aponta para cá. Um modelo que só se entende
com dez linhas de comentário em volta não é um bom modelo para copiar.

## O job

```ts
// src/jobs/example.job.ts
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
erro, não mede tempo, não adquire lock, não grava histórico — o
[job-runner](05-scheduler.md) já faz tudo isso em volta.

`ambientes: ['development']` é deliberado: sendo um modelo, o exemplo não deve
disparar em nenhum ambiente compartilhado. No seu job, a lista é uma decisão de
verdade — DEV, QA e HML dividem o mesmo banco, então o mesmo job não pode
constar em dois deles. Ver [capítulo 05](05-scheduler.md), seção "Um job, um
ambiente".

Se o handler estiver com `try/catch`, medição de duração ou verificação de
"já está rodando", ele está reimplementando o runner.

## Migrando um job do repositório legado

1. **Crie o serviço** em `src/services/nome.service.ts` e cole a lógica de
   negócio lá. Tipe as entradas e saídas que antes não tinham tipo — é o
   momento em que os contratos implícitos aparecem.
2. **Crie o job** em `src/jobs/nome.job.ts`, com `executar` chamando o serviço.
3. **Declare `ambientes`** — o compilador não deixa passar sem. Se o job legado
   roda em produção e você quer validá-lo antes, use um ambiente de teste por
   vez, nunca dois que dividam banco.
4. **Ajuste `tempoLimiteMs`** para algo realista. Olhe quanto o job legado leva
   no pior dia, não na média, e dê folga.
5. **Ajuste `agendamento`**, atento ao fuso ([capítulo 05](05-scheduler.md) —
   container sem `TZ` roda em UTC).
6. **Registre** em [`src/jobs/jobs.ts`](../src/jobs/jobs.ts).
7. **Rode em dry-run** (logando o que faria, sem efeito real) em paralelo com o
   job legado por alguns ciclos. Compare os logs.
8. **Só então** desative o job no repositório legado.

O passo 7 é o que mais economiza tempo. Os dois sistemas coexistindo por
alguns dias revelam diferença de fuso, de conexão e de dado — que aparecem
sozinhas no comparativo, em vez de aparecerem como incidente.

## Checklist antes de apagar o exemplo

- [ ] `src/jobs/example.job.ts` removido
- [ ] `src/services/example.service.ts` removido
- [ ] `src/services/example-consulta.service.ts` removido
- [ ] `jobExemplo` removido do array em `src/jobs/jobs.ts`
- [ ] `docs/12-exemplo-job-e-servico.md` removido
- [ ] Linha 12 removida do índice em `docs/README.md`
- [ ] `npm run typecheck && npm test && npm run build` passando

Nada mais referencia o exemplo: ele foi mantido nas pontas da estrutura
justamente para sair sem deixar rastro.
