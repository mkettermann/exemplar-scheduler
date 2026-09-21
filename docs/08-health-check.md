# 08 — Health check

[← Servidor HTTP](07-servidor-http.md) ·
[Índice](README.md) ·
[Próximo: Testes →](09-testes.md)

## Bibliotecas

Nenhuma específica. Usa o [Fastify](07-servidor-http.md) para expor e o
[driver `mssql`](04-banco-de-dados.md) para verificar a dependência.

## Responsabilidade

Responder duas perguntas **diferentes**, que o Kubernetes trata de formas
diferentes:

| Rota | Pergunta | O que o AKS faz ao falhar |
| --- | --- | --- |
| `GET /health` | O processo está vivo? | **Reinicia o pod** |
| `GET /health/ready` | O processo consegue trabalhar? | Tira do balanceamento, **sem reiniciar** |

Misturar as duas é o erro clássico. Se o liveness consultasse o banco, uma
instabilidade de 30 segundos no MSSQL faria o Kubernetes matar o pod, que
subiria, encontraria o banco ainda fora, seria morto de novo — um
`CrashLoopBackOff` causado por um problema que não era do processo. Pior: cada
reinício interrompe jobs em andamento.

Por isso a separação é explícita no código.

## `GET /health` — liveness

```ts
export const obterLiveness = async () => ({
  status: 'ok',
  uptimeSeconds: Math.floor(process.uptime()),
});
```

Sem autenticação, sem I/O, sem dependência. Se o event loop está respondendo,
o processo está vivo. Falha só quando o processo travou de verdade, que é
exatamente o caso em que reiniciar resolve.

Sem autenticação de propósito: o kubelet chama esta rota e não tem como
carregar credencial. A resposta não expõe nada sensível — `uptime` é a
informação mais reveladora, e ela ajuda a diagnosticar reinícios inesperados.

```json
{ "status": "ok", "uptimeSeconds": 1834 }
```

## `GET /health/ready` — readiness

Verifica as dependências externas e responde:

| Situação | HTTP | `status` |
| --- | --- | --- |
| Banco responde | `200` | `ok` |
| Banco fora ou lento | `503` | `degraded` |

```json
// 200
{ "status": "ok", "uptimeSeconds": 1834, "checks": { "database": { "ok": true, "latencyMs": 4 } } }

// 503
{
  "status": "degraded",
  "uptimeSeconds": 12,
  "checks": {
    "database": { "ok": false, "latencyMs": 3000, "error": "Timeout de 3000ms ao consultar o banco" }
  }
}
```

Três decisões deste handler:

1. **`verificarSaudeDb()` nunca lança** ([capítulo 04](04-banco-de-dados.md)). Um
   `503` explicando "o banco não responde" é informação; um `500` genérico não é.
2. **Tem timeout próprio** (`HEALTH_DB_TIMEOUT_MS`, padrão 3000ms). O
   `connect()` do driver pode ficar pendurado bem além do intervalo entre duas
   probes. Sem o teto, o readiness ficaria sem responder em vez de responder
   `503`.
3. **Em produção, o campo `error` é omitido.** Mensagens do driver costumam
   trazer host e nome de instância. O detalhe completo vai para o log via
   `logger.error`, onde o acesso é controlado. Fora de produção o campo aparece,
   porque ali o valor de diagnóstico supera o risco.

## Configuração no AKS

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
  initialDelaySeconds: 10
  periodSeconds: 20
  failureThreshold: 3

readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  initialDelaySeconds: 5
  periodSeconds: 10
  failureThreshold: 3
