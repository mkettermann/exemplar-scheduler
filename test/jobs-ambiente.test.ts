import { describe, expect, it } from 'vitest';
import { separarJobsPorAmbiente } from '../src/scheduler/job-runner.js';
import type { DefinicaoJob } from '../src/scheduler/job.types.js';

/**
 * `DefinicaoJob.ambientes` é o que impede DEV, QA e HML — que compartilham o
 * mesmo banco — de dispararem o mesmo job duas vezes sobre os mesmos dados.
 * Ver `docs/05-scheduler.md`, seção "Um job, um ambiente".
 */
function jobFalso(nome: string, ambientes: DefinicaoJob['ambientes']): DefinicaoJob {
  return {
    nome,
    ambientes,
    agendamento: '*/5 * * * *',
    tempoLimiteMs: 1_000,
    executar: async () => { },
  };
}

describe('separarJobsPorAmbiente', () => {
  it('registra o job que declara o ambiente atual', () => {
    const job = jobFalso('cobranca', ['hml']);

    const { ativos, ignorados } = separarJobsPorAmbiente([job], 'hml');

    expect(ativos).toEqual([job]);
    expect(ignorados).toEqual([]);
  });

  it('o cenário que motivou o campo: job de HML não é registrado em DEV', () => {
    const job = jobFalso('cobranca', ['hml']);

    const { ativos, ignorados } = separarJobsPorAmbiente([job], 'development');

    expect(ativos).toEqual([]);
    expect(ignorados).toEqual([job]);
  });

  it('um job pode rodar em HML e PRD, que não dividem banco', () => {
    const job = jobFalso('cobranca', ['hml', 'production']);

    expect(separarJobsPorAmbiente([job], 'hml').ativos).toEqual([job]);
    expect(separarJobsPorAmbiente([job], 'production').ativos).toEqual([job]);
    expect(separarJobsPorAmbiente([job], 'qa').ativos).toEqual([]);
  });

  it('lista vazia nunca registra — desligar um job é apagar seus ambientes', () => {
    const job = jobFalso('cobranca', []);

    for (const alvo of ['development', 'qa', 'hml', 'production'] as const) {
      expect(separarJobsPorAmbiente([job], alvo).ativos).toEqual([]);
    }
  });

  it('sob `NODE_ENV=test` nenhum job fica ativo: teste não é destino de deploy', () => {
    const jobsFalsos = [jobFalso('a', ['development']), jobFalso('b', ['production'])];

    const { ativos, ignorados } = separarJobsPorAmbiente(jobsFalsos, 'test');

    expect(ativos).toEqual([]);
    expect(ignorados).toEqual(jobsFalsos);
  });

  it('separa a lista mista preservando a ordem de declaração', () => {
    const doQa = jobFalso('a', ['qa']);
    const daHml = jobFalso('b', ['hml']);
    const deAmbos = jobFalso('c', ['qa', 'hml']);

    const { ativos, ignorados } = separarJobsPorAmbiente([doQa, daHml, deAmbos], 'qa');

    expect(ativos.map((job) => job.nome)).toEqual(['a', 'c']);
    expect(ignorados.map((job) => job.nome)).toEqual(['b']);
  });
});

describe('contrato de DefinicaoJob', () => {
  it('`ambientes` é obrigatório — o compilador recusa um job que não declare', () => {
    // @ts-expect-error `ambientes` ausente. Se este erro sumir, alguém tornou o
    // campo opcional e a proteção contra disparo duplicado virou convenção.
    const semAmbientes: DefinicaoJob = {
      nome: 'esquecido',
      agendamento: '*/5 * * * *',
      tempoLimiteMs: 1_000,
      executar: async () => { },
    };

    expect(semAmbientes.nome).toBe('esquecido');
  });
});
