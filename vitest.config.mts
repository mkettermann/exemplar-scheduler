import { defineConfig } from 'vitest/config';

/* Configuração do runner. Ver docs/09-testes.md, em especial o papel do
   `setupFiles` e o motivo de cada teste morar ao lado do arquivo que testa. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/*.types.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
