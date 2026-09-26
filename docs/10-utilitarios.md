# 10 — Utilitários

[← Testes](09-testes.md) ·
[Índice](README.md) ·
[Próximo: Exemplo de job e serviço →](12-exemplo-job-e-servico.md)

## Biblioteca

Nenhuma. [`src/util/util.ts`](../src/util/util.ts) é código próprio, trazido do
repositório legado para manter familiaridade.

## Responsabilidade

Helpers de uso geral, hoje em dois grupos.

### Cores de terminal

`Util.corVerde`, `corVermelho`, `corAmarelo`, `corAzul`, `corMagenta`,
`corCiano`, `corBranco`, `corCinza`, e os `fundo*` correspondentes. São wrappers
de códigos ANSI:

```ts
static readonly corVerde = (texto: string, semFundo?: boolean) => {
  const colorido = `\x1b[32m${texto}\x1b[0m`;
  return semFundo ? colorido : Util.fundoPreto(colorido);
};
```

Usados em [`ciclo-de-vida.ts`](../src/ciclo-de-vida.ts) e em
[`server.ts`](../src/server.ts) para destacar a linha de boot e a falha
fatal — os dois momentos em que alguém está de fato olhando o terminal.

> **Cuidado:** esses códigos ANSI vão junto com a string para o pino. Em
> produção o log é JSON e os escapes aparecem **dentro** do campo `msg`, o que
> polui a busca no Log Analytics. Use cor apenas em mensagens de boot e de
> falha fatal, nunca em log de job. Ver upgrades.

### Manipulação de objetos

| Função | O que faz |
| --- | --- |
| `Util.classOf(valor)` | Tipo real via `Object.prototype.toString`, distinguindo `array`, `date`, `null` e `nan` — que o `typeof` não separa |
| `Util.limparOA(objetoOuArray)` | Remove chaves `null`, `undefined`, `""` e a string `"undefined"` |
| `Util.aCadaObjExecuta(objetoOuArray, funcao)` | Aplica `funcao` a um objeto ou a cada item de um array |

Duas advertências sobre `limparOA`: ela **muta** o objeto recebido (não devolve
cópia) e é rasa (não desce em objetos aninhados). Ambas são herança do código
legado, mantidas para compatibilidade de comportamento — e fixadas em
[`test/util.test.ts`](../test/util.test.ts), para que mudá-las seja uma decisão
e não um acidente.

Os membros de `Util` são `static readonly`: o legado os declarava
reatribuíveis, e nada no projeto os reatribui.

## Por que isso não é tipado como o resto

As funções de objeto usam `any` internamente, enquanto o
[`tsconfig.json`](../tsconfig.json) exige modo estrito em todo o projeto. O
motivo é que `limparOA` altera a forma do objeto em tempo de execução — algo
que o sistema de tipos não consegue descrever sem tipos condicionais bem mais
complicados que a própria função.

É uma exceção consciente e localizada. Ela **não** é precedente para usar `any`
em código novo.

## Upgrades futuros sem quebrar o que existe

**Adicionar um helper** — mantenha `Util` como classe de estáticos para não
misturar dois estilos no mesmo arquivo. Se o arquivo crescer além de uns 200
helpers de assuntos distintos, quebre por tema (`util/cores.ts`,
`util/objeto.ts`) e deixe `util.ts` reexportando, para que nenhum import
existente quebre.

**Tornar a cor sensível ao ambiente** — o ganho é imediato. Faça as funções de
cor devolverem o texto puro quando a saída não for um TTY ou quando
`NODE_ENV === 'production'`:

```ts
const usaCor = process.stdout.isTTY && ambiente.NODE_ENV !== 'production';
static readonly corVerde = (t: string) => (usaCor ? `\x1b[32m${t}\x1b[0m` : t);
```

Nenhuma chamada existente muda; o log de produção fica limpo. Atenção a um
detalhe de ordem: `util.ts` passaria a importar `config/env`, então confira que
não surge ciclo de imports (hoje `env.ts` não importa nada de `util`).

**Tornar `limparOA` imutável** — devolver uma cópia é mais seguro, mas **é uma
quebra de comportamento**: código que depende da mutação in loco para de
funcionar silenciosamente. Se for fazer, adicione `limparOACopia` ao lado e
migre os chamadores um a um, em vez de trocar a implementação existente.

**Substituir `classOf` por checagens nativas** — para a maioria dos casos,
`Array.isArray`, `value instanceof Date` e `Number.isNaN` são mais legíveis e
mais rápidos. `classOf` continua útil quando o tipo é genuinamente desconhecido
(parsing de resposta externa). Não há pressa em remover.

**Apagar o que não é usado** — se os jobs reais não usarem as cores nem as
funções de objeto, apague. Um utilitário sem uso é peso morto que ainda assim
precisa ser lido, mantido e migrado. O `noUnusedLocals` do TypeScript não pega
exports públicos, então essa limpeza é manual.
