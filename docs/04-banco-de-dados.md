# 04 — Banco de dados

[← Logger](03-logger.md) ·
[Índice](README.md) ·
[Próximo: Scheduler →](05-scheduler.md)

## Bibliotecas

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`mssql`](https://www.npmjs.com/package/mssql) | `^11.0` | Driver do SQL Server para Node (usa Tedious por baixo) |
| [`@types/mssql`](https://www.npmjs.com/package/@types/mssql) | `^9.1` | Tipos do driver |

## Responsabilidade

[`src/db/mssql.ts`](../src/db/mssql.ts) é o dono exclusivo da conexão com o
banco. Ele expõe quatro coisas e nada mais:

| Export | Para quê |
| --- | --- |
| `obterPoolDb()` | Devolve o pool único do processo |
| `fecharPoolDb()` | Encerra o pool no shutdown |
| `verificarSaudeDb()` | Ping usado pelo readiness — nunca lança |
| `sql` | Reexport do driver, para os tipos de parâmetro (`sql.NVarChar`, `sql.Int`) |

A regra é curta: **nunca instancie `new sql.ConnectionPool()` fora deste
arquivo**. Um pool por processo é suficiente e é o que impede o serviço de
esgotar as conexões do MSSQL — que é um recurso compartilhado com a API.

### Para que o banco serve neste serviço

Hoje, para uma coisa só: o [lock distribuído](06-lock-distribuido.md) dos jobs,
via `sp_getapplock`. Não há tabela própria nem schema a manter — é essa a razão
de a estrutura não trazer migrações nem ORM.

Os jobs que você implementar provavelmente usarão o mesmo pool para a regra de
negócio deles. Quando isso acontecer, a query mora no serviço
([capítulo 12](12-exemplo-job-e-servico.md)), não aqui.

## Um único pool, memoizado

```ts
let pool: sql.ConnectionPool | undefined;
let connecting: Promise<sql.ConnectionPool> | undefined;
```

Duas variáveis, não uma. O motivo é uma corrida real: se dois jobs dispararem
no mesmo segundo durante o boot, os dois chamam `obterPoolDb()` antes de qualquer
conexão existir. Guardando apenas `pool`, ambos veriam `undefined` e abririam
um pool cada um.

Memoizando a **promise**, o segundo chamador espera a mesma conexão que o
primeiro iniciou. O `.finally()` limpa `connecting` para que uma falha de
conexão possa ser tentada de novo na próxima chamada, em vez de a promise
rejeitada ficar em cache para sempre.

## Configuração

```ts
options: {
  encrypt: env.DB_ENCRYPT,
  trustServerCertificate: ambiente.NODE_ENV !== 'production',
},
pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
```

- **`trustServerCertificate`** fica ligado fora de produção porque bancos locais
  e de desenvolvimento usam certificado autoassinado. Em produção ele é `false`,
  ou seja, o certificado do servidor **é** validado. Não mude isso para
  "resolver" um erro de TLS em produção — o erro é o aviso.
- **`min: 0`** — o serviço fica ocioso a maior parte do tempo. Não faz sentido
  segurar conexão parada entre execuções de cron.
- **`max: 10`** — teto por processo. Como só existe uma réplica, é também o
  teto do serviço inteiro.

## `verificarSaudeDb()` não lança

```ts
export async function verificarSaudeDb(tempoLimiteMs = ambiente.HEALTH_DB_TIMEOUT_MS): Promise<SaudeBanco>
```

Ele corre um `SELECT 1` contra um timeout e devolve
`{ ok, latencyMs, error? }` — nunca uma exceção. É intencional: o endpoint de
saúde precisa responder principalmente **quando o banco está fora**. Se o ping
lançasse, a rota viraria um 500 genérico, que não distingue "banco caiu" de
"bug no serviço".

O timeout é próprio, e não o do driver, porque o `connect()` do mssql pode ficar
pendurado por bem mais que o intervalo entre duas probes do Kubernetes. Sem o
teto explícito, o readiness ficaria sem responder em vez de responder `503`.

## Uso nas queries

Sempre parametrize. Nunca concatene:

```ts
// Certo
await pool.request()
  .input('codigo', sql.NVarChar, codigo)
  .query('SELECT id, status FROM pedidos WHERE codigo = @codigo');

// Nunca
await pool.request().query(`SELECT id, status FROM pedidos WHERE codigo = '${codigo}'`);
```

Vale mesmo quando o valor "vem de dentro", como um id lido de outra tabela ou
um parâmetro montado por outro serviço. Concatenação é um hábito, e o hábito é
o que falha no dia em que o valor passa a vir de fora.

## Permissões do usuário do banco

O usuário configurado aqui precisa apenas de:

- `EXECUTE` em `sp_getapplock` / `sp_releaseapplock` (o `public` já tem);
- o que os jobs que você implementar exigirem.

Não conceda permissão de DDL. Um serviço que roda código agendado sem
supervisão não deveria poder alterar schema — se um dia houver migração, quem
roda é a pipeline, com credencial própria.

## Upgrades futuros sem quebrar o que existe

**Subir a versão do `mssql`** — acompanhe o
[changelog](https://github.com/tediousjs/node-mssql/releases). As quebras
históricas ficaram concentradas em `options` (nomes de flag de TLS) e no
comportamento padrão de `encrypt`. Depois de subir, o teste mais rápido é
`npm run dev` com o banco real: o boot chama `obterPoolDb()` e falha na hora se
a configuração ficou inválida.

**Trocar autenticação por Managed Identity do Azure** — é o upgrade de
segurança de maior retorno aqui, porque elimina `DB_USER`/`DB_PASSWORD` do
ambiente. A mudança é local a este arquivo:

```ts
const configuracao: sql.config = {
  server: env.DB_SERVER,
  database: env.DB_NAME,
  authentication: { type: 'azure-active-directory-default' },
  options: { encrypt: true },
};
```

Depois remova as três variáveis do `esquemaAmbiente` e do `.env.example`. Nenhum
outro arquivo é tocado — é a prova de que o isolamento do pool funciona.

**Trocar o SQL Server por outro banco** — o impacto vai além deste arquivo,
porque o [lock distribuído](06-lock-distribuido.md) usa `sp_getapplock`, que é
específico do SQL Server. Planeje as duas peças juntas: o capítulo 06 lista os
substitutos por banco. Como o lock é hoje o único uso do banco, essa é também
a única amarra — não há schema para migrar junto.

**Ajustar o tamanho do pool** — `max: 10` é folgado para uma réplica única com
jobs sequenciais. Só suba se o log mostrar espera por conexão. Antes de subir,
confirme o limite de conexões da instância MSSQL: se ela for compartilhada com
outro serviço, estourar o limite lá derruba os dois.

Atenção a uma interação específica: cada job em execução segura **duas**
conexões — a da transação do lock e a do trabalho em si
([capítulo 06](06-lock-distribuido.md)). Com jobs longos e simultâneos, o teto
útil é metade do `max`.

**Adicionar uma segunda dependência externa** (Redis, fila, API interna) — siga
o mesmo formato: um módulo dono da conexão, um `obterX()` memoizado, um
`fecharX()` chamado no encerramento e um `verificarSaudeX()` que nunca lança.
Depois adicione o check ao readiness — o [capítulo 08](08-health-check.md)
mostra onde.
