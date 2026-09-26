import { defineConfig } from 'vitest/config';

/* Configuração do runner. Ver docs/09-testes.md, em especial o papel do
   `setupFiles`. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
