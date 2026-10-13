import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * O SDK `applicationinsights` inteiro é falso aqui: o que se prova é o
 * **wrapper** - instância única, a configuração aplicada, a ordem entre ela e
 * o `start()`, a tradução de cada `track*` para o contrato do SDK e a
 * garantia de nunca derrubar um job. Que a telemetria chegue ao portal é
 * afirmação sobre o Azure, não sobre este módulo.
 *
 * A instância é estado de módulo e lê `APPINSIGHTSKEY` no import, então cada
 * teste recarrega `appInsights.ts` (e `env.ts`) com `vi.resetModules()`.
 * Ver `docs/13-application-insights.md`.
 */
const METODOS_DE_CONFIGURACAO = [
  'setInternalLogging',
  'setSendLiveMetrics',
  'setAutoDependencyCorrelation',
  'setAutoCollectRequests',
  'setAutoCollectPerformance',
  'setAutoCollectExceptions',
  'setAutoCollectDependencies',
  'setAutoCollectConsole',
  'setUseDiskRetryCaching',
  'setAzureMonitorOptions',
] as const;

/** Existem na 3.x, mas são ignoradas com aviso no boot - o wrapper não as chama. */
const METODOS_IGNORADOS_NA_3X = ['setDistributedTracingMode'] as const;

type MetodoDeConfiguracao = (typeof METODOS_DE_CONFIGURACAO)[number];

const mocks = vi.hoisted(() => ({
  cliente: {
    config: {} as Record<string, unknown>,
    trackTrace: vi.fn(),
    trackException: vi.fn(),
    trackEvent: vi.fn(),
    trackMetric: vi.fn(),
    trackDependency: vi.fn(),
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
    get defaultClient() {
      return mocks.cliente;
    },
    setup: mocks.setup,
    start: mocks.start,
  },
}));

vi.mock('../logger/logger.js', () => ({ logger: mocks.logger }));

const CHAVE_ORIGINAL = process.env.APPINSIGHTSKEY;
const IKEY = '11111111-2222-3333-4444-555555555555';
const CONNECTION_STRING = `InstrumentationKey=${IKEY};IngestionEndpoint=https://brazilsouth-1.in.applicationinsights.azure.com/`;

/** Devolve um `appInsights.ts` recém-carregado com a chave pedida. */
async function carregarCom(chave?: string) {
  vi.resetModules();

  if (chave === undefined) {
    delete process.env.APPINSIGHTSKEY;
  } else {
    process.env.APPINSIGHTSKEY = chave;
  }

  return import('./appInsights.js');
}

function metodo(nome: MetodoDeConfiguracao | (typeof METODOS_IGNORADOS_NA_3X)[number]) {
  return mocks.configuracao[nome]!;
}

const DEPENDENCIA = {
  nome: 'sp_ProcessarCobranca',
  tipo: 'SQL',
  alvo: 'sql-hml.database.windows.net',
  duracaoMs: 120,
  sucesso: true,
};

