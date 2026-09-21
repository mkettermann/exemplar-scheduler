# 03 — Logger

[← Configuração de ambiente](02-configuracao-de-ambiente.md) · [Índice](README.md) · [Próximo: Banco de dados →](04-banco-de-dados.md)

## Bibliotecas

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`pino`](https://getpino.io/#/docs/api) | `^9.5` | Logger estruturado em JSON, de baixo overhead |
| [`pino-pretty`](https://github.com/pinojs/pino-pretty) | `^13` | Formata a saída para leitura humana **em desenvolvimento** |

## Responsabilidade

Produzir uma linha de log por evento, em formato que o Azure Log Analytics /
Application Insights consiga indexar sem parser customizado.

A escolha do pino sobre `console.log` tem uma razão concreta para este serviço:
log estruturado permite **filtrar por campo**. Com
`logger.info({ job: 'sync-x', executionId: 42 }, 'Job concluído')`, procurar
todas as execuções do `sync-x` que falharam é uma query, não um grep em texto
livre.

## Como funciona

```ts
// src/logger/logger.ts
export const logger = env.NODE_ENV === 'development'
  ? pino({ ...baseOptions, transport: { target: 'pino-pretty' } })
  : pino(baseOptions);
```

| Ambiente | Nível | Formato |
| --- | --- | --- |
| `development` | `debug` | Colorido e legível (pino-pretty) |
| `test` | `silent` | Nada — para a saída do vitest não virar sopa de log |
| `staging` | `debug` | JSON puro |
| `production` | `info` | JSON puro |

O `pino-pretty` só entra em desenvolvimento porque ele custa caro: roda em uma
thread separada e reformata cada linha. Em produção o JSON cru é mais rápido
**e** mais útil, já que a plataforma de observabilidade é quem formata.

### Redação de segredos

```ts
redact: {
  paths: ['password', '*.password', 'DB_PASSWORD'],
  censor: '[REDACTED]',
}
```

Rede de segurança para quando alguém logar o objeto inteiro de configuração ou
o payload de um serviço externo. **Não** é substituto para não logar segredo:
o redact só alcança as chaves listadas, e só nos níveis que o curinga cobre.

### O Fastify não usa este logger

[`buildApp`](../src/server/app.ts) passa `logger: false` ao Fastify. O
framework tem pino embutido, mas ligá-lo criaria uma segunda instância com
configuração própria — dois formatos de log no mesmo serviço. Log de
requisição HTTP, se necessário, entra como hook usando este `logger`.

## Convenções de uso

```ts
// Certo: dado estruturado no primeiro argumento, mensagem fixa no segundo
logger.info({ job: job.name, executionId }, 'Job iniciado');

// Evite: dado interpolado na mensagem — não dá para filtrar depois
logger.info(`Job ${job.name} iniciado com id ${executionId}`);
```

| Nível | Quando usar |
| --- | --- |
| `fatal` | O processo não consegue continuar (falha no boot, bug no próprio runner) |
| `error` | Um job falhou, o pool caiu, o readiness reprovou |
| `warn` | Situação anormal contornada (lock ocupado, memória alta) |
| `info` | Marcos: boot, job registrado, job concluído |
| `debug` | Detalhe de diagnóstico (execução pulada por lock) |

## Upgrades futuros sem quebrar o que existe

**Subir a versão do pino** — a API `logger.<nível>(obj, msg)` é estável há
várias majors. O ponto de atenção é o `transport`, que mudou de forma na v7.
Como só o modo `development` usa transport, um problema aqui nunca chega em
produção — mas rode `npm run dev` depois de subir.

**Adicionar log de requisição HTTP** — não ligue o logger do Fastify. Adicione
um hook em [`buildApp`](../src/server/app.ts):

```ts
app.addHook('onResponse', async (req, reply) => {
  logger.info(
    { method: req.method, url: req.url, status: reply.statusCode, ms: reply.elapsedTime },
    'requisicao',
  );
});
```

Cuidado: `/health` é chamado pelas probes a cada poucos segundos. Filtre essa
rota ou o log vira ruído e custo de ingestão.

**Enviar logs direto para um destino externo** — use `pino.transport()` com o
alvo correspondente, nunca um handler síncrono. Transporte em thread separada é
o que impede que a latência do destino vire latência do job. Mantenha a saída
em `stdout` funcionando em paralelo: no AKS ela é a rede de segurança quando o
destino externo cai.

**Trocar o pino por outra biblioteca** — a troca é viável porque todo o sistema
importa `{ logger }` de um único módulo. Requisito para não quebrar nada: o
substituto precisa aceitar a assinatura `(objeto, mensagem)` nos cinco níveis
usados. Se ele aceitar só `(mensagem)`, escreva um adaptador dentro de
`src/logger/logger.ts` em vez de reescrever as chamadas espalhadas.

**Correlacionar logs de uma mesma execução** — hoje `executionId` já cumpre
esse papel nos jobs. Se quiser algo mais amplo, use
`logger.child({ executionId })` dentro do `job-runner` e passe o filho ao
handler. Isso exige mudar a assinatura de `JobDefinition.handler`, que é um
contrato público — leia o [capítulo 05](05-scheduler.md) antes.
