# 12 — Exemplo de job e serviço

[← Utilitários](10-utilitarios.md) ·
[Índice](README.md)

> **Este capítulo documenta material descartável.**
> [`example.job.ts`](../src/jobs/example.job.ts),
> [`example.service.ts`](../src/services/example.service.ts) e **este arquivo**
> existem para mostrar o formato. Ao implementar o sistema de verdade, apague
> os três e remova a linha do índice.
>
> Jobs e serviços reais **não** ganham capítulo próprio — a documentação deles
> é o código tipado mais o comentário no topo do arquivo. O que precisa estar
> documentado é a estrutura, e ela já está nos capítulos 01 a 11.

## O par job + serviço

A estrutura separa duas responsabilidades que costumam vir misturadas no código
legado:

| Peça | Responde | Arquivo |
| --- | --- | --- |
| **Job** | *Quando* rodar, por quanto tempo, sob qual nome | `src/jobs/*.job.ts` |
| **Serviço** | *O que* fazer | `src/services/*.service.ts` |

A separação tem um efeito prático imediato: a regra de negócio fica testável sem
esperar o cron e sem subir o Fastify. É a diferença entre um teste de 3ms e um
teste que não existe.

## O serviço

```ts
// src/services/example.service.ts
const LIMITE_MEMORIA_MB = 512;

export async function coletarResumoDoProcesso(): Promise<ResumoDoProcesso> {
  const memoriaMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  return {
    uptimeSegundos: Math.floor(process.uptime()),
    memoriaMb,
    acimaDoLimite: memoriaMb > LIMITE_MEMORIA_MB,
  };
}
```

Três características que todo serviço desta estrutura compartilha:

1. **Exporta uma função com retorno tipado.** Nada de classe com estado; o
   estado compartilhado do processo mora no pool de conexão, não no serviço.
2. **As fontes de dados são declaradas aqui dentro.** `LIMITE_MEMORIA_MB` é uma
   constante do código. Poderia ser uma variável do
   [`esquemaAmbiente`](02-configuracao-de-ambiente.md) ou uma consulta ao banco
   ([capítulo 04](04-banco-de-dados.md)). O que **não** pode é vir de uma
   requisição HTTP — este serviço não tem endpoint que receba conteúdo.
3. **Não sabe que existe um job.** A função pode ser chamada por outro serviço,
   por um teste ou por vários jobs diferentes.

### Onde entra a regra dos endpoints hardcoded

O ponto de arquitetura mais importante desta estrutura
([índice](README.md#2-a-superfície-http-é-somente-leitura)): **o scheduler
nunca recebe conteúdo de fora**. Ele consulta fontes que ele próprio declara.

Quando um job precisar falar com um sistema externo, o formato é este:

```ts
// A origem é constante do código; o caminho pode variar dentro do serviço,
// nunca a partir de entrada externa.
const ERP_BASE_URL = 'https://erp.interno.empresa.com/api/v1';

export async function buscarPedidosPendentes(): Promise<Pedido[]> {
  const resposta = await fetch(`${ERP_BASE_URL}/pedidos?status=pendente`, {
    headers: { Authorization: `Bearer ${ambiente.ERP_TOKEN}` },
    // Sempre um teto: sem isso, uma chamada pendurada segura o job
    // até o tempoLimiteMs do runner, e mesmo depois continua rodando.
    signal: AbortSignal.timeout(10_000),
  });

  if (!resposta.ok) {
    throw new Error(`ERP respondeu ${resposta.status}`);
  }

  return esquemaPedido.array().parse(await resposta.json());
}
```

Quatro pontos desse trecho valem como regra geral:

- **URL base constante** ou vinda do `esquemaAmbiente` validado — nunca de
  parâmetro externo. Isso elimina uma classe inteira de SSRF por construção.
- **Segredo pelo `ambiente`**, nunca no código.
- **`AbortSignal.timeout`** em toda chamada de rede. O `tempoLimiteMs` do
  [job-runner](05-scheduler.md) para de *esperar*, mas não interrompe a
  chamada; só o `AbortSignal` interrompe de fato.
- **Resposta validada com zod** antes de ser usada. Um sistema externo pode
  mudar o contrato sem avisar, e o TypeScript não protege contra o que vem da
  rede — `resposta.json()` é `any`.

## O job

```ts
// src/jobs/example.job.ts
export const jobExemplo: DefinicaoJob = {
  nome: 'example-job',
  agendamento: '*/5 * * * *',
  tempoLimiteMs: 30_000,
  executar: async () => {
    const resumo = await coletarResumoDoProcesso();
    logger.info({ resumo }, 'example-job executado');
  },
};
```

O `executar` faz duas coisas: chama o serviço e loga o resultado. Não trata
erro, não mede tempo, não adquire lock, não grava histórico — o
[job-runner](05-scheduler.md) já faz tudo isso em volta.

Se o handler estiver com `try/catch`, medição de duração ou verificação de
"já está rodando", ele está reimplementando o runner.

## Migrando um job do repositório legado

1. **Crie o serviço** em `src/services/nome.service.ts` e cole a lógica de
   negócio lá. Tipe as entradas e saídas que antes não tinham tipo — é o
   momento em que os contratos implícitos aparecem.
2. **Crie o job** em `src/jobs/nome.job.ts`, com `executar` chamando o serviço.
3. **Ajuste `tempoLimiteMs`** para algo realista. Olhe quanto o job legado leva
   no pior dia, não na média, e dê folga.
4. **Ajuste `agendamento`**, atento ao fuso ([capítulo 05](05-scheduler.md) —
   container sem `TZ` roda em UTC).
5. **Registre** em [`src/jobs/jobs.ts`](../src/jobs/jobs.ts).
6. **Rode em dry-run** (logando o que faria, sem efeito real) em paralelo com o
   job legado por alguns ciclos. Compare os logs.
7. **Só então** desative o job no repositório legado.

O passo 6 é o que mais economiza tempo. Os dois sistemas coexistindo por
alguns dias revelam diferença de fuso, de conexão e de dado — que aparecem
sozinhas no comparativo, em vez de aparecerem como incidente.

## Checklist antes de apagar o exemplo

- [ ] `src/jobs/example.job.ts` removido
- [ ] `src/services/example.service.ts` removido
- [ ] `jobExemplo` removido do array em `src/jobs/jobs.ts`
- [ ] `docs/12-exemplo-job-e-servico.md` removido
- [ ] Linha 12 removida do índice em `docs/README.md`
- [ ] `npm run typecheck && npm test && npm run build` passando

Nada mais referencia o exemplo: ele foi mantido nas pontas da estrutura
justamente para sair sem deixar rastro.
