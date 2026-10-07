import { StorageFault } from './sql';

/** JSON escaping preserves embedded NUL and lone UTF-16 surrogates across SQLite bindings. */
export function encodeStoredText(value: string): string {
  return JSON.stringify(value);
}

export function decodeStoredText(json: unknown): string {
  if (typeof json !== 'string') throw new StorageFault('storage_failure', 'Invalid stored text');
  const value: unknown = JSON.parse(json);
  if (typeof value !== 'string') throw new StorageFault('storage_failure', 'Invalid stored text');
  return value;
}
