import appInsights from 'applicationinsights';
import type { TelemetryClient } from 'applicationinsights';
import { ambiente } from './env.js';
import { logger } from '../logger/logger.js';

/**
 * Dono exclusivo do Application Insights. Nenhum outro arquivo chama
 * `appInsights.setup()`: os jobs importam `appInsightsInstance` e registram
 * `trackTrace` antes e depois de cada procedure.
 * Ver `docs/13-application-insights.md`.
 */

/** Escala numérica do SDK clássico (v2); o v3 espera o nome. */
const SEVERIDADES = ['Verbose', 'Information', 'Warning', 'Error', 'Critical'] as const;

/** 0 Verbose · 1 Information · 2 Warning · 3 Error · 4 Critical. */
export type Severidade = 0 | 1 | 2 | 3 | 4;

/** O SDK v3 só aceita connection string; uma iKey pura é embrulhada. */
function paraConnectionString(chave: string): string {
  return chave.includes('=') ? chave : `InstrumentationKey=${chave}`;
}

/** O que cada chamada faz está em `docs/13-application-insights.md`. */
function iniciarCliente(chave: string): TelemetryClient {
  appInsights
    .setup(paraConnectionString(chave))
    .setDistributedTracingMode(appInsights.DistributedTracingModes.AI)
    .setInternalLogging(false)
    .setSendLiveMetrics(false)
    .setAutoDependencyCorrelation(true)
    .setAutoCollectRequests(false)
    .setAutoCollectPerformance(true, true)
    .setAutoCollectExceptions(true)
    .setAutoCollectDependencies(true)
    .setAutoCollectConsole(true)
    .setUseDiskRetryCaching(true);

  // No SDK v3 a configuração é lida dentro do `start()`: definidas depois
  // dele, estas três seriam ignoradas em silêncio.
  const cliente = appInsights.defaultClient;
  cliente.config.maxBatchSize = 500;
  cliente.config.maxBatchIntervalMs = 15_000;
  cliente.config.samplingPercentage = 100;

  appInsights.start();
  return cliente;
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
        logger.warn('APPINSIGHTSKEY ausente — Application Insights desligado');
      }
    }

    return AppInsights.instancia;
  }

  get ligado(): boolean {
    return this.cliente !== undefined;
  }

  /** Nunca lança: telemetria que falha não pode derrubar o job. */
  trackTrace(mensagem: string, severidade: Severidade = 1): void {
    if (!this.cliente) return;

    try {
      this.cliente.trackTrace({ message: mensagem, severity: SEVERIDADES[severidade] });
    } catch (erro) {
      logger.warn({ err: erro }, 'Falha ao enviar trace ao Application Insights');
    }
  }

  /** Envia o que está no buffer. Chamado no encerramento do processo. */
  async descarregar(): Promise<void> {
    if (!this.cliente) return;

    try {
      await this.cliente.flush();
    } catch (erro) {
      logger.warn({ err: erro }, 'Falha ao descarregar o Application Insights');
    }
  }
}

export const appInsightsInstance = AppInsights.obterInstancia();
