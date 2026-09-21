import { defineConfig } from 'vitest/config';

/* Configuração do runner. Ver docs/09-testes.md, em especial o papel do
   `setupFiles` e o motivo de cada exclusão da cobertura. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/jobs/**', 'src/services/**', 'src/util/**'],
    },
  },
});
