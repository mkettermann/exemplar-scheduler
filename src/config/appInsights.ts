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

/** 0 Verbose · 1 Information · 2 Warning · 3 Error · 4 Critical — o `SeverityLevel` do SDK. */
export type Severidade = 0 | 1 | 2 | 3 | 4;

/**
 * O que cada chamada faz está em `docs/13-application-insights.md`.
 * O SDK 1.8.2 aceita tanto a connection string quanto a iKey pura.
 */
function iniciarCliente(chave: string): TelemetryClient {
  appInsights
    .setup(chave)
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

  // O canal lê estas três a cada envio. Ficam antes do `start()` para a
  // configuração inteira estar num lugar só.
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
      this.cliente.trackTrace({ message: mensagem, severity: severidade });
    } catch (error_) {
      logger.warn({ err: error_ }, 'Falha ao enviar trace ao Application Insights');
    }
  }

  /** Envia o que está no buffer. Chamado no encerramento do processo. */
  async descarregar(): Promise<void> {
    if (!this.cliente) return;

    const cliente = this.cliente;

    try {
      // O `flush` do 1.8.2 não devolve Promise. O callback é chamado tanto com
      // a resposta da ingestão quanto com a mensagem de erro de rede.
      await new Promise<void>((resolver) => {
        cliente.flush({ callback: () => resolver() });
      });
    } catch (error_) {
      logger.warn({ err: error_ }, 'Falha ao descarregar o Application Insights');
    }
  }
}

export const appInsightsInstance = AppInsights.obterInstancia();
