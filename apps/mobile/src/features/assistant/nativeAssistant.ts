import type { CookMateServices } from '@cookmate/domain';
import { createAssistantCoordinator } from '../../assistant-core';
import { createNativeGatewayConnection } from '../../connection/native';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import { runtimeClock } from '../workspace/runtimeClock';
import { AssistantRuntime } from './assistantRuntime';
import { AiConsentController } from './aiConsent';
import { aiConsentStoreForWorkspace } from './aiConsentStorage';

export function createNativeAssistant(services: CookMateServices, workspaceKey = 'guest') {
  const consent = new AiConsentController(aiConsentStoreForWorkspace(workspaceKey));
  const connection = createNativeGatewayConnection(
    {
      authorizeAssistantRequest: () => consent.assertAllowed(),
    },
    workspaceKey,
  );
  const connectionGeneration = () => connection.getState().generation;
  const persistence = services.assistant({ connectionGeneration });
  const core = createAssistantCoordinator({
    persistence,
    services,
    connection,
    platform: nativeCommandPlatform,
    currentDate: runtimeClock.dateContext,
  });
  return new AssistantRuntime(persistence, core, connection, services, consent);
}
