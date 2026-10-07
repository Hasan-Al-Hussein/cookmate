import { readFile } from 'node:fs/promises';
import { catalogue } from '@cookmate/catalogue';
import { createFileRegistryStorage, createCredentialRegistry } from './registry';
import { createGateway } from './server';
import { createGeminiProvider } from './gemini';
import { createOrchestrator } from './orchestrator';
import type { GatewayConfiguration } from './configuration';
import { getProcessProviderAdmission } from './provider-physical-admission';
import { createVerifiedContentGateway, type VerifiedGatewayContent } from './contentGateway';

/** Explicitly invoked operator entry point; construction/tests never call this function. */
export async function launchGateway(
  configuration: GatewayConfiguration,
  content?: VerifiedGatewayContent,
) {
  const physicalAdmission = getProcessProviderAdmission(configuration.providerRequestsPerMinute);
  const [cert, key] = await Promise.all([
    readFile(configuration.certificatePath),
    readFile(configuration.privateKeyPath),
  ]);
  const storage = await createFileRegistryStorage(configuration.registryDirectory);
  try {
    const registry = await createCredentialRegistry(storage);
    const provider = createGeminiProvider({
      apiKey: configuration.apiKey,
      model: configuration.model,
      physicalAdmission,
    });
    const transport = { registry, tls: { cert, key, minVersion: 'TLSv1.2' as const } };
    const gateway = content
      ? await createVerifiedContentGateway({ ...transport, provider, content })
      : createGateway({
          ...transport,
          catalogue: catalogue.boundary,
          turn: createOrchestrator(provider),
        });
    try {
      await gateway.app.listen({ host: configuration.host, port: configuration.port });
    } catch (error) {
      await gateway.app.close();
      throw error;
    }
    let closed = false;
    return {
      pairing: gateway.pairing,
      listClients: registry.listClients,
      revoke: gateway.revoke,
      async close() {
        if (closed) return;
        closed = true;
        gateway.pairing.closeWindow();
        gateway.admission.close();
        try {
          await gateway.app.close();
        } finally {
          await storage.close();
        }
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
}
