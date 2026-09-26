import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DefinicaoJob } from '../src/scheduler/job.types.js';

/**
 * Boot e encerramento com todas as peças falsas: o que se prova é a **ordem**
 * — banco antes dos jobs, jobs antes do HTTP; jobs em andamento antes do
 * servidor, servidor antes do pool, pool antes da telemetria — e que a
 * decisão de ambiente e de `JOBS_ENABLED` é respeitada.
 *
 * `servidor` e `encerrando` são estado de módulo, então cada teste recarrega
 * `ciclo-de-vida.ts` com `vi.resetModules()`. Ver `docs/05-scheduler.md`,
 * seção "O entrypoint: boot e encerramento".
 */
const mocks = vi.hoisted(() => ({
  ordem: [] as string[],
  ambiente: { NODE_ENV: 'hml', PORT: 3000, JOBS_ENABLED: true },
  ambienteAssumido: false,
  jobs: [] as unknown[],
  obterPoolDb: vi.fn(),
  fecharPoolDb: vi.fn(),
  separarJobsPorAmbiente: vi.fn(),
  registrarJob: vi.fn(),
  gracefulShutdown: vi.fn(),
  descarregar: vi.fn(),
  servidor: { listen: vi.fn(), close: vi.fn() },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Getter porque a fábrica roda uma vez só: um booleano copiado aqui ficaria
// congelado no valor do primeiro import.
vi.mock('../src/config/env.js', () => ({
  ambiente: mocks.ambiente,
  get ambienteAssumido() {
    return mocks.ambienteAssumido;
  },
}));

vi.mock('../src/config/appInsights.js', () => ({
  appInsightsInstance: { descarregar: mocks.descarregar },
}));

vi.mock('../src/logger/logger.js', () => ({ logger: mocks.logger }));

vi.mock('../src/db/mssql.js', () => ({
  obterPoolDb: mocks.obterPoolDb,
  fecharPoolDb: mocks.fecharPoolDb,
}));

vi.mock('../src/scheduler/job-runner.js', () => ({
  registrarJob: mocks.registrarJob,
  separarJobsPorAmbiente: mocks.separarJobsPorAmbiente,
}));

vi.mock('../src/jobs/jobs.js', () => ({ jobs: mocks.jobs }));

vi.mock('../src/server/app.js', () => ({
  construirApp: async () => mocks.servidor,
}));

vi.mock('node-schedule', () => ({
  default: { gracefulShutdown: mocks.gracefulShutdown },
}));

function jobFalso(nome: string, ambientes: DefinicaoJob['ambientes']): DefinicaoJob {
  return { nome, ambientes, agendamento: '* * * * *', tempoLimiteMs: 1_000, executar: async () => { } };
}

/** Faz o espião anotar seu nome em `mocks.ordem` quando chamado. */
function anotaOrdem(espiao: ReturnType<typeof vi.fn>, nome: string): void {
  espiao.mockImplementation(async () => {
    mocks.ordem.push(nome);
  });
}

/** Devolve um `ciclo-de-vida.ts` recém-carregado, sem servidor nem flag herdados. */
async function carregarCicloDeVida() {
  vi.resetModules();
  return import('../src/ciclo-de-vida.js');
}

/** Todas as linhas de log de um nível, juntas, para busca por trecho. */
function textoDe(espiao: ReturnType<typeof vi.fn>): string {
  return espiao.mock.calls.map(([linha]) => String(linha)).join('\n');
}

const saidaDoProcesso = vi.fn();

beforeEach(() => {
  mocks.ordem.length = 0;
  mocks.ambiente.JOBS_ENABLED = true;
  mocks.ambienteAssumido = false;
  mocks.jobs.length = 0;

  anotaOrdem(mocks.obterPoolDb, 'banco');
  anotaOrdem(mocks.fecharPoolDb, 'fechar-banco');
  anotaOrdem(mocks.gracefulShutdown, 'jobs-em-andamento');
  anotaOrdem(mocks.descarregar, 'telemetria');
  anotaOrdem(mocks.servidor.listen, 'http');
  anotaOrdem(mocks.servidor.close, 'fechar-http');
  mocks.registrarJob.mockImplementation((job: DefinicaoJob) => {
    mocks.ordem.push(`job:${job.nome}`);
  });
  mocks.separarJobsPorAmbiente.mockReturnValue({ ativos: [], ignorados: [] });

  saidaDoProcesso.mockReset();
  vi.spyOn(process, 'exit').mockImplementation(saidaDoProcesso as never);
});

describe('iniciar', () => {
  it('banco, jobs e HTTP, nessa ordem', async () => {
    const ativo = jobFalso('cobranca', ['hml']);
    mocks.separarJobsPorAmbiente.mockReturnValue({ ativos: [ativo], ignorados: [] });
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(mocks.ordem).toEqual(['banco', 'job:cobranca', 'http']);
  });

  it('escuta em todas as interfaces, na porta do ambiente', async () => {
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(mocks.servidor.listen).toHaveBeenCalledWith({ port: 3000, host: '0.0.0.0' });
  });

  it('filtra a lista central pelo NODE_ENV atual', async () => {
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(mocks.separarJobsPorAmbiente).toHaveBeenCalledWith(mocks.jobs, 'hml');
  });

  it('sem banco, não registra jobs nem sobe HTTP — falha rápido', async () => {
    mocks.obterPoolDb.mockRejectedValue(new Error('servidor inacessível'));
    const { iniciar } = await carregarCicloDeVida();

    await expect(iniciar()).rejects.toThrow('servidor inacessível');

    expect(mocks.separarJobsPorAmbiente).not.toHaveBeenCalled();
    expect(mocks.servidor.listen).not.toHaveBeenCalled();
  });

  it('anuncia quantos e quais jobs ficaram ativos', async () => {
    mocks.separarJobsPorAmbiente.mockReturnValue({
      ativos: [jobFalso('cobranca', ['hml']), jobFalso('faturamento', ['hml'])],
      ignorados: [],
    });
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(textoDe(mocks.logger.info)).toMatch(/JOBS ativos.* 2: cobranca, faturamento/);
  });

  it('loga cada job de outro ambiente, com os ambientes que ele declara', async () => {
    mocks.separarJobsPorAmbiente.mockReturnValue({
      ativos: [],
      ignorados: [jobFalso('relatorio', ['qa', 'production'])],
    });
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(textoDe(mocks.logger.info)).toContain('declara [qa, production]');
    expect(mocks.registrarJob).not.toHaveBeenCalled();
  });

  it('com JOBS_ENABLED=false, não registra nenhum job e avisa', async () => {
    mocks.ambiente.JOBS_ENABLED = false;
    mocks.jobs.push(jobFalso('cobranca', ['hml']));
    mocks.separarJobsPorAmbiente.mockReturnValue({
      ativos: [jobFalso('cobranca', ['hml'])],
      ignorados: [],
    });
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(mocks.registrarJob).not.toHaveBeenCalled();
    expect(textoDe(mocks.logger.warn)).toMatch(/1 jobs, .*JOBS_ENABLED=false.* — nenhum job ativo/);
    expect(textoDe(mocks.logger.info)).toMatch(/JOBS ativos.* 0: $/m);
    expect(mocks.servidor.listen).toHaveBeenCalled();
  });

  it('avisa quando o NODE_ENV não foi injetado e o valor é assumido', async () => {
    mocks.ambienteAssumido = true;
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(textoDe(mocks.logger.warn)).toContain("assumindo 'hml'");
  });

  it('não avisa nada quando o NODE_ENV veio da pipeline', async () => {
    const { iniciar } = await carregarCicloDeVida();

    await iniciar();

    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });
});

describe('encerrar', () => {
  it('jobs em andamento, HTTP, banco e telemetria, nessa ordem, e sai com 0', async () => {
    const { iniciar, encerrar } = await carregarCicloDeVida();
    await iniciar();
    mocks.ordem.length = 0;

    await encerrar('SIGTERM');

    expect(mocks.ordem).toEqual(['jobs-em-andamento', 'fechar-http', 'fechar-banco', 'telemetria']);
    expect(saidaDoProcesso).toHaveBeenCalledExactlyOnceWith(0);
    expect(mocks.logger.info).toHaveBeenCalledWith('Encerrando sistema... SIGTERM');
  });

  it('um segundo sinal não repete o procedimento', async () => {
    const { encerrar } = await carregarCicloDeVida();

    await encerrar('SIGTERM');
    await encerrar('SIGINT');

    expect(mocks.gracefulShutdown).toHaveBeenCalledTimes(1);
    expect(saidaDoProcesso).toHaveBeenCalledTimes(1);
  });

  it('sinal antes do HTTP subir ainda fecha o resto', async () => {
    const { encerrar } = await carregarCicloDeVida();

    await encerrar('SIGTERM');

    expect(mocks.servidor.close).not.toHaveBeenCalled();
    expect(mocks.ordem).toEqual(['jobs-em-andamento', 'fechar-banco', 'telemetria']);
    expect(saidaDoProcesso).toHaveBeenCalledWith(0);
  });

  it('falha no meio do encerramento é logada e sai com 1', async () => {
    const erro = new Error('pool travado');
    mocks.fecharPoolDb.mockRejectedValue(erro);
    const { encerrar } = await carregarCicloDeVida();

    await encerrar('SIGTERM');

    expect(mocks.logger.error).toHaveBeenCalledWith({ err: erro }, 'Falha durante o encerramento');
    expect(saidaDoProcesso).toHaveBeenCalledExactlyOnceWith(1);
  });
});
