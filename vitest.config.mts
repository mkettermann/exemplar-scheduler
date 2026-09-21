import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Preenche as variáveis de ambiente ANTES de qualquer import de src/,
    // porque `src/config/env.ts` valida e derruba o processo na importação.
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Entrypoint, jobs e serviços de exemplo não entram na métrica:
      // são código de fiação ou material descartável do template.
      exclude: ['src/server.ts', 'src/jobs/**', 'src/services/**', 'src/util/**'],
    },
  },
});
