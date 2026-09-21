/**
 * Ambiente mínimo dos testes, preenchido antes de qualquer import de `src/`.
 * Ver `docs/09-testes.md` para o porquê de isto rodar via `setupFiles`.
 */
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DB_SERVER = 'localhost';
process.env.DB_PORT = '1433';
process.env.DB_NAME = 'scheduler_test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test';
process.env.DB_ENCRYPT = 'false';
