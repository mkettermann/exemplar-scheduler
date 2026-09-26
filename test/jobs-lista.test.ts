import { describe, expect, it } from 'vitest';
import { jobs } from '../src/jobs/jobs.js';

/**
 * Regras que valem para **todo** job da lista central, não só para o exemplo:
 * um job novo entra nesta verificação no momento em que é adicionado a
 * `jobs.ts`, sem teste próprio. Ver `docs/05-scheduler.md`.
 */
describe('lista central de jobs', () => {
  it('não tem dois jobs com o mesmo nome — o nome é a chave do lock', () => {
    const nomes = jobs.map((job) => job.nome);

    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it.each(jobs.map((job) => [job.nome, job] as const))(
    '%s declara prazo positivo e agendamento não vazio',
    (_nome, job) => {
      expect(job.tempoLimiteMs).toBeGreaterThan(0);
      expect(job.agendamento.trim()).not.toBe('');
    },
  );
});
