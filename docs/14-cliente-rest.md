# 14 - Cliente REST

[← Application Insights](13-application-insights.md) ·
[Índice](README.md)

## Biblioteca

Nenhuma. [`src/shared/uteis/fetch_uteis.ts`](../src/shared/uteis/fetch_uteis.ts)
é código próprio sobre o `fetch` nativo do Node 24, trazido do legado e
revisado. O contrato da resposta é conferido com [`zod`](https://zod.dev/), que
já é dependência do projeto ([capítulo 02](02-configuracao-de-ambiente.md)).

## Responsabilidade

Dar aos serviços dos jobs um jeito curto e uniforme de chamar sistemas externos:

- um atalho por verbo HTTP, cada um com a regra de corpo daquele verbo;
- uma resposta sempre no mesmo formato, `RestResposta`, que **nunca lança** -
  falha de rede, timeout e status de erro viram `ok: false`;
- o grupo `Rest.Validar`, que confere a resposta com um schema zod e devolve a
  mesma `RestResposta`, com o `data` já tipado pelo schema.

## As três camadas

```text
Rest.Validar.Post / Get / Put / Patch / Delete
  │  headers e contrato (schema zod) de cada chamada
  ▼
POST / GET / PUT / PATCH / DELETE / HEAD / OPTIONS
  │  regra do verbo: envia corpo ou não
  ▼
RequestLogger → Request → fetch
     normaliza a resposta, loga erro      monta headers e corpo
```

Headers e validador ficam no nível mais alto de propósito. O fluxo mais comum
nos jobs são **duas chamadas em sequência**: a primeira envia uma chave e recebe
um token, a segunda vai para outra URL com esse token no header. Cada chamada
tem os próprios headers e o próprio contrato, então os dois entram como
parâmetro de cada chamada, e não como configuração da classe:

```ts
import { z } from 'zod';
import { Rest } from '../../shared/uteis/fetch_uteis.js';

const esquemaToken = z.object({ token: z.string().min(1) });
const esquemaEnvio = z.object({ protocolo: z.string().min(1) });

const auth = await Rest.Validar.Post(URL_AUTENTICACAO, { apiKey }, esquemaToken);
if (!auth.ok) throw new Error(`Autenticação falhou (status ${auth.status}): ${auth.statusText}`);

const resultado = await Rest.Validar.Post(
  URL_ENVIO, registro, esquemaEnvio, { Authorization: `Bearer ${auth.data.token}` },
);
```

Depois de checar `ok`, o TypeScript já sabe que `auth.data` é
`{ token: string }`: o tipo vem do schema, sem genérico escrito à mão e sem
`!`.

## Regras de cada verbo

| Verbo | Assinatura | Envia corpo | Lê corpo da resposta |
| --- | --- | --- | --- |
| `GET` | `(url, headers?, options?)` | Não | Sim |
| `HEAD` | `(url, headers?, options?)` | Não | Não - `data` é sempre `null`; o que importa está em `headers` |
| `POST` | `(url, payload, headers?, options?)` | Sim, `payload` em JSON | Sim |
| `PUT` | `(url, payload, headers?, options?)` | Sim, o recurso **inteiro** | Sim |
| `PATCH` | `(url, payload, headers?, options?)` | Sim, só os campos alterados | Sim |
| `DELETE` | `(url, headers?, options?)` | Não | Sim, quando houver; `204` vira `data: null` |
| `OPTIONS` | `(url, headers?, options?)` | Não | Sim; os verbos aceitos vêm no header `Allow` |

O `Rest.Validar` segue a mesma divisão, com o validador **obrigatório** logo
depois do que identifica o pedido: `Validar.Post`, `Validar.Put` e
`Validar.Patch` recebem `(url, payload, validador, headers?, options?)`;
`Validar.Get` e `Validar.Delete` recebem `(url, validador, headers?, options?)`.
`HEAD` e `OPTIONS` não entram no grupo, porque não há corpo para validar.

Por que `DELETE` não envia corpo: a especificação HTTP
([RFC 9110, seção 9.3.5](https://www.rfc-editor.org/rfc/rfc9110#section-9.3.5))
diz que corpo em `DELETE` não tem significado definido, e proxies e servidores
podem descartá-lo. O que identifica o recurso vai na URL.

## O que vem em `RestResposta`

| Campo | Conteúdo |
| --- | --- |
| `ok` | `true` só para status 2xx; no `Rest.Validar`, só para 2xx **dentro do contrato** |
| `data` | Corpo lido quando `ok`; `null` em erro, em corpo vazio e no `HEAD`. No `Rest.Validar`, o resultado do `parse` |
| `status` | Status HTTP; `0` quando nem houve resposta |
| `statusText` | Do servidor; `'Sucesso'` ou `'Erro de status desconhecido'` se vier vazio (HTTP/2); `'Erro de conexão'`, `'Tempo esgotado'` ou `'Requisição abortada'` quando não houve resposta; `'Resposta fora do contrato'` quando o `Rest.Validar` recusa um 2xx |
| `url`, `payload` | O que foi pedido, para facilitar o log de quem chama |
| `headers` | Headers da resposta (ausente quando não houve resposta) |

`RestResposta<T>` é uma união por `ok`: com `ok: true`, `data` é `T`; com
`ok: false`, é `null`. Nos verbos, `T` é `unknown`; no `Rest.Validar`, é o tipo
de saída do schema.

O corpo é lido assim: binário (`application/pdf`, `image/*`, `octet-stream`)
volta como `Blob`; o resto é lido como texto e devolvido como objeto quando é
JSON válido, ou como string quando não é. Corpo vazio vira `null`.

## Headers

Todo pedido sai com `Content-Type: application/json`. Os headers são somados
nesta ordem, e o último vence quando a chave se repete (sem diferença de
maiúsculas):

1. o padrão `Content-Type: application/json`;
2. `options.headers`;
3. o parâmetro `headers`.

## Validação de contrato

O `Rest.Validar` e `validarRetornoZod(schema, dado)` aceitam qualquer schema
zod - objeto, lista, união. O retorno e o erro seguem os verbos: o `Rest.Validar`
**nunca lança** e loga o problema; quem decide o que fazer com `ok: false` é o
serviço.

- Resposta de erro (status fora de 2xx, falha de rede, timeout) volta igual à
  do verbo, sem passar pelo schema.
- Resposta 2xx fora do contrato volta com `ok: false`, `data: null`, o
  **status original** e `statusText: 'Resposta fora do contrato'`. O status
  preservado separa "o parceiro recusou" (`401`, `500`) de "o parceiro aceitou
  mas respondeu outra coisa" (`200`).
- Resposta 2xx dentro do contrato volta com `data` igual ao **resultado do
  `parse`**: campos fora do schema saem, e `z.coerce` e `default` se aplicam.
  O tipo de `data` é o mesmo que o zod infere, então o que o TypeScript promete
  é exatamente o que chega.

Para manter um campo que o job não confere, declare-o no schema ou use
`.passthrough()`.

Um serviço que precisa transformar `ok: false` em erro para o
[job-runner](05-scheduler.md) faz isso numa linha, com `status` e `statusText`
na mensagem - veja o
[`example-envio`](12-exemplo-job-e-servico.md#um-terceiro-serviço-post-autenticado).

## Log

- **Debug** (`Rest: requisição`): só URL e verbo. Headers e corpo ficam de fora
  porque carregam token e dado de cliente.
- **Erro**: status fora de 2xx, falha de conexão e resposta fora do contrato.
  Na falha de contrato vão só as `issues` do zod, nunca o objeto recebido.

Os campos são estruturados, sem códigos de cor, para a busca no Log Analytics
([capítulo 03](03-logger.md)).

## Timeout

Toda chamada tem prazo. Sem `signal` em `options`, o `getFetchOptions` cria um
`AbortSignal.timeout(REST_TIMEOUT_MS)` - padrão de **180000 ms (3 minutos)**,
ajustável por ambiente ([capítulo 02](02-configuracao-de-ambiente.md)). O
estouro volta como `ok: false` e `statusText: 'Tempo esgotado'`, sem lançar.

O prazo existe porque o `tempoLimiteMs` do job **não** interrompe a chamada: ele
para de esperar, mas o `fetch` continua rodando e segurando a trava do job
([capítulo 05](05-scheduler.md)). Sem um `signal`, uma API pendurada só seria
cortada pelos limites de inatividade do `fetch` do Node - 5 minutos sem
receber dados, e um servidor que manda um byte de vez em quando nunca cai neles.

O padrão é largo de propósito: os jobs chamam APIs lentas e procedures longas,
e um prazo curto cortaria chamadas legítimas. Uma chamada que precisa de outro
prazo passa o próprio `signal`, que **substitui** o padrão - para mais ou para
menos:

```ts
// mais curto: autenticação deve responder rápido
await Rest.Validar.Post(url, { apiKey }, esquema, undefined, { signal: AbortSignal.timeout(10_000) });

// mais longo: exportação que o parceiro gera na hora
await Rest.GET(url, headers, { signal: AbortSignal.timeout(15 * 60_000) });
```

Duas regras sobre o prazo:

- **Ele cobre a chamada inteira**, inclusive a leitura do corpo. Uma resposta
  grande que ainda está chegando quando o prazo estoura é cortada.
- **Um `signal` próprio não soma com o padrão.** Quem passa um
  `AbortController` para cancelar a chamada por outro motivo assume também o
  prazo: combine os dois com `AbortSignal.any([controlador.signal,
  AbortSignal.timeout(ms)])` se quiser as duas coisas.

## Compatibilidade com o legado

Os atalhos `POST` e `GET` mantêm a assinatura; as variantes `POST_Valido` e
`GET_Valido` foram **removidas** em favor do `Rest.Validar`. O que mudou de
comportamento:

| Antes | Agora | Impacto em quem já usa |
| --- | --- | --- |
| `POST_Valido(url, payload, headers?, validador?, options?)` e `GET_Valido(url, headers?, validador?, options?)` devolviam só o dado cru, ou `null` | `Rest.Validar.Post(url, payload, validador, headers?, options?)` e `Rest.Validar.Get(url, validador, headers?, options?)` devolvem `RestResposta` com o dado do `parse` | **Quebra de assinatura e de retorno.** Troque a chamada, mova o validador para logo depois de `url`/`payload`, cheque `.ok` em vez de `null` e leia `.data`. Campos fora do schema deixam de chegar; declare-os ou use `.passthrough()` |
| `RestResposta` era uma interface com `ok: boolean` e `data: unknown` | União por `ok`, genérica no tipo de `data` | Quem só lê a resposta não muda. Quem monta uma `RestResposta` à mão (num teste, por exemplo) precisa de `ok: true` ou `ok: false` literal |
| `PUT(url, headers?, options?)` e `PATCH(url, headers?, options?)` enviavam sempre o corpo `"null"` | Recebem `payload` como segundo parâmetro | **Quebra de assinatura.** Uma chamada antiga `PUT(url, headers)` passa a enviar os headers **como corpo**. Revise toda chamada a `PUT`/`PATCH` antes de atualizar |
| `DELETE` e `OPTIONS` enviavam o corpo `"null"` | Não enviam corpo | Nenhum para APIs que seguem a especificação |
| Resposta 2xx que não era JSON virava `data: null` | Vira string, ou `Blob` se binária | Quem valida com schema continua recebendo falha (a string não passa no schema) |
| `headers` repetido era anexado (`application/json, text/plain`) | O último vence | Corrige `Content-Type` personalizado |
| `options.headers` apagava todos os headers montados | É somado aos demais | Corrige `Content-Type` e token que sumiam |
| `options.method` podia trocar o verbo do atalho | O verbo do atalho vence | Nenhum esperado |
| `validarRetornoZod` aceitava só `ZodObject` | Aceita qualquer schema zod | Nenhum - o tipo ficou mais largo |
| Log no `console.log` com os headers inteiros | `logger.debug` com URL e verbo | O token deixa de aparecer no log |
| Mensagens de erro `(Validador Retorno) Formato Invalido.` e afins | Prefixo `Rest:` | Alertas que filtrem pelo texto antigo precisam ser ajustados |
| Ficava em `src/shared/fetch_uteis.ts` | Fica em `src/shared/uteis/fetch_uteis.ts` | Imports precisam do novo caminho |

`getFetchOptions`, `getFetchResponse` e `validarRetornoZod` continuam
exportadas com a mesma assinatura.

## Testes

[`fetch_uteis.test.ts`](../src/shared/uteis/fetch_uteis.test.ts) troca o
`fetch` global por `vi.stubGlobal` e o logger por um falso, e tem um `describe`
por função exportada. O que se prova:

- o que chega ao `fetch` em cada verbo: método, headers mesclados, corpo;
- o prazo: `REST_TIMEOUT_MS` sem `signal`, o `signal` da chamada quando vier,
  e um prazo novo a cada chamada;
- a leitura do corpo: JSON, texto, binário, vazio e `HEAD`;
- a normalização: 2xx, status de erro, falha de rede, timeout e abort;
- que o log nunca leva headers, corpo nem o objeto que falhou no contrato;
- o `Rest.Validar`: dado do `parse`, 2xx fora do contrato como `ok: false`
  com o status original, e erro do verbo repassado sem tocar no schema;
- o fluxo de duas chamadas, com o token da primeira no header da segunda.

## Upgrades futuros sem quebrar o que existe

**Corpo que não é JSON** (`FormData`, `URLSearchParams`) - hoje todo payload
passa por `JSON.stringify`. Para suportar, envie sem serializar quando o payload
já for um desses tipos, e retire o `Content-Type` padrão nesse caso (o `fetch`
define o certo sozinho).

**Retentativa** - não coloque aqui. Repetir um `POST` pode duplicar um envio; a
decisão de repetir é do job, que conhece a regra de negócio.
