import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `env.ts` valida `process.env` no import, então cada caso recarrega o módulo
 * com a variável ajustada. Ver `docs/02-configuracao-de-ambiente.md`.
 */
const CAMPOS_DE_CONEXAO = ['DB_SERVER', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
const VARIAVEIS = [...CAMPOS_DE_CONEXAO, 'JOBS_ENABLED'] as const;
type Variavel = (typeof VARIAVEIS)[number];

const VALORES_DO_SETUP = Object.fromEntries(
  VARIAVEIS.map((variavel) => [variavel, process.env[variavel]]),
) as Record<Variavel, string | undefined>;

async function carregarCom(variavel: Variavel, valor?: string) {
  vi.resetModules();

  if (valor === undefined) {
    delete process.env[variavel];
  } else {
    process.env[variavel] = valor;
  }

  const { ambiente } = await import('./env.js');
  return ambiente;
}

async function esperaDerrubarBoot(variavel: Variavel, valor?: string) {
  const saida = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit');
  }) as never);
  vi.spyOn(console, 'error').mockImplementation(() => { });

  await expect(carregarCom(variavel, valor)).rejects.toThrow('process.exit');
  expect(saida).toHaveBeenCalledWith(1);
}

afterEach(() => {
  for (const variavel of VARIAVEIS) {
    const original = VALORES_DO_SETUP[variavel];

    if (original === undefined) {
      delete process.env[variavel];
    } else {
      process.env[variavel] = original;
    }
  }

  vi.resetModules();
});

/**
 * Os campos de conexão passam por `textoObrigatorio`, que recusa espaço e
 * quebra de linha nas pontas. O caso que motivou o guard: um bloco `|` (sem
 * hífen) num Secret do Kubernetes preserva o `\n` final, e `'senha\n'`
 * satisfaria um `.min(1)` puro — o boot passaria e o banco recusaria a
 * conexão com uma mensagem que se lê como senha errada.
 */
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

  it.each(CAMPOS_DE_CONEXAO)('protege também `%s`, que vem do mesmo manifesto', async (campo) => {
    await esperaDerrubarBoot(campo, 'valor\n');
  });
});

/**
 * `JOBS_ENABLED` é a chave que desliga os jobs em qualidade/homologação, e o
 * risco dela é de leitura: uma string mal interpretada liga jobs num ambiente
 * onde não deveriam rodar.
 */
describe('JOBS_ENABLED', () => {
  it('ausente, assume `true` — o comportamento de quem nunca declarou a variável', async () => {
    const ambiente = await carregarCom('JOBS_ENABLED', undefined);

    expect(ambiente.JOBS_ENABLED).toBe(true);
  });

  it.each(['true', '1'])('liga os jobs com `%s`', async (valor) => {
    const ambiente = await carregarCom('JOBS_ENABLED', valor);

    expect(ambiente.JOBS_ENABLED).toBe(true);
  });

  it.each(['false', '0'])('desliga os jobs com `%s`', async (valor) => {
    const ambiente = await carregarCom('JOBS_ENABLED', valor);

    expect(ambiente.JOBS_ENABLED).toBe(false);
  });

  it.each(['False', 'TRUE', 'sim', ''])(
    'derruba o boot com `%s`, em vez de adivinhar o que foi pedido',
    async (valor) => {
      await esperaDerrubarBoot('JOBS_ENABLED', valor);
    },
  );
});
