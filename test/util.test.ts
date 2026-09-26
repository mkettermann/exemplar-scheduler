import { describe, expect, it, vi } from 'vitest';
import { Util } from '../src/util/util.js';

/**
 * Helpers puros, sem mock. O que se prova aqui é o comportamento herdado do
 * legado — inclusive o que parece estranho, como `limparOA` mutar o objeto
 * recebido e remover a string `"undefined"`. Ver `docs/10-utilitarios.md`.
 */
const RESET = '\x1b[0m';

describe('Util.classOf', () => {
  it.each<[string, unknown, string]>([
    ['string', 'texto', 'string'],
    ['number', 42, 'number'],
    ['NaN', Number.NaN, 'nan'],
    ['NaN embrulhado em Number', new Number(Number.NaN), 'nan'],
    ['objeto', { a: 1 }, 'object'],
    ['array', [1, 2], 'array'],
    ['boolean', true, 'boolean'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['function', () => undefined, 'function'],
    ['date', new Date(0), 'date'],
    ['regexp', /a/, 'regexp'],
    ['error', new Error('x'), 'error'],
    ['symbol', Symbol('s'), 'symbol'],
    ['bigint', 10n, 'bigint'],
  ])('%s → %s', (_rotulo, valor, esperado) => {
    expect(Util.classOf(valor)).toBe(esperado);
  });
});

describe('Util.limparOA', () => {
  it('remove null, undefined, string vazia e a string "undefined"', () => {
    const objeto = { a: 1, b: null, c: undefined, d: '', e: 'undefined', f: 0, g: false };

    expect(Util.limparOA(objeto)).toEqual({ a: 1, f: 0, g: false });
  });

  it('muta o objeto recebido em vez de devolver cópia — herança do legado', () => {
    const objeto = { a: 1, b: null };

    const retorno = Util.limparOA(objeto);

    expect(retorno).toBe(objeto);
    expect(objeto).toEqual({ a: 1 });
  });

  it('limpa cada item de um array', () => {
    const lista = [{ a: 1, b: '' }, { c: null, d: 2 }];

    expect(Util.limparOA(lista)).toEqual([{ a: 1 }, { d: 2 }]);
  });

  it('é rasa: não desce em objetos aninhados', () => {
    const objeto = { interno: { a: null } };

    expect(Util.limparOA(objeto)).toEqual({ interno: { a: null } });
  });
});

describe('Util.aCadaObjExecuta', () => {
  it('aplica a função ao objeto quando não é array', () => {
    const funcao = vi.fn();
    const objeto = { a: 1 };

    const retorno = Util.aCadaObjExecuta(objeto, funcao);

    expect(funcao).toHaveBeenCalledExactlyOnceWith(objeto);
    expect(retorno).toBe(objeto);
  });

  it('aplica a função a cada item do array, na ordem', () => {
    const funcao = vi.fn();
    const lista = [{ a: 1 }, { b: 2 }];

    Util.aCadaObjExecuta(lista, funcao);

    expect(funcao.mock.calls).toEqual([[lista[0]], [lista[1]]]);
  });
});

describe('Util — cores de texto', () => {
  it.each<[string, (texto: string, semFundo?: boolean) => string, number]>([
    ['corVermelho', Util.corVermelho, 31],
    ['corVerde', Util.corVerde, 32],
    ['corAmarelo', Util.corAmarelo, 33],
    ['corAzul', Util.corAzul, 34],
    ['corMagenta', Util.corMagenta, 35],
    ['corCiano', Util.corCiano, 36],
    ['corBranco', Util.corBranco, 37],
    ['corCinza', Util.corCinza, 90],
  ])('%s usa o código ANSI %i, com fundo preto por padrão', (_nome, colorir, codigo) => {
    const colorido = `\x1b[${codigo}mtexto${RESET}`;

    expect(colorir('texto', true)).toBe(colorido);
    expect(colorir('texto')).toBe(`\x1b[40m${colorido}${RESET}`);
  });
});

describe('Util — fundos', () => {
  it.each<[string, (texto: string) => string, number]>([
    ['fundoPreto', Util.fundoPreto, 40],
    ['fundoVermelho', Util.fundoVermelho, 41],
    ['fundoVerde', Util.fundoVerde, 42],
    ['fundoAmarelo', Util.fundoAmarelo, 43],
    ['fundoAzul', Util.fundoAzul, 44],
    ['fundoMagenta', Util.fundoMagenta, 45],
    ['fundoCiano', Util.fundoCiano, 46],
    ['fundoBranco', Util.fundoBranco, 47],
    ['fundoCinza', Util.fundoCinza, 100],
  ])('%s usa o código ANSI %i', (_nome, colorir, codigo) => {
    expect(colorir('texto')).toBe(`\x1b[${codigo}mtexto${RESET}`);
  });
});
