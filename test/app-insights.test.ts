import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O SDK `applicationinsights` inteiro é falso aqui: o que se prova é o
 * **wrapper** — instância única,  a
 * ordem entre elas e o `start()`, e o contrato de `trackTrace` de nunca
 * derrubar um job. Que a telemetria chegue ao portal é afirmação sobre o
 * Azure, não sobre este módulo.
 *
 * A instância é estado de módulo e lê `APPINSIGHTSKEY` no import, então cada
 * teste recarrega `appInsights.ts` (e `env.ts`) com `vi.resetModules()`.
 * Ver `docs/13-application-insights.md`.
 */
const METODOS_DE_CONFIGURACAO = [
  'setDistributedTracingMode',
  'setInternalLogging',
  'setSendLiveMetrics',
  'setAutoDependencyCorrelation',
  'setAutoCollectRequests',
  'setAutoCollectPerformance',
  'setAutoCollectExceptions',
  'setAutoCollectDependencies',
  'setAutoCollectConsole',
  'setUseDiskRetryCaching',
] as const;

type MetodoDeConfiguracao = (typeof METODOS_DE_CONFIGURACAO)[number];

const mocks = vi.hoisted(() => ({
  cliente: {
    config: {} as Record<string, unknown>,
    trackTrace: vi.fn(),
    flush: vi.fn(),
  },
  configuracao: {} as Record<string, ReturnType<typeof vi.fn>>,
  setup: vi.fn(),
  start: vi.fn(),
  /** Cópia de `cliente.config` no instante do `start()`. */
  configNoStart: undefined as Record<string, unknown> | undefined,
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('applicationinsights', () => ({
  default: {
    DistributedTracingModes: { AI: 0, AI_AND_W3C: 1 },
    get defaultClient() {
      return mocks.cliente;
    },
    setup: mocks.setup,
    start: mocks.start,
  },
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

const CHAVE_ORIGINAL = process.env.APPINSIGHTSKEY;
const CONNECTION_STRING =
  'InstrumentationKey=11111111-2222-3333-4444-555555555555;IngestionEndpoint=https://brazilsouth-1.in.applicationinsights.azure.com/';

/** Devolve um `appInsights.ts` recém-carregado com a chave pedida. */
async function carregarCom(chave?: string) {
  vi.resetModules();

  if (chave === undefined) {
    delete process.env.APPINSIGHTSKEY;
  } else {
    process.env.APPINSIGHTSKEY = chave;
  }

  return import('../src/config/appInsights.js');
}

function metodo(nome: MetodoDeConfiguracao) {
  return mocks.configuracao[nome]!;
}

beforeEach(() => {
  mocks.cliente.config = {};
  mocks.configNoStart = undefined;

  for (const nome of METODOS_DE_CONFIGURACAO) {
    mocks.configuracao[nome] = vi.fn(() => mocks.configuracao);
  }

  mocks.setup.mockImplementation(() => mocks.configuracao);
  mocks.start.mockImplementation(() => {
    mocks.configNoStart = { ...mocks.cliente.config };
    return mocks.configuracao;
  });
  mocks.cliente.flush.mockResolvedValue(undefined);
});

afterEach(() => {
  if (CHAVE_ORIGINAL === undefined) {
    delete process.env.APPINSIGHTSKEY;
  } else {
    process.env.APPINSIGHTSKEY = CHAVE_ORIGINAL;
  }
});

describe('sem APPINSIGHTSKEY', () => {
  it('não inicializa o SDK e avisa no log', async () => {
    const { appInsightsInstance } = await carregarCom();

    expect(appInsightsInstance.ligado).toBe(false);
    expect(mocks.setup).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'APPINSIGHTSKEY ausente — Application Insights desligado',
    );
  });

  it('trackTrace e descarregar viram no-op — o job segue sem telemetria', async () => {
    const { appInsightsInstance } = await carregarCom();

    expect(() => appInsightsInstance.trackTrace('antes da procedure')).not.toThrow();
    await expect(appInsightsInstance.descarregar()).resolves.toBeUndefined();

    expect(mocks.cliente.trackTrace).not.toHaveBeenCalled();
    expect(mocks.cliente.flush).not.toHaveBeenCalled();
  });
});

describe('setup', () => {
  it('repassa a connection string como veio', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    expect(appInsightsInstance.ligado).toBe(true);
    expect(mocks.setup).toHaveBeenCalledWith(CONNECTION_STRING);
    expect(mocks.logger.info).toHaveBeenCalledWith('Application Insights ligado');
  });

  it('embrulha uma iKey pura, que o SDK v3 não aceita sozinha', async () => {
    await carregarCom('11111111-2222-3333-4444-555555555555');

    expect(mocks.setup).toHaveBeenCalledWith(
      'InstrumentationKey=11111111-2222-3333-4444-555555555555',
    );
  });

  it.each<[MetodoDeConfiguracao, unknown[]]>([
    ['setDistributedTracingMode', [0]],
    ['setInternalLogging', [false]],
    ['setSendLiveMetrics', [false]],
    ['setAutoDependencyCorrelation', [true]],
    ['setAutoCollectRequests', [false]],
    ['setAutoCollectPerformance', [true, true]],
    ['setAutoCollectExceptions', [true]],
    ['setAutoCollectDependencies', [true]],
    ['setAutoCollectConsole', [true]],
    ['setUseDiskRetryCaching', [true]],
  ])('%s(%j) antes do start', async (nome, argumentos) => {
    await carregarCom(CONNECTION_STRING);

    expect(metodo(nome)).toHaveBeenCalledTimes(1);
    expect(metodo(nome)).toHaveBeenCalledWith(...argumentos);
    expect(metodo(nome).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0]!,
    );
  });

  it('lote e amostragem já estão no config quando o start lê a configuração', async () => {
    await carregarCom(CONNECTION_STRING);

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.configNoStart).toEqual({
      maxBatchSize: 500,
      maxBatchIntervalMs: 15_000,
      samplingPercentage: 100,
    });
  });
});

describe('instância estática', () => {
  it('obterInstancia devolve sempre a mesma, e o setup acontece uma vez', async () => {
    const { AppInsights, appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    expect(AppInsights.obterInstancia()).toBe(appInsightsInstance);
    expect(AppInsights.obterInstancia()).toBe(appInsightsInstance);
    expect(mocks.setup).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);
  });
});

describe('trackTrace', () => {
  it('sem severidade, envia como 1 (Information)', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackTrace('executando procedure X');

    expect(mocks.cliente.trackTrace).toHaveBeenCalledWith({
      message: 'executando procedure X',
      severity: 'Information',
    });
  });

  it.each([
    [0, 'Verbose'],
    [1, 'Information'],
    [2, 'Warning'],
    [3, 'Error'],
    [4, 'Critical'],
  ] as const)('severidade %i vira %s', async (severidade, nome) => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackTrace('mensagem', severidade);

    expect(mocks.cliente.trackTrace).toHaveBeenCalledWith({
      message: 'mensagem',
      severity: nome,
    });
  });

  it('falha do SDK é logada, não derruba o job', async () => {
    const erro = new Error('exporter indisponível');
    mocks.cliente.trackTrace.mockImplementation(() => {
      throw erro;
    });
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    expect(() => appInsightsInstance.trackTrace('mensagem')).not.toThrow();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { err: erro },
      'Falha ao enviar trace ao Application Insights',
    );
  });
});

describe('descarregar', () => {
  it('envia o buffer pendente', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    await appInsightsInstance.descarregar();

    expect(mocks.cliente.flush).toHaveBeenCalledTimes(1);
  });

  it('falha no flush é logada, não trava o encerramento', async () => {
    const erro = new Error('sem rede');
    mocks.cliente.flush.mockRejectedValue(erro);
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    await expect(appInsightsInstance.descarregar()).resolves.toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { err: erro },
      'Falha ao descarregar o Application Insights',
    );
  });
});
