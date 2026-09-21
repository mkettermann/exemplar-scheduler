# 01 — TypeScript e build

[← Índice](README.md) · [Próximo: Configuração de ambiente →](02-configuracao-de-ambiente.md)

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

Os dois são separados de propósito: o build de produção não pode enxergar
`test/`, senão os testes acabariam dentro de `dist/`.

## Decisões que valem entender

### CommonJS, não ESM

```jsonc
"module": "CommonJS",
"moduleResolution": "Node",
```

Escolha deliberada: o time vem de um repositório legado em CommonJS. Trocar
módulo, linguagem e estrutura ao mesmo tempo é uma variável a mais para
depurar. O código ESM moderno (`await import`, top-level await) **não funciona**
aqui — se precisar dele, veja a seção de upgrades.

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

**Migrar de CommonJS para ESM** — é a mudança mais invasiva desta estrutura.
Em ordem:
1. `"type": "module"` no `package.json`.
2. `"module": "Node16"` (ou `NodeNext`) e `"moduleResolution": "Node16"`.
3. Todo import relativo passa a exigir extensão: `from './env'` vira
   `from './env.js'` (`.js` mesmo em arquivo `.ts` — é o caminho de saída).
4. `import sql from 'mssql'` pode precisar virar
   `import * as sql from 'mssql'`, dependendo de como o pacote expõe o default.
5. `require()` deixa de existir; `__dirname` também.

Faça em um commit separado, sem nenhuma outra mudança junto, e confirme com
`npm run build && npm start` antes de mergear. `vitest.config.mts` já é ESM e
não precisa mudar.

**Trocar `tsx` por outro runner** (`ts-node`, `node --experimental-strip-types`)
— só afeta o script `dev`. O Node 24 já roda `.ts` nativamente com
`--experimental-strip-types`, mas sem watch integrado nem suporte a alguns
recursos de TS (enums, decorators). Enquanto isso não estabilizar, `tsx` é a
escolha de menor atrito.

**Adicionar paths/aliases** (`@/config/env`) — exige `paths` no `tsconfig.json`
**e** um resolvedor em runtime (`tsconfig-paths`, ou o `alias` do build). Como
a estrutura tem no máximo três níveis de profundidade, o ganho é pequeno e o
custo é uma peça a mais para manter. Evite até o projeto crescer.
