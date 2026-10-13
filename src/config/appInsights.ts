import appInsights from 'applicationinsights';
import type { TelemetryClient } from 'applicationinsights';
import { ambiente } from './env.js';
import { logger } from '../logger/logger.js';

/**
 * Dono exclusivo do Application Insights. Nenhum outro arquivo chama
 * `appInsights.setup()`: os jobs importam `appInsightsInstance` e registram
 * `trackTrace` antes e depois de cada procedure; o job-runner registra
 * `trackException` quando um job falha.
 * Ver `docs/13-application-insights.md`.
 */

/** 0 Verbose · 1 Information · 2 Warning · 3 Error · 4 Critical. */
export type Severidade = 0 | 1 | 2 | 3 | 4;

/** O SDK 3.x espera a severidade pelo nome; o índice é a `Severidade`. */
const NOMES_DE_SEVERIDADE = ['Verbose', 'Information', 'Warning', 'Error', 'Critical'] as const;

/** Viram `customDimensions` no portal. Contagens e identificadores, nunca dado pessoal. */
export type Propriedades = Record<string, string | number | boolean>;

/** Chamada de saída que a coleta automática não enxerga - uma procedure, por exemplo. */
export interface Dependencia {
  /** Nome da operação, como aparece na lista de dependências: `sp_ProcessarCobranca`. */
  nome: string;
  /** Coluna `type` no portal: `SQL`, `HTTP`... */
  tipo: string;
  /** Servidor ou host chamado. Sem ele, o SDK tenta extrair o host de `dados` como URL. */
  alvo: string;
  /** O comando executado: a procedure, a URL. */
  dados?: string;
  duracaoMs: number;
  sucesso: boolean;
  codigoResultado?: string | number;
  propriedades?: Propriedades;
}

/** Teto do `descarregar()`: cada `forceFlush` do OpenTelemetry pode esperar até 30 s. */
const PRAZO_DESCARGA_MS = 5_000;

/** O SDK 3.x só aceita connection string; uma iKey pura é embrulhada. */
function paraConnectionString(chave: string): string {
  return chave.includes('=') ? chave : `InstrumentationKey=${chave}`;
}

/** O que cada chamada faz está em `docs/13-application-insights.md`. */
function iniciarCliente(chave: string): TelemetryClient {
  appInsights
    .setup(paraConnectionString(chave))
    .setInternalLogging(false)
    .setSendLiveMetrics(false)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(false)
    .setAutoCollectPerformance(true, false)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true)
    .setUseDiskRetryCaching(true)
    // Sem isto, o limite padrão de 5 spans/s tem precedência sobre o
    // `samplingPercentage` e descarta dependências em rajada.
    .setAzureMonitorOptions({ tracesPerSecond: 0 });

  // A 3.x lê o `config` uma vez, dentro do `start()`: escrita depois dele,
  // a amostragem seria ignorada em silêncio.
  const cliente = appInsights.defaultClient;
  cliente.config.samplingPercentage = 100;

  appInsights.start();
  return cliente;
}

function comoErro(erro: unknown): Error {
  return erro instanceof Error ? erro : new Error(String(erro));
}

export class AppInsights {
  private static instancia: AppInsights | undefined;

  private constructor(private readonly cliente: TelemetryClient | undefined) { }

  /** Sempre a mesma instância: o SDK só admite um `setup()` por processo. */
  static obterInstancia(): AppInsights {
    if (!AppInsights.instancia) {
      const chave = ambiente.APPINSIGHTSKEY;

      if (chave) {
        AppInsights.instancia = new AppInsights(iniciarCliente(chave));
        logger.info('Application Insights ligado');
      } else {
        AppInsights.instancia = new AppInsights(undefined);
        logger.warn('APPINSIGHTSKEY ausente - Application Insights desligado');
      }
    }

    return AppInsights.instancia;
  }

  get ligado(): boolean {
    return this.cliente !== undefined;
  }

  /** Marco de execução, na tabela `traces`. */
  trackTrace(mensagem: string, severidade: Severidade = 1): void {
    this.enviar('trace', (cliente) => {
      cliente.trackTrace({ message: mensagem, severity: NOMES_DE_SEVERIDADE[severidade] });
    });
  }

  /** Erro com stack, na tabela `exceptions`. Aceita o `unknown` do `catch` como veio. */
  trackException(erro: unknown, propriedades?: Propriedades, severidade: Severidade = 3): void {
    this.enviar('exceção', (cliente) => {
      cliente.trackException({
        exception: comoErro(erro),
        severity: NOMES_DE_SEVERIDADE[severidade],
        ...(propriedades && { properties: propriedades }),
      });
    });
  }

  /** Ocorrência de negócio com nome próprio, na tabela `customEvents`. */
  trackEvent(nome: string, propriedades?: Propriedades): void {
    this.enviar('evento', (cliente) => {
      cliente.trackEvent({ name: nome, ...(propriedades && { properties: propriedades }) });
    });
  }

  /** Valor numérico, na tabela `customMetrics` - agregado por intervalo, não um item por chamada. */
  trackMetric(nome: string, valor: number, propriedades?: Propriedades): void {
    this.enviar('métrica', (cliente) => {
      cliente.trackMetric({ name: nome, value: valor, ...(propriedades && { properties: propriedades }) });
    });
  }

  /** Chamada de saída, na tabela `dependencies` e no mapa da aplicação. */
  trackDependency(dependencia: Dependencia): void {
    this.enviar('dependência', (cliente) => {
      cliente.trackDependency({
        name: dependencia.nome,
        dependencyTypeName: dependencia.tipo,
        target: dependencia.alvo,
        duration: dependencia.duracaoMs,
        success: dependencia.sucesso,
        ...(dependencia.dados !== undefined && { data: dependencia.dados }),
        ...(dependencia.codigoResultado !== undefined && { resultCode: dependencia.codigoResultado }),
        ...(dependencia.propriedades && { properties: dependencia.propriedades }),
      });
    });
  }

  /**
   * Envia o que está no buffer. Chamado no encerramento do processo; nunca
   * passa de `PRAZO_DESCARGA_MS`, para um endpoint fora do ar não segurar o pod.
   */
  async descarregar(): Promise<void> {
    if (!this.cliente) return;

    let temporizador: NodeJS.Timeout | undefined;
    const prazo = new Promise<void>((resolver) => {
      temporizador = setTimeout(() => {
        logger.warn(`Application Insights não descarregou em ${PRAZO_DESCARGA_MS}ms - seguindo sem esperar`);
        resolver();
      }, PRAZO_DESCARGA_MS);
    });

    try {
      await Promise.race([this.cliente.flush(), prazo]);
    } catch (error_) {
      logger.warn({ err: error_ }, 'Falha ao descarregar o Application Insights');
    } finally {
      clearTimeout(temporizador);
    }
  }

  /** Nunca lança: telemetria que falha não pode derrubar o job. */
  private enviar(tipo: string, envio: (cliente: TelemetryClient) => void): void {
    if (!this.cliente) return;

    try {
      envio(this.cliente);
    } catch (error_) {
      logger.warn({ err: error_ }, `Falha ao enviar ${tipo} ao Application Insights`);
    }
  }
}

export const appInsightsInstance = AppInsights.obterInstancia();
