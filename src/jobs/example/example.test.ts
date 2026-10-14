import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MODELO de teste de job + serviço - apague junto com a pasta `example/`. Um
 * arquivo por pasta de job: o mock fica só na fronteira de infraestrutura
 * (aqui, o logger e o `mssql.ts`) e o job é exercitado passando pelo serviço real, porque um
 * `vi.mock` do serviço valeria para o arquivo inteiro e esvaziaria os testes
 * dele. Lock, timeout e classificação de erro ficam para `job-runner.test.ts`.
 * Ver `docs/09-testes.md` e `docs/12-exemplo-job-e-servico.md`.
 */
const mocks = vi.hoisted(() => ({
  obterPoolDb: vi.fn(),
  requisicao: {
    input: vi.fn(),
    query: vi.fn(),
  },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('../../logger/logger.js', () => ({ logger: mocks.logger }));

vi.mock('../../db/mssql.js', () => ({
  obterPoolDb: mocks.obterPoolDb,
  fecharPoolDb: vi.fn(),
  verificarSaudeDb: vi.fn(),
  sql: { Int: 'Int', NVarChar: 'NVarChar' },
}));

import { coletarResumoDoProcesso } from './example.service.js';
import { jobExemplo } from './example.job.js';
import { jobs } from '../jobs.js';

const MB = 1024 * 1024;

/** Fixa o uso de heap e o uptime que o serviço vai ler. */
function processoCom(heapUsedMb: number, uptimeSegundos: number): void {
  vi.spyOn(process, 'memoryUsage').mockReturnValue({
    rss: 0,
    heapTotal: 0,
    heapUsed: heapUsedMb * MB,
    external: 0,
    arrayBuffers: 0,
  });
  vi.spyOn(process, 'uptime').mockReturnValue(uptimeSegundos);
}

/** Valor que a `ParametroGeral` devolve para `LOG_EXEMPLO`; `null` = sem linha. */
function parametroLogExemplo(valor: number | null): void {
  mocks.requisicao.query.mockResolvedValue({
    recordset: valor === null ? [] : [{ ParametroGeralID: 'LOG_EXEMPLO', ValorParametro: valor }],
  });
}

beforeEach(() => {
  mocks.obterPoolDb.mockResolvedValue({ request: () => mocks.requisicao });
  mocks.requisicao.input.mockReturnValue(mocks.requisicao);
  parametroLogExemplo(null);
});

describe('coletarResumoDoProcesso', () => {
  it('resume memória em MB e uptime em segundos inteiros', async () => {
    processoCom(100.4, 61.9);

    expect(await coletarResumoDoProcesso()).toEqual({
      uptimeSegundos: 61,
      memoriaMb: 100,
      acimaDoLimite: false,
    });
  });

  it('abaixo do limite não avisa', async () => {
    processoCom(512, 10);

    const resumo = await coletarResumoDoProcesso();

    expect(resumo.acimaDoLimite).toBe(false);
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  it('acima de 512 MB marca o resumo e avisa no log', async () => {
    processoCom(513, 10);

    const resumo = await coletarResumoDoProcesso();

    expect(resumo.acimaDoLimite).toBe(true);
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      { resumo },
      'Uso de memória acima do limite configurado',
    );
  });

  it('LOG_EXEMPLO positivo loga o valor do parâmetro', async () => {
    processoCom(50, 1);
    parametroLogExemplo(3);

    await coletarResumoDoProcesso();

    expect(mocks.logger.info).toHaveBeenCalledWith(
      { valorParametro: 3 },
      'Valor do parâmetro LOG_EXEMPLO',
    );
  });

  it.each([
    ['zero', 0],
    ['ausente', null],
  ])('LOG_EXEMPLO %s não loga', async (_, valor) => {
    processoCom(50, 1);
    parametroLogExemplo(valor);

    await coletarResumoDoProcesso();

    expect(mocks.logger.info).not.toHaveBeenCalled();
  });
});

describe('jobExemplo', () => {
  it('só roda em desenvolvimento - um modelo não dispara em ambiente compartilhado', () => {
    expect(jobExemplo.ambientes).toEqual(['development']);
  });

  it('executa o serviço e loga o resumo', async () => {
    processoCom(50, 1);

    await jobExemplo.executar();

    expect(mocks.logger.info).toHaveBeenCalledWith(
      { resumo: { uptimeSegundos: 1, memoriaMb: 50, acimaDoLimite: false } },
      'example-job executado',
    );
  });

  it('não trata o erro do serviço - isso é do job-runner', async () => {
    vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('falhou');
    });

    await expect(jobExemplo.executar()).rejects.toThrow('falhou');
  });
});
