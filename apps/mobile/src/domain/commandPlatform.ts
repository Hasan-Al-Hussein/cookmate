import * as Crypto from 'expo-crypto';
import type { CommandPlatform } from '@cookmate/domain';

/** Local adapters only. Hashing an operation grants no authority to execute it. */
export const nativeCommandPlatform: CommandPlatform = Object.freeze({
  newId: () => Crypto.randomUUID(),
  sha256: (text: string) => Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text),
});
