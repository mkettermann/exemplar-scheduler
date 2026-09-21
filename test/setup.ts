/**
 * Ambiente mínimo para os testes.
 *
 * `src/config/env.ts` roda a validação no momento do import e chama
 * `process.exit(1)` se algo faltar — por isso estes valores precisam existir
 * antes de qualquer `import` de dentro de `src/`. É o que o `setupFiles`
 * do vitest garante.
 *
 * Nenhum destes valores conecta em nada: os testes mockam `src/db/mssql`.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DB_SERVER = 'localhost';
process.env.DB_PORT = '1433';
process.env.DB_NAME = 'scheduler_test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.DB_ENCRYPT = 'false';
