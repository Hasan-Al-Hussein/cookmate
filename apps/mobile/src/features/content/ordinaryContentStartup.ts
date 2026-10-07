import {
  readPrivateContentConfiguration,
  type PrivateContentConfiguration,
} from './privateContentConfig';

export type OrdinaryContentStartup =
  | { readonly kind: 'legacy' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'content'; readonly config: Readonly<PrivateContentConfiguration> };

/** Operator/build configuration only. Routes and query parameters never select a database. */
export function ordinaryContentStartup(
  input: unknown,
  platform: string,
  origin: string,
): OrdinaryContentStartup {
  if (input === undefined || input === null || input === '') return { kind: 'legacy' };
  if (platform !== 'web') return { kind: 'unavailable' };
  try {
    const config = readPrivateContentConfiguration(input, origin);
    return config ? { kind: 'content', config } : { kind: 'unavailable' };
  } catch {
    // A selected but invalid installation must never open ordinary guest/account storage.
    return { kind: 'unavailable' };
  }
}
