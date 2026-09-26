# 07 — Servidor HTTP

[← Lock distribuído](06-lock-distribuido.md) ·
[Índice](README.md) ·
[Próximo: Health check →](08-health-check.md)

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
| [`openapi.yaml`](../openapi.yaml) | Documentação OpenAPI das rotas — só documentação |

### `construirApp()` separado de `listen()`

```ts
// src/server/app.ts
export async function construirApp(): Promise<FastifyInstance> { ... }
```

A instância é montada em um lugar e o `listen` acontece em
[`server.ts`](../src/server.ts). Essa separação existe para os testes: eles
chamam `construirApp()` e usam `app.inject()`, sem porta, sem processo extra, sem
race de inicialização. Se `construirApp` e `listen` estivessem juntos, todo teste
de rota precisaria subir um servidor real.

### O mapa de rotas

```ts
export async function registrarRotas(app: FastifyInstance): Promise<void> {
  app.get('/health', obterLiveness);
  app.get('/health/ready', obterReadiness);
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

O hook é chamado **diretamente** em `construirApp`, não via `app.register()`.
Motivo: `register` cria um escopo encapsulado no Fastify, e um hook adicionado
lá dentro não vale para as rotas registradas fora dele. Direto no root, vale
para tudo.

## Documentação OpenAPI

| Pacote | Versão | Documentação | Uso |
| --- | --- | --- | --- |
| `yaml` | `^2.9` | [eemeli.org/yaml](https://eemeli.org/yaml/) | Lê o spec no teste (dev) |
| `ajv` | `^8.20` | [ajv.js.org](https://ajv.js.org/) | Valida as respostas contra o spec no teste (dev) |

O padrão da casa é todo serviço ter o seu Swagger, e este tem:
[`openapi.yaml`](../openapi.yaml), na raiz, em OpenAPI 3.1. Aqui ele é
**apenas documentação**, e isso tem três consequências deliberadas:

- **Não roteia.** Em outros serviços o spec é a fonte das rotas, com o
  `operationId` apontando para o handler. Aqui o mapa continua sendo
  [`routes.ts`](../src/server/routes.ts), escrito à mão. O `operationId`
  existe no spec só como identificador, com o nome do handler por
  conveniência.
- **Não é servido.** Não há Swagger UI nem `/docs/json`: seriam rotas novas
  numa superfície que foi desenhada para ter duas. Para visualizar, abra o
  arquivo no editor (extensão OpenAPI/Swagger do VS Code) ou cole em
  [editor.swagger.io](https://editor.swagger.io/).
- **Não vai para a imagem.** O `Dockerfile` copia o arquivo só para o estágio
  `verify`, onde o teste de contrato roda.

### Por que ele não fica desatualizado

Documentação que não é executada apodrece. O teste
[`openapi.contrato.test.ts`](../test/openapi.contrato.test.ts) trava o spec à
realidade de dois jeitos:

1. **Rotas** — registra `registrarRotas` numa instância limpa, coleta as rotas
   pelo hook `onRoute` e compara com os `paths` do spec. Rota nova sem
   documentação, ou documentada e removida, reprova. (`HEAD` fica fora da
   comparação: o Fastify o cria sozinho para cada `GET`.)
2. **Respostas** — chama as rotas reais e valida o corpo com `ajv` contra o
   schema documentado para aquele status. Os schemas usam
   `additionalProperties: false`, então um campo novo na resposta que não
   entrou no spec também reprova.

Ao mudar uma rota ou o corpo de uma resposta, o fluxo é: altere o código,
rode `npm test`, e o teste diz o que falta no `openapi.yaml`.

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
`src/server/routes/x.route.ts`, exporte o handler, registre uma linha em
`routes.ts` e documente a rota no `openapi.yaml` (o teste de contrato cobra).
Valide toda query com zod, mesmo para um número:
`Number('abc')` daria `NaN` e seguiria adiante silenciosamente.

```ts
const esquemaConsulta = z.object({
  limite: z.coerce.number().int().positive().max(500).default(50),
});

export const obterAlgo = async (requisicao: FastifyRequest) => {
  const { limite } = esquemaConsulta.parse(requisicao.query);
  // ...
};
```

**Se a rota nova precisar de autenticação, ela provavelmente não é deste
serviço.** Toda a superfície HTTP aqui é pública e anônima de propósito: são
duas rotas de health, que o orquestrador precisa alcançar sem credencial.
Consulta operacional, painel e relatório pertencem à API principal, que já tem
autenticação de usuário, autorização e auditoria — e não a uma chave estática
guardada em variável de ambiente, que não rotaciona, não identifica quem
chamou e vaza inteira junto com o primeiro `.env` exposto.

**Adicionar schema de resposta às rotas** — o Fastify serializa 2 a 3 vezes
mais rápido com `schema.response` declarado, e o schema funciona como filtro:
campo não declarado não sai na resposta. É a forma mais barata de garantir que
um campo novo não vaze sem querer. Se for adotado, dá para gerar esses schemas
a partir de `components.schemas` do `openapi.yaml`, mantendo uma fonte só.

**Servir o Swagger UI** — se um dia for exigido, `@fastify/swagger` com
`mode: 'static'` apontando para o `openapi.yaml`, mais `@fastify/swagger-ui`.
Isso adiciona rotas: atualize o teste de superfície em
[`read-only.guard.test.ts`](../test/read-only.guard.test.ts) e prefira expor
só fora de produção.

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
