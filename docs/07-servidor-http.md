# 07 — Servidor HTTP

[← Lock distribuído](06-lock-distribuido.md) · [Índice](README.md) · [Próximo: Health check →](08-health-check.md)

## Biblioteca

| Pacote | Versão | Documentação |
| --- | --- | --- |
| `fastify` | `^5.1` | [fastify.dev/docs/latest](https://fastify.dev/docs/latest/) · [repositório](https://github.com/fastify/fastify) |

Por que um servidor HTTP em um serviço de jobs: o Kubernetes precisa de um
endpoint para as probes de liveness e readiness. Sem ele, o AKS não tem como
saber se o pod está saudável. **É a única razão.** Este serviço não tem API.

Por que Fastify e não Express: `app.inject()`. Ele permite bater nas rotas em
teste sem abrir porta TCP, que é exatamente o que os testes do
[capítulo 09](09-testes.md) fazem. Somado ao baixo overhead e ao suporte nativo
a schema de validação, compensa.

## Responsabilidade

| Arquivo | Papel |
| --- | --- |
| [`app.ts`](../src/server/app.ts) | Monta a instância **sem** subir o servidor |
| [`routes.ts`](../src/server/routes.ts) | Mapa explícito de todas as rotas |
| [`plugins/read-only.ts`](../src/server/plugins/read-only.ts) | Recusa verbos de escrita |
| [`routes/health.route.ts`](../src/server/routes/health.route.ts) | Os dois handlers de health |

### `buildApp()` separado de `listen()`

```ts
// src/server/app.ts
export async function buildApp(): Promise<FastifyInstance> { ... }
```

A instância é montada em um lugar e o `listen` acontece em
[`server.ts`](../src/server.ts). Essa separação existe para os testes: eles
chamam `buildApp()` e usam `app.inject()`, sem porta, sem processo extra, sem
race de inicialização. Se `buildApp` e `listen` estivessem juntos, todo teste
de rota precisaria subir um servidor real.

### O mapa de rotas

```ts
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', getHealth);
  app.get('/health/ready', getReadiness);
}
```

Todo endpoint do serviço aparece aqui, com método, caminho e handler na mesma
linha. Para saber **o que existe**, basta este arquivo; para saber **como
funciona**, aí sim entra-se no arquivo do handler.

## Endpoints

| Método | Rota | Auth | Resposta |
| --- | --- | --- | --- |
| `GET` | `/health` | pública | `200` sempre que o processo está vivo |
| `GET` | `/health/ready` | pública | `200` ou `503` conforme as dependências |

São dois, e a intenção é que continuem sendo dois. Ver
[capítulo 08](08-health-check.md) para o comportamento de cada um.

Não há autenticação em nenhum deles porque não há o que proteger: as respostas
expõem `uptime` e o estado de saúde do banco, e o kubelet — que é quem chama —
não tem como carregar credencial. Se o serviço ficar alcançável fora do
cluster, a proteção correta é de rede (NetworkPolicy / ingress), não de
aplicação.

## A guarda somente-leitura

```ts
const METODOS_PERMITIDOS = new Set(['GET', 'HEAD', 'OPTIONS']);
```

Um hook `onRequest` global recusa qualquer outro verbo com `405`, antes de
qualquer handler e antes do roteamento.

Isso é redundante hoje — não existe rota de escrita, então o Fastify já
responderia `404`. A redundância é o ponto: a regra deixa de depender da
disciplina de quem escreve a próxima rota. Se daqui a um ano alguém adicionar
um `app.post('/rodar-job')` para "facilitar um teste", o hook derruba a
requisição antes do handler, e o teste em
[`read-only.guard.test.ts`](../test/read-only.guard.test.ts) falha no CI
explicando o porquê.

O hook é chamado **diretamente** em `buildApp`, não via `app.register()`.
Motivo: `register` cria um escopo encapsulado no Fastify, e um hook adicionado
lá dentro não vale para as rotas registradas fora dele. Direto no root, vale
para tudo.

## Outras opções do Fastify em uso

```ts
Fastify({ logger: false, bodyLimit: 1024, trustProxy: true })
```

- **`logger: false`** — o logging é do pino próprio ([capítulo 03](03-logger.md)).
  O Fastify tem pino embutido, mas ligá-lo criaria uma segunda instância com
  configuração própria: dois formatos de log no mesmo serviço.
- **`bodyLimit: 1024`** — sem rota de escrita, não existe corpo legítimo.
  Segunda linha de defesa atrás da guarda de verbos.
- **`trustProxy: true`** — o ingress do AKS é quem fala com o cliente real.
  Sem isso, `req.ip` seria sempre o IP do balanceador. **Só mantenha ligado
  enquanto houver de fato um proxy confiável na frente:** exposto direto, o
  cliente passa a poder forjar o próprio IP via `X-Forwarded-For`.

## Upgrades futuros sem quebrar o que existe

**Antes de adicionar qualquer rota, pergunte se ela precisa existir aqui.**
Este serviço tem uma superfície mínima por decisão de arquitetura
([índice](README.md)), e o custo de cada endpoint novo não é o código: é o que
ele passa a expor e a permitir. Consulta operacional, painel e relatório
pertencem à API principal do sistema, que já tem autenticação de usuário,
autorização e auditoria.

**Nunca** adicione rota que receba conteúdo. Disparo manual de job, alteração
de agenda e ativação/desativação entram por configuração e deploy, não por
HTTP.

**Adicionar uma rota de consulta, quando for mesmo o caso** — crie
`src/server/routes/x.route.ts`, exporte o handler e registre uma linha em
`routes.ts`. Valide toda query com zod, mesmo para um número:
`Number('abc')` daria `NaN` e seguiria adiante silenciosamente.

```ts
const querySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(50),
});

export const getAlgo = async (req: FastifyRequest) => {
  const { limit } = querySchema.parse(req.query);
  // ...
};
```

**Proteger uma rota nova com chave** — se a rota exigir autenticação, o formato
abaixo é um `preHandler` reutilizável. Ele foi removido da estrutura junto com
o endpoint administrativo, mas fica registrado aqui porque a parte sutil é a
comparação:

```ts
// src/server/middlewares/require-admin-key.ts
import { timingSafeEqual } from 'node:crypto';

function chaveConfere(recebida: string, esperada: string): boolean {
  const a = Buffer.from(recebida);
  const b = Buffer.from(esperada);
  // timingSafeEqual exige buffers do mesmo tamanho; o tamanho não é segredo.
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAdminKey(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const recebida = req.headers['x-admin-key'];
  if (typeof recebida !== 'string' || !chaveConfere(recebida, env.ADMIN_API_KEY)) {
    reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  done();
}
```

Use `timingSafeEqual`, não `!==`. A comparação nativa de strings retorna assim
que encontra o primeiro caractere diferente, e essa diferença de microssegundos
é mensurável na rede — dá para descobrir a chave caractere por caractere.

Adotando isso, some: `ADMIN_API_KEY` no `envSchema` com `.min(8)`
([capítulo 02](02-configuracao-de-ambiente.md)), o caminho
`req.headers["x-admin-key"]` no `redact` do logger
([capítulo 03](03-logger.md)), `@fastify/rate-limit` na rota (sem isso a chave
fica exposta a força bruta) e um teste de `401` na suíte
([capítulo 09](09-testes.md)). Uma chave estática sem rotação é o piso, não o
alvo: o passo seguinte é um token do Entra ID validado por JWKS.

**Adicionar schema de resposta às rotas** — o Fastify serializa 2 a 3 vezes
mais rápido com `schema.response` declarado, e o schema funciona como filtro:
campo não declarado não sai na resposta. É a forma mais barata de garantir que
um campo novo não vaze sem querer.

**Cabeçalhos de segurança** — `@fastify/helmet`. Ganho pequeno para duas rotas
de health, mas é uma linha e costuma ser exigido em revisão de segurança.

**Expor métricas** — um `GET /metrics` no formato Prometheus
(`@fastify/metrics` ou `prom-client`) continua sendo somente leitura e não
conflita com a arquitetura. É o lugar certo para "último sucesso por job" e
"duração da última execução" — e não o health, que responde sim/não para o
orquestrador.

**Subir o Fastify para a v6** — os pontos de atenção históricos são a assinatura
dos hooks e o encapsulamento de plugins, o que aqui afeta um arquivo só:
`plugins/read-only.ts`. Os testes em
[`test/read-only.guard.test.ts`](../test/read-only.guard.test.ts) cobrem esse
caminho, então uma quebra aparece no `npm test` antes de chegar ao deploy.