beforeEach(() => {
  mocks.cliente.config = {};
  mocks.configNoStart = undefined;

  for (const nome of [...METODOS_DE_CONFIGURACAO, ...METODOS_IGNORADOS_NA_3X]) {
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
  vi.useRealTimers();

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
      'APPINSIGHTSKEY ausente - Application Insights desligado',
    );
  });

  it('todo comando vira no-op - o job segue sem telemetria', async () => {
    const { appInsightsInstance } = await carregarCom();

    expect(() => {
      appInsightsInstance.trackTrace('antes da procedure');
      appInsightsInstance.trackException(new Error('falhou'));
      appInsightsInstance.trackEvent('lote-processado');
      appInsightsInstance.trackMetric('registros', 10);
      appInsightsInstance.trackDependency(DEPENDENCIA);
    }).not.toThrow();
    await expect(appInsightsInstance.descarregar()).resolves.toBeUndefined();

    expect(mocks.cliente.trackTrace).not.toHaveBeenCalled();
    expect(mocks.cliente.trackException).not.toHaveBeenCalled();
    expect(mocks.cliente.trackEvent).not.toHaveBeenCalled();
    expect(mocks.cliente.trackMetric).not.toHaveBeenCalled();
    expect(mocks.cliente.trackDependency).not.toHaveBeenCalled();
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

  it('embrulha uma iKey pura em connection string - a 3.x só aceita esse formato', async () => {
    await carregarCom(IKEY);

    expect(mocks.setup).toHaveBeenCalledWith(`InstrumentationKey=${IKEY}`);
  });

  it.each<[MetodoDeConfiguracao, unknown[]]>([
    ['setInternalLogging', [false]],
    ['setSendLiveMetrics', [false]],
    ['setAutoDependencyCorrelation', [true]],
    ['setAutoCollectRequests', [false]],
    ['setAutoCollectPerformance', [true, false]],
    ['setAutoCollectExceptions', [true]],
    ['setAutoCollectDependencies', [true]],
    ['setAutoCollectConsole', [true]],
    ['setUseDiskRetryCaching', [true]],
    ['setAzureMonitorOptions', [{ tracesPerSecond: 0 }]],
  ])('%s(%j) antes do start', async (nome, argumentos) => {
    await carregarCom(CONNECTION_STRING);

    expect(metodo(nome)).toHaveBeenCalledTimes(1);
    expect(metodo(nome)).toHaveBeenCalledWith(...argumentos);
    expect(metodo(nome).mock.invocationCallOrder[0]).toBeLessThan(
      mocks.start.mock.invocationCallOrder[0]!,
    );
  });

  it.each(METODOS_IGNORADOS_NA_3X)('não chama %s - a 3.x ignora e avisa no boot', async (nome) => {
    await carregarCom(CONNECTION_STRING);

    expect(metodo(nome)).not.toHaveBeenCalled();
  });

  it('só a amostragem vai no config, e antes do start - a 3.x o lê uma vez, dentro dele', async () => {
    await carregarCom(CONNECTION_STRING);

    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.configNoStart).toEqual({ samplingPercentage: 100 });
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
  it('sem severidade, envia como Information', async () => {
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
  ] as const)('severidade %i vai pelo nome, %s - é o que a 3.x espera', async (severidade, nome) => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackTrace('mensagem', severidade);

    expect(mocks.cliente.trackTrace).toHaveBeenCalledWith({ message: 'mensagem', severity: nome });
  });
});

describe('trackException', () => {
  it('envia o Error como veio, com severidade Error por padrão', async () => {
    const erro = new Error('fornecedor fora do ar');
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackException(erro);

    expect(mocks.cliente.trackException).toHaveBeenCalledWith({
      exception: erro,
      severity: 'Error',
    });
  });

  it('leva propriedades e severidade quando informadas', async () => {
    const erro = new Error('conexão perdida');
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackException(erro, { job: 'cobranca', status: 'falha' }, 4);

    expect(mocks.cliente.trackException).toHaveBeenCalledWith({
      exception: erro,
      severity: 'Critical',
      properties: { job: 'cobranca', status: 'falha' },
    });
  });

  it.each<[string, unknown, string]>([
    ['string', 'falhou feio', 'falhou feio'],
    ['undefined', undefined, 'undefined'],
    ['objeto', { codigo: 42 }, '[object Object]'],
  ])('converte um throw de %s em Error - o catch entrega unknown', async (_tipo, lancado, mensagem) => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackException(lancado);

    const { exception } = mocks.cliente.trackException.mock.calls[0]![0] as { exception: Error };
    expect(exception).toBeInstanceOf(Error);
    expect(exception.message).toBe(mensagem);
  });
});

describe('trackEvent', () => {
  it('envia o nome, sem propriedades quando não há', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackEvent('lote-processado');

    expect(mocks.cliente.trackEvent).toHaveBeenCalledWith({ name: 'lote-processado' });
  });

  it('leva as propriedades quando informadas', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackEvent('lote-processado', { lote: 'L-2026-10', registros: 120 });

    expect(mocks.cliente.trackEvent).toHaveBeenCalledWith({
      name: 'lote-processado',
      properties: { lote: 'L-2026-10', registros: 120 },
    });
  });
});

