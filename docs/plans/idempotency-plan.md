# Plano - Idempotência de efeitos externos

[Índice](../README.md) ·
[Lock distribuído](../06-lock-distribuido.md) ·
[Exemplo de job e serviço](../12-exemplo-job-e-servico.md)

> **Este arquivo é um plano, não um capítulo.** Ele descreve o que será
> construído e por quê. Quando a implementação terminar, o conteúdo
> permanente vira o capítulo `15-idempotencia.md` e este arquivo é apagado.

## O problema

Um job que **escreve fora do banco** - emitir boleto, enviar e-mail, mandar
registro a um parceiro - não pode produzir o mesmo efeito duas vezes. O
[lock distribuído](../06-lock-distribuido.md) resolve só uma parte disso:

| Cenário | O lock impede? | Resultado sem idempotência |
| --- | --- | --- |
| Dois pods disparam o mesmo job **ao mesmo tempo** (rolling update) | sim | - |
| O pod novo dispara a mesma ocorrência **logo depois** que o antigo terminou | não | boleto emitido duas vezes |
| A transferência continua "pendente" na origem e o próximo ciclo a lista de novo | não | boleto emitido a cada ciclo |
| O parceiro emitiu, mas a resposta não voltou (timeout, conexão caída) | não | o job falha, o próximo ciclo emite de novo |
| O processo morre entre a emissão e o registro dela | não | o próximo ciclo emite de novo |

O contrato de [`job.types.ts`](../../src/scheduler/job.types.ts) já exige
handlers idempotentes. Este plano entrega a peça que torna isso viável para
efeitos externos: uma **chave de idempotência gravada no banco antes do
efeito**, com o desfecho registrado depois.

Exemplo guia: emitir o boleto de uma transferência, com a chave
`emite:${clienteId}:${transferenciaId}`.

## Por que não uma transação em volta da chamada

A primeira ideia foi abrir uma transação, inserir a chave, chamar o parceiro
e só então dar `commit`. Ela foi descartada por três motivos:

1. **O banco não desfaz o boleto.** Se o parceiro emite e o `commit` falha,
   ou se o timeout estoura no cliente depois que o parceiro já emitiu, o
   `rollback` apaga a chave - e o próximo ciclo emite de novo. A transação
   trata "não sei se aconteceu" como "não aconteceu", que é o único erro que
   não se pode cometer aqui.
2. **Transação aberta durante uma chamada HTTP.** Ela segura uma conexão do
   pool (que já perde uma por job para o lock -
   [capítulo 04](../04-banco-de-dados.md)) e o lock da linha. Uma segunda
   tentativa na mesma chave fica bloqueada esperando, em vez de pular.
3. **A concorrência já está coberta.** O `sp_getapplock` impede que dois
   processos rodem o mesmo job juntos. O que falta é memória **entre**
   execuções, e isso só existe se a chave sobreviver ao fim da execução.

## O desenho: reivindicar, executar, registrar

```text
             INSERT chave (PROCESSANDO)  ── chave duplicada ──> pula: já reivindicada
                       │ commit imediato
                       v
              ação externa (POST ao parceiro)
             ┌─────────┼──────────────────────────┐
         sucesso   falha sem efeito        falha ambígua / qualquer outra
             │         │                          │
             v         v                          v
   UPDATE CONCLUIDO   DELETE da chave       UPDATE INCERTO
   + resultado        (libera nova          (bloqueia até
                      tentativa)             conciliação)
```

Cada fase é um comando isolado, em autocommit. Nenhuma transação fica aberta
durante a chamada externa.

### Os estados da chave

| Status | Significa | Próxima execução com a mesma chave |
| --- | --- | --- |
| *(sem linha)* | Nunca tentado, ou falhou sem efeito | Executa |
| `PROCESSANDO` | Uma instância está executando agora - ou morreu no meio | Pula |
| `CONCLUIDO` | O efeito aconteceu; `Resultado` guarda a prova (ex.: protocolo) | Pula |
| `INCERTO` | A ação falhou sem garantia de que nada aconteceu do outro lado | Pula, até conciliação humana |

