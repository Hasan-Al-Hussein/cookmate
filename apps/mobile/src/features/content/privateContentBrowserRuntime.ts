import { Platform } from 'react-native';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { openNativeConnection } from '../../data/nativeConnection';
import { nativeCommandPlatform } from '../../domain/commandPlatform';
import { runtimeClock } from '../workspace/runtimeClock';
import { createContentVerificationPorts } from './contentVerification';
import { localContentUpdateJournal } from './localContentUpdateJournal';
import {
  ownPrivateContentConfiguration,
  type PrivateContentConfiguration,
} from './privateContentConfig';
import { openPrivateContentRuntime } from './privateContentRuntime';
import {
  createPrivateContentController,
  type PrivateContentController,
} from './privateContentController';
import { preparePrivateContentWorkspace } from './preparePrivateContentWorkspace';
import { createPrivateContentBrowserConnection } from './privateContentBrowserConnection';

const openers = new Map<string, { policy: string; controller: PrivateContentController }>();
/** The root's origin-wide BrowserStorageGate must already own this document's SQLite pool. */
export function privateContentBrowserWorkspace(input: Readonly<PrivateContentConfiguration>) {
  const config = ownPrivateContentConfiguration(input);
  if (Platform.OS !== 'web' || globalThis.location?.origin !== config.origin)
    throw new Error('Private recipe review currently requires its configured web origin.');
  const key = config.installationId;
  const policy = canonicalContentJson(config);
  let retained = openers.get(key);
  if (retained && retained.policy !== policy)
    throw new Error('Private review configuration changed. Close this document before reopening.');
  if (!retained) {
    const fetch = globalThis.fetch.bind(globalThis);
    const openConnection = createPrivateContentBrowserConnection(
      config.installationId,
      openNativeConnection,
    );
    const controller = createPrivateContentController({
      prepare: () =>
        preparePrivateContentWorkspace({
          config,
          openConnection,
          platform: nativeCommandPlatform,
        }),
      open: () =>
        openPrivateContentRuntime({
          config,
          openConnection,
          verification: () => createContentVerificationPorts({ trustKeys: config.trustKeys }),
          journal: localContentUpdateJournal(config.installationId, null),
          platform: nativeCommandPlatform,
          ...runtimeClock,
          fetch,
        }),
    });
    retained = { policy, controller };
    openers.set(key, retained);
  }
  return retained.controller;
}
