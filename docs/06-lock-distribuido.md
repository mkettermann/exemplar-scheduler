# 06 — Lock distribuído

[← Scheduler](05-scheduler.md) ·
[Índice](README.md) ·
[Próximo: Servidor HTTP →](07-servidor-http.md)

## Biblioteca

Nenhuma. A trava usa
[`sp_getapplock`](https://learn.microsoft.com/sql/relational-databases/system-stored-procedures/sp-getapplock-transact-sql),
uma stored procedure do próprio SQL Server, através do driver `mssql` já
instalado ([capítulo 04](04-banco-de-dados.md)).

Foi uma escolha, não uma limitação: usar o banco que já é dependência do
serviço evita introduzir um Redis só para coordenar uma réplica única. Menos
uma peça para provisionar, monitorar e manter de pé.

Vale notar a consequência inversa: **o lock é hoje o único motivo de este
serviço depender de um banco**. Se um dia nenhum job precisar de MSSQL e o lock
sair, a dependência inteira sai junto — incluindo o check de readiness
([capítulo 08](08-health-check.md)).

## Responsabilidade

[`src/scheduler/lock.ts`](../src/scheduler/lock.ts) garante que, mesmo que dois
processos do scheduler existam ao mesmo tempo, só um execute cada job.

### Por que isso existe se a réplica é única

Durante um **rolling update** no AKS, o pod novo sobe antes de o antigo
terminar de morrer. Nessa janela de alguns segundos existem dois processos
vivos. Se um cron disparar exatamente ali, o job roda duas vezes.

Para um job que envia e-mail, gera cobrança ou movimenta estoque, rodar duas
vezes não é um detalhe. O lock fecha a **metade concorrente** dessa janela —
leia "O que o lock não faz", abaixo, para a metade que sobra.

### O escopo do applock é o database

`sp_getapplock` trava por **banco de dados**, não por conexão nem por host.
Duas consequências, as duas importantes:

- Ambientes que **compartilham o mesmo banco** — tipicamente DEV, QA e HML —
  disputam literalmente a mesma trava. Isso é o que se quer, já que os efeitos
  colaterais caem nas mesmas tabelas. **Nunca** prefixe o `@Resource` com o
  nome do ambiente: pareceria isolamento e seria o contrário.
- Se um dia o scheduler apontar `DB_NAME` para um banco próprio enquanto os
  jobs continuam escrevendo no banco compartilhado, a trava deixa de proteger
  qualquer coisa — sem erro, sem log, sem sintoma até duplicar.

Impedir que dois ambientes rodem o mesmo job é responsabilidade de
`DefinicaoJob.ambientes`, não do lock ([capítulo 05](05-scheduler.md), seção
"Um job, um ambiente").

## Como funciona

```ts
const { executou } = await executarComLock(job.nome, async () => { /* ... */ });
```

O fluxo:

1. Abre uma **transação** no pool compartilhado.
2. Chama `sp_getapplock` com `@Resource = 'job:<nome>'`, modo `Exclusive`,
   dono `Transaction` e **`@LockTimeout = 0`**.
3. Retorno `>= 0` significa trava adquirida; negativo significa ocupada.
4. Se não conseguiu: `rollback`, devolve `{ executou: false }`, e o runner só
   loga em `debug`. **A execução é pulada, não enfileirada.**
5. Se conseguiu: executa a função e dá `commit`, o que libera a trava.

Três decisões merecem nota:

- **`@LockTimeout = 0`** — não espera. Para um job de cron, esperar não faz
  sentido: quando a vez chegasse, a próxima execução já estaria agendada. Pular
  é o comportamento correto.
- **`@LockOwner = 'Transaction'`** — a trava morre com a transação. Se o
  processo for morto no meio do job (`SIGKILL`, OOM, nó reiniciado), o SQL
  Server derruba a sessão e libera a trava sozinho. Não existe trava órfã
  eternamente presa, que é o modo clássico de falha de locks caseiros em tabela.
- **A transação fica aberta durante todo o job.** É o preço do `LockOwner =
  Transaction`. Ver as limitações abaixo.

## O que o lock não faz

**Ele impede a execução simultânea, não a sequencial.** A trava vive enquanto a
transação vive, ou seja, durante a execução — e só. Se o pod antigo dispara às
10:00:00.000 e termina em 800 ms, o `commit` libera a trava; o pod novo,
disparando às 10:00:00.300, encontra tudo livre e roda **a mesma ocorrência**
de novo. Não há conflito, não há log de disputa: as duas execuções parecem
legítimas.

A diferença entre os dois instantes não é limitada por nada em especial. Não é
só skew de relógio (sub-segundo com NTP): é jitter do timer do `node-schedule`,
lag do event loop, espera por conexão do pool e o round trip do
`sp_getapplock`. Um pod sob pressão de GC passa de um segundo sem esforço — por
isso **não** adianta "segurar a trava mais um pouco" antes de liberar: seria um
número arbitrário contra uma grandeza sem teto, que funciona em 99% dos
disparos e falha sob carga, exatamente quando dói.

Fechar essa janela de verdade exigiria estado **durável**: responder "alguém já
rodou a ocorrência das 10:00?" depois que a trava foi liberada só é possível se
algo tiver sobrevivido à liberação, e uma trava com `LockOwner = 'Transaction'`
não sobrevive por construção. O desenho desse upgrade está no
[capítulo 05](05-scheduler.md), em "Upgrades futuros".

Enquanto ele não existir, a mitigação é a que
[`job.types.ts`](../src/scheduler/job.types.ts) exige no contrato: **handlers
idempotentes**. Não é recomendação, é requisito.

**Ele não desfaz trabalho.** Se o processo morrer no meio, a trava é liberada
mas o efeito parcial permanece. Mesma conclusão pelo outro caminho: a trava
evita a execução simultânea, não a execução parcial.

## Limitações que você precisa conhecer

**Transação longa.** Um job de 40 minutos mantém uma transação aberta por 40
minutos. Ela não escreve nada (só segura o applock), então não bloqueia linhas
— mas ocupa uma conexão do pool e aparece nos relatórios de transação longa do
DBA. Alinhe isso com quem administra o banco antes de subir jobs demorados.

**A conexão do job é outra.** O handler recebe uma conexão diferente do pool,
não a da transação do lock. Ou seja: o trabalho do job **não** é transacional
junto com o lock. Isso é proposital — o lock coordena, não dá atomicidade.
Se um job precisa de atomicidade, ele abre a própria transação dentro do
handler.

## Upgrades futuros sem quebrar o que existe

**Deixar o job esperar em vez de pular** — mude `@LockTimeout` de `0` para um
valor em milissegundos. Faça isso por job, não globalmente: exige um campo novo
em `DefinicaoJob` e repasse por `executarComLock`. Um timeout de espera global
é a receita para conexões acumuladas no pool.

**Tornar o lock opcional por job** — adicione `usaLock?: boolean` (default
`true`) ao contrato e faça o runner pular `executarComLock` quando for `false`.
Útil para jobs comprovadamente idempotentes e muito frequentes, onde a
transação aberta custa mais que o risco. O default preserva o comportamento
atual.

**Registrar qual instância segurou a trava** — útil para diagnosticar
duplicidade. Adicione `@@SPID` e `HOST_NAME()` ao `SELECT` do lock e leve ao
log. Mudança aditiva: o `recordset[0].result` continua sendo lido do mesmo
jeito.

**Trocar por Redis (`SET NX PX`) ou por uma lease em tabela** — só vale a pena
se o serviço deixar de depender do SQL Server. Se for esse o caso, o requisito
é manter a assinatura:

```ts
interface ResultadoComLock<T> {
  executou: boolean;
  resultado?: T;
}

executarComLock<T>(
  nomeJob: string,
  acao: () => Promise<T>,
): Promise<ResultadoComLock<T>>
```

Mantendo essa assinatura, nem o `job-runner` nem os jobs mudam. **Atenção ao
que se perde:** com Redis, a expiração vira responsabilidade sua — é preciso
renovar a lease enquanto o job roda (senão a trava cai no meio de um job longo)
e liberar apenas se você ainda for o dono (comparando um token, via script
Lua). O `LockOwner = 'Transaction'` do SQL Server dá isso de graça.

**Mudar de banco** — `sp_getapplock` é exclusivo do SQL Server. Equivalentes:

| Banco | Equivalente |
| --- | --- |
| PostgreSQL | `pg_try_advisory_lock(key)` / `pg_advisory_unlock(key)` |
| MySQL 8 | `GET_LOCK(name, 0)` / `RELEASE_LOCK(name)` |
| Redis | `SET chave token NX PX ttl` + renovação + liberação por token |

Em PostgreSQL e MySQL, `key` é numérico ou string — nos dois casos derive de
`job.nome` com um hash estável, nunca de um contador, ou a chave muda a cada
deploy.

**Escalar para N réplicas permanentes** — o lock passa a ser a única coisa
entre você e a execução duplicada, em todos os disparos e não só na janela de
deploy. Antes de considerar: audite cada job para idempotência, e reveja o
`@LockTimeout = 0` (com N réplicas, N-1 vão pular toda vez, o que é o
comportamento desejado, mas o log de `debug` vira ruído constante).
