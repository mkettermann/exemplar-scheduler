# 06 — Lock distribuído

[← Scheduler](05-scheduler.md) · [Índice](README.md) · [Próximo: Servidor HTTP →](07-servidor-http.md)

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
vezes não é um detalhe. O lock fecha essa janela.

## Como funciona

```ts
const { ran } = await withJobLock(job.name, async () => { /* ... */ });
```

O fluxo:

1. Abre uma **transação** no pool compartilhado.
2. Chama `sp_getapplock` com `@Resource = 'job:<nome>'`, modo `Exclusive`,
   dono `Transaction` e **`@LockTimeout = 0`**.
3. Retorno `>= 0` significa trava adquirida; negativo significa ocupada.
4. Se não conseguiu: `rollback`, devolve `{ ran: false }`, e o runner apenas
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

**O lock não desfaz trabalho.** Se o processo morrer no meio, a trava é
liberada mas o efeito parcial permanece. É por isso que
[`job.types.ts`](../src/scheduler/job.types.ts) recomenda handlers idempotentes:
a trava evita a execução simultânea, não a execução parcial.

## Upgrades futuros sem quebrar o que existe

**Deixar o job esperar em vez de pular** — mude `@LockTimeout` de `0` para um
valor em milissegundos. Faça isso por job, não globalmente: exige um campo novo
em `JobDefinition` e repasse por `withJobLock`. Um timeout de espera global é a
receita para conexões acumuladas no pool.

**Tornar o lock opcional por job** — adicione `usaLock?: boolean` (default
`true`) ao contrato e faça o runner pular `withJobLock` quando for `false`.
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
withJobLock<T>(jobName: string, fn: () => Promise<T>): Promise<{ ran: boolean; result?: T }>
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
`job.name` com um hash estável, nunca de um contador, ou a chave muda a cada
deploy.

**Escalar para N réplicas permanentes** — o lock passa a ser a única coisa
entre você e a execução duplicada, em todos os disparos e não só na janela de
deploy. Antes de considerar: audite cada job para idempotência, e reveja o
`@LockTimeout = 0` (com N réplicas, N-1 vão pular toda vez, o que é o
comportamento desejado, mas o log de `debug` vira ruído constante).