```

Um detalhe específico deste serviço: como a réplica é única, um readiness
reprovado **não** transfere carga para outro pod — não há outro. O valor aqui é
de sinalização: o pod aparece como `NotReady` no cluster e o alerta dispara.
Os jobs continuam tentando rodar e falhando na aquisição do lock, com o erro
logado pelo [job-runner](05-scheduler.md).

Considere também um `startupProbe` se o boot demorar: ele suspende o liveness
até o processo ficar de pé pela primeira vez, evitando reinício durante uma
inicialização lenta.

## Testes

[`test/health.route.test.ts`](../test/health.route.test.ts) cobre, com o módulo
`src/db/mssql` mockado:

- `/health` responde `200` com `uptimeSeconds` numérico;
- `/health` é público (responde sem qualquer header de autenticação);
- `/health` continua `200` com o banco fora — **e sequer consulta o banco**
  (é a asserção que trava a separação liveness/readiness);
- `/health` responde a `HEAD`;
- `/health/ready` responde `200`/`ok` com o banco online;
- `/health/ready` responde `503`/`degraded` com o banco offline;
- o motivo da falha aparece fora de produção;
- a rota não cai se o check lançar (responde `500`);
- a transição online → offline → online é acompanhada corretamente.

Ver [capítulo 09](09-testes.md) para como rodar.

## Upgrades futuros sem quebrar o que existe

**Adicionar uma dependência ao readiness** — o formato já foi desenhado para
isso. `checks` é um objeto com uma chave por dependência:

```ts
const [banco, fila] = await Promise.all([verificarSaudeDb(), verificarSaudeFila()]);
const ok = banco.ok && fila.ok;

return {
  status: ok ? 'ok' : 'degraded',
  uptimeSeconds: Math.floor(process.uptime()),
  checks: {
    database: { ok: banco.ok, latencyMs: banco.latenciaMs },
    queue: { ok: fila.ok, latencyMs: fila.latenciaMs },
  },
};
```

Use `Promise.all`, não `await` sequencial: o tempo total do readiness passa a
ser o do check mais lento, e não a soma. Todo check novo segue o mesmo
contrato interno — nunca lançar, sempre devolver `{ ok, latenciaMs, erro? }` —
e o handler é quem traduz isso para as chaves do corpo da resposta, que ficam
em inglês por serem contrato externo ([índice](README.md#4-o-código-é-em-português-a-fronteira-não)).

**Distinguir dependência crítica de opcional** — nem toda dependência justifica
`503`. Um cache fora deixa o serviço lento, não inoperante. Adicione
`critico: boolean` por check e componha o status apenas com os críticos,
expondo os demais como informação.

**Cachear o resultado por alguns segundos** — com `periodSeconds: 10` o custo
atual é baixo, mas se o readiness ganhar vários checks, vale memoizar por ~5s.
Cuidado: um cache longo demais faz o readiness mentir por mais tempo do que o
`failureThreshold` leva para agir.

**Expor a versão da aplicação** — útil para confirmar qual build está no ar.
Injete via variável de ambiente (`APP_VERSION`, preenchida pela pipeline com o
SHA do commit) em vez de importar o `package.json`: importar JSON de fora de
`src/` complica o `rootDir` do build ([capítulo 01](01-typescript-e-build.md)).
Exponha no readiness, não no liveness.

**Expor métricas de jobs no health** (último sucesso por job, fila de atraso) —
tentador, mas é outra responsabilidade. Health responde sim/não para o
orquestrador; métrica é série temporal. O lugar certo é um `GET /metrics` no
formato Prometheus, com `@fastify/metrics` ou `prom-client`. Continua sendo
somente leitura, então não conflita com a arquitetura.

Esse é também o caminho para o alerta que a estrutura ainda não tem: hoje, se
um job **parar de rodar**, nada avisa. Falha gera log; ausência de execução não
gera nada. Um contador por job, com alerta de "sem sucesso há mais de N horas",
fecha esse buraco.

**Proteger o readiness** — não coloque autenticação nele: o kubelet não tem
como enviar credencial e o pod ficaria permanentemente `NotReady`. Se o
conteúdo preocupar, a proteção certa é de rede (NetworkPolicy / ingress), não
de aplicação. A omissão do `error` em produção já cobre o risco principal.
