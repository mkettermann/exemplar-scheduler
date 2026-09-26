import { defineConfig } from 'vitest/config';

/* Configuração do runner. Ver docs/09-testes.md, em especial o papel do
   `setupFiles` e por que a cobertura não exclui nada de `src/`. */
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
      // Piso que reprova `test:coverage` e o `docker build`. Ver
      // docs/09-testes.md, seção "Cobertura".
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 80,
      },
    },
  },
});
