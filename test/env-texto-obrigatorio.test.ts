import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Os campos de conexão passam por `textoObrigatorio`, que recusa espaço e
 * quebra de linha nas pontas. O caso que motivou o guard: um bloco `|` (sem
 * hífen) num Secret do Kubernetes preserva o `\n` final, e `'senha\n'`
 * satisfaria um `.min(1)` puro — o boot passaria e o banco recusaria a
 * conexão com uma mensagem que se lê como senha errada.
 * Ver `docs/02-configuracao-de-ambiente.md`.
 */
const CAMPOS = ['DB_SERVER', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
type Campo = (typeof CAMPOS)[number];

const VALORES_DO_SETUP = Object.fromEntries(
  CAMPOS.map((campo) => [campo, process.env[campo]]),
) as Record<Campo, string | undefined>;

async function carregarCom(campo: Campo, valor?: string) {
  vi.resetModules();

  if (valor === undefined) {
    delete process.env[campo];
  } else {
    process.env[campo] = valor;
  }

  const { ambiente } = await import('../src/config/env.js');
  return ambiente;
}

async function esperaDerrubarBoot(campo: Campo, valor?: string) {
  const saida = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => { });

  await expect(carregarCom(campo, valor)).rejects.toThrow('process.exit');
  expect(saida).toHaveBeenCalledWith(1);
}

afterEach(() => {
  for (const campo of CAMPOS) {
    const original = VALORES_DO_SETUP[campo];

    if (original === undefined) {
      delete process.env[campo];
    } else {
      process.env[campo] = original;
    }
  }

  vi.resetModules();
});

describe('textoObrigatorio', () => {
  it('derruba o boot com quebra de linha no fim — o bug do bloco `|` sem hífen', async () => {
    await esperaDerrubarBoot('DB_PASSWORD', 'senha\n');
  });

  it.each([' senha', 'senha ', '\tsenha', 'senha\r\n', '  '])(
    'derruba o boot com `%j`, em vez de deixar o banco recusar depois',
    async (valor) => {
      await esperaDerrubarBoot('DB_PASSWORD', valor);
    },
  );

  it('derruba o boot com string vazia — substituição que não resolveu', async () => {
    await esperaDerrubarBoot('DB_PASSWORD', '');
  });

  it('derruba o boot quando a variável está ausente', async () => {
    await esperaDerrubarBoot('DB_PASSWORD', undefined);
  });

  it('aceita espaço no meio: o guard é sobre as pontas, não sobre o conteúdo', async () => {
    const ambiente = await carregarCom('DB_PASSWORD', 'senha com espaco');

    expect(ambiente.DB_PASSWORD).toBe('senha com espaco');
  });

  it('não apara o valor — o que entra é exatamente o que o banco recebe', async () => {
    const ambiente = await carregarCom('DB_PASSWORD', 'S3nh@!#:|');

    expect(ambiente.DB_PASSWORD).toBe('S3nh@!#:|');
  });

  it.each(CAMPOS)('protege também `%s`, que vem do mesmo manifesto', async (campo) => {
    await esperaDerrubarBoot(campo, 'valor\n');
  });
});