`PROCESSANDO` antigo (mais velho que o `tempoLimiteMs` do job) é, na prática,
`INCERTO`: o processo morreu sem registrar o desfecho. A conciliação trata os
dois juntos.

### A regra de classificação: na dúvida, incerto

O helper não sabe o que cada parceiro quer dizer com cada status. Por isso o
padrão é o lado seguro:

- **Qualquer erro** lançado pela ação marca a chave como `INCERTO`.
- Só um erro do tipo **`ErroSemEfeito`** apaga a chave. O serviço lança esse
  tipo quando tem certeza de que o parceiro recusou **antes** de processar.

Errar a classificação para o lado de `INCERTO` custa uma conciliação manual.
Errar para o lado de `ErroSemEfeito` custa um boleto duplicado. A assimetria
justifica o padrão.

Classificação proposta para o exemplo de emissão (ajustar ao contrato de cada
parceiro real):

| Resposta do `Rest` | Classe | Por quê |
| --- | --- | --- |
| `2xx` dentro do contrato | sucesso → `CONCLUIDO` | - |
| `2xx` fora do contrato | `INCERTO` | O parceiro aceitou; só não sabemos o protocolo |
| `400`, `401`, `403`, `404`, `422`, `429` | `ErroSemEfeito` | Recusa antes de processar |
| `408`, `409`, `5xx` | `INCERTO` | O servidor pode ter processado antes de falhar; `409` costuma significar "já existe" |
| `status 0` (tempo esgotado, abortada, erro de conexão) | `INCERTO` | O `Rest` não separa "não chegou" de "chegou e a resposta se perdeu" |

## Peças a criar e alterar

