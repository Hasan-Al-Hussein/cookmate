import path from 'node:path';
import { GEMINI_MODELS } from './gemini';
import type { GeminiModel } from './gemini';
import { gatewayError } from './errors';
import { readProviderRequestLimit } from './provider-physical-admission';

export interface GatewayConfiguration {
  apiKey: string;
  model: GeminiModel;
  host: string;
  port: number;
  certificatePath: string;
  privateKeyPath: string;
  registryDirectory: string;
  providerRequestsPerMinute: number;
}

/** No defaults silently select a model or weaken transport trust. Never log this object. */
export function readGatewayConfiguration(environment: NodeJS.ProcessEnv): GatewayConfiguration {
  const {
    GEMINI_API_KEY: apiKey,
    COOKMATE_MODEL: model,
    COOKMATE_TLS_CERT: certificatePath,
    COOKMATE_TLS_KEY: privateKeyPath,
    LOCALAPPDATA: localAppData,
  } = environment;
  const host = environment.COOKMATE_BIND_HOST ?? '127.0.0.1';
  const portText = environment.COOKMATE_PORT ?? '3443';
  if (
    !apiKey ||
    !GEMINI_MODELS.includes(model as GeminiModel) ||
    !certificatePath ||
    !privateKeyPath ||
    !localAppData ||
    ![certificatePath, privateKeyPath, localAppData].every(path.isAbsolute) ||
    !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) ||
    host.split('.').some((octet) => Number(octet) > 255) ||
    !/^\d{2,5}$/.test(portText) ||
    Number(portText) < 1024 ||
    Number(portText) > 65535
  )
    throw gatewayError('provider_unavailable', 503, 'after_correction');
  return {
    apiKey,
    model: model as GeminiModel,
    host,
    port: Number(portText),
    certificatePath,
    privateKeyPath,
    registryDirectory: path.join(localAppData, 'CookMate', 'registry'),
    providerRequestsPerMinute: readProviderRequestLimit(
      environment.COOKMATE_PROVIDER_REQUESTS_PER_MINUTE,
    ),
  };
}
