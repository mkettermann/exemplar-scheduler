# 01 — TypeScript e build

[← Índice](README.md) ·
[Próximo: Configuração de ambiente →](02-configuracao-de-ambiente.md)

## Bibliotecas

| Pacote | Versão | Papel |
| --- | --- | --- |
| [`typescript`](https://www.typescriptlang.org/docs/) | `^5.7` | Compilador e checador de tipos |
| [`tsx`](https://tsx.is/) | `^4.19` | Executa `.ts` direto em desenvolvimento, com watch |
| [`@types/node`](https://www.npmjs.com/package/@types/node) | `^24` | Tipos da biblioteca padrão do Node |

## Responsabilidade

Garantir que o código escrito não chegue quebrado em produção e que o ciclo de
desenvolvimento não exija um passo de build manual.

Há duas execuções distintas do mesmo código:

- **Desenvolvimento** — `npm run dev` usa `tsx watch`, que transpila em memória
  e reinicia ao salvar. Não gera `dist/`. Não faz checagem de tipos (é um
  transpilador, não o compilador).
- **Produção** — `npm run build` roda o `tsc` de verdade, gera `dist/` e
  `npm start` executa `node dist/server.js`. Aqui o erro de tipo **quebra o
  build**, que é onde ele deve quebrar.

Como o `tsx` não checa tipos, `npm run typecheck` existe para isso e deve rodar
no CI. Sem ele, um erro de tipo só apareceria no build de deploy.

## Arquivos

| Arquivo | Para quê |
| --- | --- |
| [`tsconfig.json`](../tsconfig.json) | Configuração do build de produção. `include` cobre apenas `src/` |
| [`tsconfig.test.json`](../tsconfig.test.json) | Só checagem (`noEmit`), cobre `src/` **e** `test/` |
| [`package.json`](../package.json) | `"type": "module"` — é o que faz o Node tratar `dist/*.js` como ESM |

Os dois `tsconfig` são separados de propósito: o build de produção não pode
enxergar `test/`, senão os testes acabariam dentro de `dist/`.

## Decisões que valem entender

### ESM nativo, não CommonJS

```jsonc
// package.json
"type": "module",

// tsconfig.json
"module": "NodeNext",
"moduleResolution": "NodeNext",
"verbatimModuleSyntax": true,
```

O serviço é ESM puro. `NodeNext` faz o TypeScript resolver módulos do mesmo
jeito que o Node 24 resolve em runtime — respeitando o campo `exports` de cada
pacote —, então o que compila aqui é o que carrega lá. `await import()` e
top-level await funcionam; `require()` e `__dirname` não existem.

Duas consequências no dia a dia:

- **Todo import relativo leva extensão `.js`** — `from './env.js'`, mesmo
  dentro de um arquivo `.ts`. O caminho escrito é o do arquivo **emitido**, não
  o do fonte. Sem a extensão o `npm run typecheck` acusa na hora; se passasse,
  o erro só apareceria no `node dist/server.js`.
- **Pacote CommonJS entra por import default** — `import sql from 'mssql'` traz
  o `module.exports` inteiro, que é o que o Node entrega ao ler um CJS a partir
  de ESM. `esModuleInterop` mantém o tipo alinhado com esse comportamento.

`verbatimModuleSyntax` é a trava contra regressão: o compilador não apaga nem
reescreve import nenhum, então import de tipo exige `import type` (como já está
no código) e um `import x = require()` deixa de compilar em vez de virar um
`dist/` que não carrega.

### Modo estrito completo, e além

```jsonc
"strict": true,
"noUncheckedIndexedAccess": true,
"noImplicitOverride": true,
"noImplicitReturns": true,
"noFallthroughCasesInSwitch": true,
"noUnusedLocals": true,
"noUnusedParameters": true,
"exactOptionalPropertyTypes": true,
```

Como o time comenta pouco o código, o compilador vira a documentação viva do
formato dos objetos. Duas flags costumam surpreender quem vem de JS puro:

- **`noUncheckedIndexedAccess`** — `arr[0]` tem tipo `T | undefined`. Você é
  obrigado a tratar o array vazio. É o que impede um `Cannot read property of
  undefined` às 3h da manhã.
- **`exactOptionalPropertyTypes`** — `{ error?: string }` aceita a chave ausente
  ou uma `string`, mas **não** `error: undefined`. Por isso o código monta
  objetos opcionais com spread condicional:

  ```ts
  ...(detalhe !== undefined ? { error: detalhe } : {})
  ```

### Alvo ES2023

`target` e `lib` em `ES2023` porque `engines.node` exige Node ≥ 24. Nada é
transpilado para baixo à toa, o stack trace bate com o código fonte
(`sourceMap: true` está ligado).

## Upgrades futuros sem quebrar o que existe

**Subir a versão do TypeScript (minor/patch)** — seguro. Rode
`npm i -D typescript@latest`, depois `npm run typecheck`. Versões novas
costumam apertar inferências; o erro que aparecer é quase sempre um bug real
que estava escondido.

**Subir a versão major do Node** — ajuste `engines.node`, `target` e `lib`
juntos. Deixar `target` para trás não quebra nada (só gera código mais
conservador), mas deixar `lib` para trás faz o TS não reconhecer APIs novas.

**Usar um pacote que só publica CommonJS** — funciona sem gambiarra, desde que
o import seja o default: `import pkg from 'pacote'`, e os nomes saem de `pkg`.
O que pode falhar é `import { algo } from 'pacote'`, quando o analisador
estático do Node não consegue enxergar aquele nome dentro do CJS. O erro
aparece só em runtime (`SyntaxError: Named export 'algo' not found`), nunca no
`typecheck` — a correção é trocar pelo import default e desestruturar depois.

**Precisar de `__dirname` ou `require()`** — não existem em ESM, e os
substitutos ficam no próprio Node:

```ts
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
```

São escape hatches, não padrão da casa. Se aparecerem com frequência, o
problema está na dependência, não no formato de módulo.

**Trocar `tsx` por outro runner** (`ts-node`, `node --experimental-strip-types`)
— só afeta o script `dev`. O Node 24 já roda `.ts` nativamente com
`--experimental-strip-types`, mas sem watch integrado nem suporte a alguns
recursos de TS (enums, decorators). Enquanto isso não estabilizar, `tsx` é a
escolha de menor atrito.

**Adicionar paths/aliases** (`@/config/env`) — exige `paths` no `tsconfig.json`
**e** um resolvedor em runtime (`tsconfig-paths`, ou o `alias` do build). Como
a estrutura tem no máximo três níveis de profundidade, o ganho é pequeno e o
custo é uma peça a mais para manter. Evite até o projeto crescer.