| Arquivo | Mudança |
| --- | --- |
| `sql/001-idempotencia.sql` | **Novo.** DDL da tabela - executado pela pipeline ou pelo DBA, nunca pelo serviço |
| [`src/config/env.ts`](../../src/config/env.ts) | Quatro variáveis `IDEMPOTENCY_*` com default e validação de identificador |
| `src/config/instancia.ts` | **Novo.** `getUuidInstancia()` - um `randomUUID()` gerado uma vez por processo |
| [`src/ciclo-de-vida.ts`](../../src/ciclo-de-vida.ts) | Loga o UUID da instância no boot, para correlacionar com o pod |
| `src/shared/uteis/idempotencia_uteis.ts` | **Novo.** `executarIdempotente()`, `ErroSemEfeito` e os tipos |
| `src/shared/uteis/idempotencia_uteis.test.ts` | **Novo.** Testes do helper com `mssql.ts` mockado |
| [`src/jobs/example-envio/example-envio.service.ts`](../../src/jobs/example-envio/example-envio.service.ts) | Terceiro exemplo: `emitirBoletoTransferencia()` |
| [`src/jobs/example-envio/example-envio.test.ts`](../../src/jobs/example-envio/example-envio.test.ts) | Testes da emissão |
| [`src/config/env.test.ts`](../../src/config/env.test.ts) | Defaults e recusa de identificador inválido |
| [`.env.example`](../../.env.example) | As quatro variáveis, comentadas, com o default |
| `docs/` | Ver [Documentação](#documentação) |

O helper é **estrutura permanente**, não exemplo: as variáveis
`IDEMPOTENCY_*` e o arquivo de DDL ficam quando os exemplos forem apagados.
Só `emitirBoletoTransferencia()` sai junto com o `example-envio`.

## Detalhamento

### 1. A tabela

Esta é a primeira tabela própria do serviço - até aqui o banco só servia ao
`sp_getapplock`. O usuário do serviço não tem permissão de DDL
([capítulo 04](../04-banco-de-dados.md#permissões-do-usuário-do-banco)), então
o script é aplicado pela pipeline ou pelo DBA, uma vez por banco:

```sql
-- sql/001-idempotencia.sql
-- Nomes = defaults das variáveis IDEMPOTENCY_*. Ao mudar uma variável, mude aqui também.
CREATE TABLE [dbo].[SchedulerIdempotencia] (
  [Chave]        NVARCHAR(200)  NOT NULL,
  [Instancia]    NVARCHAR(64)   NOT NULL,
  [Status]       VARCHAR(12)    NOT NULL,
  [Resultado]    NVARCHAR(400)  NULL,
  [Detalhe]      NVARCHAR(1000) NULL,
  [CriadoEm]     DATETIME2(3)   NOT NULL CONSTRAINT [DF_SchedulerIdempotencia_CriadoEm] DEFAULT SYSUTCDATETIME(),
  [AtualizadoEm] DATETIME2(3)   NOT NULL CONSTRAINT [DF_SchedulerIdempotencia_AtualizadoEm] DEFAULT SYSUTCDATETIME(),
  CONSTRAINT [PK_SchedulerIdempotencia] PRIMARY KEY ([Chave]),
  CONSTRAINT [CK_SchedulerIdempotencia_Status] CHECK ([Status] IN ('PROCESSANDO', 'CONCLUIDO', 'INCERTO'))
);

CREATE INDEX [IX_SchedulerIdempotencia_Status] ON [dbo].[SchedulerIdempotencia] ([Status], [CriadoEm]);
```

- A **chave primária** é a garantia inteira: dois `INSERT` da mesma chave não
  passam juntos, em nenhuma ordem, em nenhum pod.
- `Instancia` tem 64 posições: `node:` mais o UUID ocupam 41.
- O índice por `Status` atende a consulta de conciliação.
- Horários em UTC pelo próprio servidor (`SYSUTCDATETIME()`), não pelo relógio
  do pod.

Permissões que o usuário do serviço passa a precisar: `SELECT`, `INSERT`,
`UPDATE` e `DELETE` nessa tabela - nada além.

### 2. Variáveis de ambiente

| Variável | Default | Para quê |
| --- | --- | --- |
| `IDEMPOTENCY_SCHEMA` | `dbo` | Schema da tabela |
| `IDEMPOTENCY_TABLE` | `SchedulerIdempotencia` | Nome da tabela |
| `IDEMPOTENCY_KEY_COLUMN` | `Chave` | Coluna da chave (PK) |
| `IDEMPOTENCY_INSTANCE_COLUMN` | `Instancia` | Coluna da instância que reivindicou |

Os nomes ficam em inglês, como as demais variáveis
([índice, princípio 4](../README.md#4-o-código-é-em-português-a-fronteira-não)).
As outras colunas (`Status`, `Resultado`, `Detalhe`, `CriadoEm`,
`AtualizadoEm`) são fixas - ver [decisões em aberto](#decisões-em-aberto).

**Validação.** Nome de schema, tabela e coluna é identificador, não valor:
não pode ir por `.input()` e acaba concatenado no texto da query. Por isso o
schema aceita só identificador simples, e a query os envolve em colchetes:

```ts
/** Ver `docs/15-idempotencia.md`. Vai para o texto da query - por isso o formato é fechado. */
const identificadorSql = textoObrigatorio.pipe(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, {
    message: 'só letras, dígitos e `_`, começando por letra ou `_` - vai para o texto da query',
  }),
);

IDEMPOTENCY_SCHEMA: identificadorSql.default('dbo'),
IDEMPOTENCY_TABLE: identificadorSql.default('SchedulerIdempotencia'),
IDEMPOTENCY_KEY_COLUMN: identificadorSql.default('Chave'),
IDEMPOTENCY_INSTANCE_COLUMN: identificadorSql.default('Instancia'),
```

Sem `]`, `;`, espaço ou aspas, o colchete não tem como ser fechado por
dentro. Um valor fora do formato derruba o boot, como qualquer variável
inválida ([capítulo 02](../02-configuracao-de-ambiente.md)). A concatenação
acontece **uma vez, no carregamento do módulo**, a partir do ambiente
validado - nunca a partir de dado de execução. Todo valor (chave, instância,
resultado) continua indo por `.input()`.

**Por que estes defaults passam no critério do capítulo 02.** Um default
afirma que "ausente" e "este valor" são igualmente seguros. Aqui são: produção
tem banco próprio, então a tabela default de produção é outra tabela física; e
nos ambientes que dividem banco, usar a mesma tabela é o comportamento correto
(ver abaixo). Esquecer a variável nunca aponta a idempotência para o lugar
errado.

**Atenção - DEV, QA e HML dividem o banco.** Separar a tabela por ambiente
nesse banco repete o erro que o
[capítulo 06](../06-lock-distribuido.md#o-escopo-do-applock-é-o-database)
proíbe para o lock: pareceria isolamento e seria o contrário. Se QA e HML
emitem contra o mesmo parceiro, tabelas separadas deixam cada um emitir o
mesmo boleto uma vez. Divergir a tabela só faz sentido quando o **efeito
externo** também é separado (parceiros ou ambientes do parceiro distintos).

### 3. `getUuidInstancia()`

```ts
// src/config/instancia.ts
import { randomUUID } from 'node:crypto';

/** Identidade deste processo: gerada uma vez, a mesma até o processo morrer. Ver `docs/15-idempotencia.md`. */
const uuidInstancia = randomUUID();

export const getUuidInstancia = (): string => uuidInstancia;
```

O helper grava `node:${getUuidInstancia()}` na coluna da instância. O UUID
sozinho não diz qual pod era; por isso o boot loga os dois juntos
(`instancia` e `HOSTNAME`), e o log faz a correlação quando alguém pergunta
"quem deixou esta chave em `PROCESSANDO`?".

### 4. O helper `executarIdempotente()`

```ts
// src/shared/uteis/idempotencia_uteis.ts
export type StatusIdempotencia = 'PROCESSANDO' | 'CONCLUIDO' | 'INCERTO';

/** A ação falhou e garante que nada aconteceu do outro lado: a chave é liberada. */
export class ErroSemEfeito extends Error {
  override name = 'ErroSemEfeito';
}

export type DesfechoIdempotente<T> =
  | { executou: true; resultado: T }
  | { executou: false; dono?: { instancia: string; status: StatusIdempotencia; criadoEm: Date } };

export async function executarIdempotente<T>(
  chave: string,
  acao: () => Promise<T>,
  descreverResultado: (resultado: T) => string,
): Promise<DesfechoIdempotente<T>>;
```

O formato de retorno espelha o `ResultadoComLock` de
[`lock.ts`](../../src/scheduler/lock.ts): `executou: false` é desfecho
normal, não erro. `dono` é opcional porque a linha pode sumir entre o
`INSERT` recusado e a leitura (a outra instância liberou a chave); nesse caso
a execução pula do mesmo jeito e o próximo ciclo tenta de novo.

`descreverResultado` é obrigatório de propósito: um `CONCLUIDO` sem prova
(protocolo, id do parceiro) não tem como ser conferido depois - o mesmo
argumento do `esquemaResultado` do
[capítulo 12](../12-exemplo-job-e-servico.md#um-terceiro-serviço-post-autenticado).

O fluxo:

1. **Valida a chave** antes de tocar no banco: 1 a 200 caracteres, sem espaço
   nas pontas. Chave inválida é bug do serviço e lança na hora.
2. **Reivindica** - um `INSERT` em autocommit:

   ```sql
   INSERT INTO [schema].[tabela] ([Chave], [Instancia], [Status])
   VALUES (@chave, @instancia, 'PROCESSANDO');
   ```

   Erro `2627` ou `2601` (violação de chave única, lido de `err.number`) quer
   dizer "já reivindicada": lê `Instancia`, `Status` e `CriadoEm` da linha,
   loga em `info` e devolve `{ executou: false, dono }`. Qualquer outro erro
   sobe sem executar a ação.
3. **Executa a ação.**
4. **Registra o desfecho**, sempre com
   `WHERE [Chave] = @chave AND [Instancia] = @instancia AND [Status] = 'PROCESSANDO'`
   - só o dono da reivindicação mexe nela, e uma conciliação manual feita no
   meio da execução não é sobrescrita:

   | Desfecho da ação | Comando | Depois |
   | --- | --- | --- |
   | Sucesso | `UPDATE ... SET Status = 'CONCLUIDO', Resultado = @resultado, AtualizadoEm = SYSUTCDATETIME()` | Devolve `{ executou: true, resultado }` |
   | `ErroSemEfeito` | `DELETE ...` | Relança o erro original |
   | Qualquer outro erro | `UPDATE ... SET Status = 'INCERTO', Detalhe = @mensagem, AtualizadoEm = SYSUTCDATETIME()` | Relança o erro original |

   `rowsAffected` diferente de `1` vira `warn` no log (alguém mexeu na linha
   durante a execução), sem mudar o retorno.

Três falhas de segunda ordem, todas resolvidas para o lado seguro:

- **O `UPDATE`/`DELETE` do desfecho falha** (banco caiu no meio). A linha fica
  em `PROCESSANDO`, que bloqueia nova execução - correto. O erro do banco vai
  para o log **sem substituir o erro original da ação**, no mesmo padrão do
  `desfazerSemMascarar` de [`lock.ts`](../../src/scheduler/lock.ts).
- **O `UPDATE` para `CONCLUIDO` falha depois do sucesso.** O efeito aconteceu
  e o banco não sabe. O helper loga em `error` a chave **e o resultado
  descrito** (o protocolo), e relança: o job termina como falha, a linha fica
  em `PROCESSANDO`, e a conciliação tem o protocolo no log para fechar.
- **`descreverResultado` lança.** O efeito aconteceu; a chave vai para
  `CONCLUIDO` com `Resultado` nulo e o erro vai para o log. Não marcar
  `CONCLUIDO` aqui reabriria a porta para duplicar.

`Detalhe` recebe a mensagem do erro truncada em 1000 caracteres. As mensagens
dos serviços já não levam segredo
([capítulo 12](../12-exemplo-job-e-servico.md#um-terceiro-serviço-post-autenticado)),
e o helper não acrescenta nada além dela.

Os dois `trackTrace` seguem o padrão dos serviços: um ao reivindicar, outro ao
registrar o desfecho, com a chave - que não é segredo - na mensagem.

### 5. O exemplo: `emitirBoletoTransferencia()`

No [`example-envio.service.ts`](../../src/jobs/example-envio/example-envio.service.ts),
ao lado de `enviarRegistro()`:

```ts
const URL_EMISSAO_BOLETO = 'https://api.parceiro.example/api/v1/boletos';

export interface TransferenciaParaBoleto {
  clienteId: number;
  transferenciaId: number;
  valor: number;
  vencimento: string;
}

export interface ResultadoEmissao {
  protocolo: string;
}

export async function emitirBoletoTransferencia(
  transferencia: TransferenciaParaBoleto,
): Promise<DesfechoIdempotente<ResultadoEmissao>> {
  const chave = `emite:${transferencia.clienteId}:${transferencia.transferenciaId}`;

  // Fora da reivindicação: falha na autenticação não toca a tabela.
  const token = await autenticar();

  return executarIdempotente(
    chave,
    async () => {
      const resposta = await Rest.Validar.Post(
        URL_EMISSAO_BOLETO,
        transferencia,
        esquemaResultado,
        { 'token-id': token, 'Idempotency-Key': chave },
        comTempoLimite(),
      );

      if (!resposta.ok) {
        throw classificarFalha(resposta);
      }

      return resposta.data;
    },
    (resultado) => resultado.protocolo,
  );
}
```

`classificarFalha()` é interna e aplica a
[tabela de classificação](#a-regra-de-classificação-na-dúvida-incerto):
devolve `ErroSemEfeito` para as recusas antes do processamento e `Error` comum
para o resto, sempre com status e `statusText` na mensagem.

Regras da chave que o exemplo ilustra:

- **Prefixo de operação** (`emite:`) mais a identidade de negócio. Duas
  operações diferentes sobre a mesma transferência (emitir, cancelar) têm
  chaves diferentes.
- **Nada que mude entre tentativas**: sem horário, sem número de tentativa,
  sem UUID novo. Uma chave que muda não deduplica nada.
- **Sem nome de ambiente**, pelo mesmo motivo do `@Resource` do lock.

O header `Idempotency-Key` é a segunda linha de defesa. Se o parceiro o
suporta, um `INCERTO` pode ser reenviado com a mesma chave sem risco - o
parceiro devolve o boleto já emitido. Se não suporta, o header é ignorado e
nada muda. Confirmar com cada parceiro real.

### 6. Testes

Mock só na fronteira de infraestrutura - `mssql.ts`, `fetch`, logger,
Application Insights -, como no
[capítulo 09](../09-testes.md#3-o-banco-é-mockado-e-é-isso-que-permite-testar-offline).
O pool falso devolve um `request()` encadeável cujo `query` responde por
chamada, e o erro de chave duplicada é um objeto com `number: 2627`.

`idempotencia_uteis.test.ts`:

- reivindicação aceita → ação executa → `UPDATE` para `CONCLUIDO` com o
  resultado descrito → `{ executou: true }`;
- `2627` e `2601` → ação **não** executa → `{ executou: false, dono }`;
- chave recusada e linha já sumida → `{ executou: false }` sem `dono`;
- outro erro no `INSERT` → sobe, ação não executa;
- `ErroSemEfeito` → `DELETE`, erro original relançado;
- erro comum → `UPDATE` para `INCERTO` com a mensagem, erro original
  relançado;
- falha no `UPDATE`/`DELETE` do desfecho → erro **original** relançado, falha
  do banco no log;
- falha no `UPDATE` para `CONCLUIDO` → log `error` com chave e resultado;
- o texto da query usa os identificadores configurados, entre colchetes;
- chave vazia, com espaço nas pontas ou acima de 200 caracteres → lança sem
  tocar no banco.

`env.test.ts`: defaults aplicados; `dbo;DROP`, `a]b`, `1tabela`, vazio e
`CHANGE_ME` recusados.

`example-envio.test.ts`: chave no formato `emite:<cliente>:<transferência>`;
`Idempotency-Key` igual à chave; `400` vira `ErroSemEfeito`; `500`,
`status 0` e `2xx` fora do contrato viram erro comum; autenticação recusada
não toca a tabela.

### Documentação

| Arquivo | Mudança |
| --- | --- |
| `docs/15-idempotencia.md` | **Novo capítulo**, com o conteúdo permanente deste plano |
| [`docs/README.md`](../README.md) | Linha 15 no índice; linha na tabela "Sem biblioteca" (e "Cinco peças" vira "Seis"); arquivos novos no mapa |
| [`docs/02`](../02-configuracao-de-ambiente.md) | As quatro variáveis na tabela; os defaults citados em "O que merece default" |
| [`docs/04`](../04-banco-de-dados.md) | "Para que o banco serve" e "Trocar o SQL Server" deixam de dizer que não há tabela própria; permissões na tabela |
| [`docs/06`](../06-lock-distribuido.md) | "O que o lock não faz" aponta para o capítulo 15; a frase "o lock é hoje o único motivo de depender de um banco" sai |
| [`docs/05`](../05-scheduler.md) | O contrato aponta o capítulo 15 como o jeito de cumprir "handler idempotente" |
| [`docs/09`](../09-testes.md) | "O que os testes garantem hoje" inclui o helper |
| [`docs/12`](../12-exemplo-job-e-servico.md) | Seção da emissão idempotente; o parágrafo "Sobre idempotência" passa a apontar o exemplo; o checklist **não** remove as variáveis `IDEMPOTENCY_*` |
| [`docs/14`](../14-cliente-rest.md) | Nota sobre `status 0` não separar "não chegou" de "resposta perdida" |

## Conciliação

Chaves em `INCERTO`, ou em `PROCESSANDO` há mais tempo que o
`tempoLimiteMs` do job, precisam de alguém que pergunte ao parceiro o que
aconteceu. A consulta:

```sql
SELECT [Chave], [Instancia], [Status], [Detalhe], [CriadoEm], [AtualizadoEm]
FROM [dbo].[SchedulerIdempotencia]
WHERE [Status] = 'INCERTO'
   OR ([Status] = 'PROCESSANDO' AND [CriadoEm] < DATEADD(MINUTE, -30, SYSUTCDATETIME()))
ORDER BY [CriadoEm];
```

Para cada linha:

- **O parceiro emitiu** → `UPDATE` para `CONCLUIDO` com o protocolo em
  `Resultado`.
- **O parceiro não emitiu** → `DELETE` da linha; o próximo ciclo emite.

O helper não decide isso sozinho em nenhuma hipótese. Automatizar exige um
endpoint de consulta do parceiro e fica nas
[evoluções](#evoluções-futuras).

## Limitações

- **Não protege o que não passa por ela.** Um serviço que emite sem
  `executarIdempotente()`, ou com chave que muda a cada tentativa, continua
  livre para duplicar.
- **`INCERTO` exige gente.** É o preço de nunca duplicar: em incidente do
  parceiro, a fila de conciliação cresce. Um alerta no Application Insights
  sobre o `trackTrace` de `INCERTO` é recomendado.
- **A tabela cresce.** `CONCLUIDO` precisa ficar enquanto a origem puder
  devolver a mesma transferência. A política de expurgo (ex.: `CONCLUIDO` com
  mais de N dias) é decisão de negócio, e roda pela pipeline ou por um job
  próprio.
- **Falha sem efeito repete a cada ciclo.** Um `400` permanente apaga a chave
  e volta no ciclo seguinte, como hoje. O log mostra a repetição; corrigir é
  com a origem dos dados.

## Decisões em aberto

1. **Onde mora o exemplo.** O pedido é `example-envio.service.ts`, mas o
   [capítulo 12](../12-exemplo-job-e-servico.md#um-segundo-serviço-consulta-ao-banco)
   diz "um serviço, um envio" - dois envios no mesmo arquivo contrariam a
   regra que o próprio exemplo ensina. Alternativa: um arquivo
   `example-emissao.service.ts` na mesma pasta, com `autenticar()` passando a
   ser exportada pelo `example-envio`. **Recomendação:** arquivo próprio.
2. **Colunas configuráveis.** Hoje só chave e instância são configuráveis,
   como pedido. Configurar duas colunas de sete deixa o DDL meio fixo, meio
   variável. Alternativa: só schema e tabela configuráveis, colunas fixas no
   DDL. **Recomendação:** só schema e tabela.
3. **Tabela por ambiente no banco compartilhado.** Ver o aviso na
   [seção 2](#2-variáveis-de-ambiente). **Recomendação:** mesma tabela para
   DEV, QA e HML; a separação de produção já vem do banco próprio.
4. **Nome da tabela default.** `SchedulerIdempotencia` é proposta; alinhar com
   a convenção de nomes do DBA antes de criar.
5. **Prazo de expurgo** de `CONCLUIDO`.

## Ordem de implementação

Cada passo fecha com `npm run typecheck && npm test`; o último também com
`npm run build && npm run lint:md`.

1. `getUuidInstancia()` e o log no boot.
2. Variáveis `IDEMPOTENCY_*` em `env.ts`, `env.test.ts` e `.env.example`.
3. `sql/001-idempotencia.sql` - revisado com o DBA, aplicado em DEV.
4. `executarIdempotente()` e seus testes.
5. `emitirBoletoTransferencia()` e seus testes.
6. Capítulo 15 e ajustes nos capítulos 02, 04, 05, 06, 09, 12, 14 e no
   índice; este plano é apagado.
7. Teste manual em DEV contra o banco real: emitir, repetir (deve pular),
   forçar timeout (deve ficar `INCERTO`), conciliar.

## Evoluções futuras

- **Conciliação automática** - se o parceiro tiver consulta por chave ou por
  transferência, um job próprio resolve `INCERTO` e `PROCESSANDO` órfão sem
  intervenção. Deve usar a mesma condição de dono no `WHERE`.
- **Reenvio automático de `INCERTO`** - seguro **somente** com parceiro que
  honra `Idempotency-Key`. Exige um campo `Tentativas` e um teto.
- **Histórico de falhas sem efeito** - trocar o `DELETE` por um status
  `FALHOU` reivindicável de novo (`UPDATE ... WHERE Status = 'FALHOU'`, e
  `INSERT` se nada mudou). Mantém auditoria no banco em vez de só no log.
- **Fechar a janela de rolling update no runner** - o upgrade descrito no
  [capítulo 05](../05-scheduler.md#upgrades-futuros-sem-quebrar-o-que-existe)
  (chave por job e ocorrência agendada) pode reaproveitar esta mesma tabela,
  com chave `job:<nome>:<fireDate>`.
