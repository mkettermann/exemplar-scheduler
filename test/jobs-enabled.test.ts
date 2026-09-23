import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `JOBS_ENABLED` é a chave que desliga os jobs em qualidade/homologação, e o
 * risco dela é de leitura: uma string mal interpretada liga jobs num ambiente
 * onde não deveriam rodar. Ver `docs/02-configuracao-de-ambiente.md`.
 */
const VALOR_DO_SETUP = process.env.JOBS_ENABLED;

async function carregarAmbienteCom(valor?: string) {
  vi.resetModules();

  if (valor === undefined) {
    delete process.env.JOBS_ENABLED;
  } else {
    process.env.JOBS_ENABLED = valor;
  }

  const { ambiente } = await import('../src/config/env.js');
  return ambiente;
}

afterEach(() => {
  if (VALOR_DO_SETUP === undefined) {
    delete process.env.JOBS_ENABLED;
  } else {
    process.env.JOBS_ENABLED = VALOR_DO_SETUP;
  }
  vi.resetModules();
});

describe('JOBS_ENABLED', () => {
  it('ausente, assume `true` — o comportamento de quem nunca declarou a variável', async () => {
    const ambiente = await carregarAmbienteCom(undefined);

    expect(ambiente.JOBS_ENABLED).toBe(true);
  });

  it.each(['true', '1'])('liga os jobs com `%s`', async (valor) => {
    const ambiente = await carregarAmbienteCom(valor);

    expect(ambiente.JOBS_ENABLED).toBe(true);
  });

  it.each(['false', '0'])('desliga os jobs com `%s`', async (valor) => {
    const ambiente = await carregarAmbienteCom(valor);

    expect(ambiente.JOBS_ENABLED).toBe(false);
  });

  it.each(['False', 'TRUE', 'sim', ''])(
    'derruba o boot com `%s`, em vez de adivinhar o que foi pedido',
    async (valor) => {
      const saida = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit');
      }) as never);
      vi.spyOn(console, 'error').mockImplementation(() => { });

      await expect(carregarAmbienteCom(valor)).rejects.toThrow('process.exit');
      expect(saida).toHaveBeenCalledWith(1);
    },
  );
});