describe('trackMetric', () => {
  it('envia nome e valor, sem propriedades quando não há', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackMetric('registros-enviados', 120);

    expect(mocks.cliente.trackMetric).toHaveBeenCalledWith({ name: 'registros-enviados', value: 120 });
  });

  it('leva as propriedades quando informadas', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackMetric('registros-enviados', 0, { job: 'cobranca' });

    expect(mocks.cliente.trackMetric).toHaveBeenCalledWith({
      name: 'registros-enviados',
      value: 0,
      properties: { job: 'cobranca' },
    });
  });
});

describe('trackDependency', () => {
  it('traduz os campos para o contrato do SDK, omitindo os opcionais ausentes', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackDependency(DEPENDENCIA);

    expect(mocks.cliente.trackDependency).toHaveBeenCalledWith({
      name: 'sp_ProcessarCobranca',
      dependencyTypeName: 'SQL',
      target: 'sql-hml.database.windows.net',
      duration: 120,
      success: true,
    });
  });

  it('leva dados, código de resultado e propriedades quando informados', async () => {
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    appInsightsInstance.trackDependency({
      ...DEPENDENCIA,
      sucesso: false,
      dados: 'EXEC sp_ProcessarCobranca',
      codigoResultado: 0,
      propriedades: { job: 'cobranca' },
    });

    expect(mocks.cliente.trackDependency).toHaveBeenCalledWith({
      name: 'sp_ProcessarCobranca',
      dependencyTypeName: 'SQL',
      target: 'sql-hml.database.windows.net',
      duration: 120,
      success: false,
      data: 'EXEC sp_ProcessarCobranca',
      resultCode: 0,
      properties: { job: 'cobranca' },
    });
  });
});

describe('falha do SDK não derruba o job', () => {
  it.each([
    ['trackTrace', 'trace', (ai: AppInsightsCarregado) => ai.trackTrace('mensagem')],
    ['trackException', 'exceção', (ai: AppInsightsCarregado) => ai.trackException(new Error('x'))],
    ['trackEvent', 'evento', (ai: AppInsightsCarregado) => ai.trackEvent('evento')],
    ['trackMetric', 'métrica', (ai: AppInsightsCarregado) => ai.trackMetric('metrica', 1)],
    ['trackDependency', 'dependência', (ai: AppInsightsCarregado) => ai.trackDependency(DEPENDENCIA)],
  ] as const)('%s que lança vira warn', async (nomeNoSdk, tipo, chamar) => {
    const erro = new Error('exporter indisponível');
    mocks.cliente[nomeNoSdk].mockImplementation(() => {
      throw erro;
    });
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    expect(() => chamar(appInsightsInstance)).not.toThrow();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { err: erro },
      `Falha ao enviar ${tipo} ao Application Insights`,
    );
  });
});

describe('descarregar', () => {
  it('espera o flush terminar e não deixa temporizador para trás', async () => {
    vi.useFakeTimers();
    let terminou = false;
    mocks.cliente.flush.mockImplementation(async () => {
      await Promise.resolve();
      terminou = true;
    });
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    await appInsightsInstance.descarregar();

    expect(mocks.cliente.flush).toHaveBeenCalledTimes(1);
    expect(terminou).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flush que não termina é abandonado no prazo, e o encerramento segue', async () => {
    vi.useFakeTimers();
    mocks.cliente.flush.mockReturnValue(new Promise<void>(() => { }));
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    const descarga = appInsightsInstance.descarregar();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('não descarregou'));

    await vi.advanceTimersByTimeAsync(1);

    await expect(descarga).resolves.toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      'Application Insights não descarregou em 5000ms - seguindo sem esperar',
    );
  });

  it.each([
    ['rejeita', () => Promise.reject(new Error('canal quebrado'))],
    ['lança', () => {
      throw new Error('canal quebrado');
    }],
  ])('flush que %s é logado, não trava o encerramento', async (_modo, flush) => {
    mocks.cliente.flush.mockImplementation(flush);
    const { appInsightsInstance } = await carregarCom(CONNECTION_STRING);

    await expect(appInsightsInstance.descarregar()).resolves.toBeUndefined();
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { err: new Error('canal quebrado') },
      'Falha ao descarregar o Application Insights',
    );
  });
});

type AppInsightsCarregado = Awaited<ReturnType<typeof carregarCom>>['appInsightsInstance'];
