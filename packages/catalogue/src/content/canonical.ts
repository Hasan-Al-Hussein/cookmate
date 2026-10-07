import type { Immutable } from '../catalogue';

export class ContentValidationError extends Error {
  constructor(readonly code: string) {
    super(`Invalid content: ${code}`);
    this.name = 'ContentValidationError';
  }
}
export function requireContent(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ContentValidationError(code);
}

const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_JSON_NODES = 500_000;

/** Object keys sort by UTF-16 code units; arrays and all source strings retain exact order/text. */
export function canonicalContentJson(value: unknown, maxBytes = MAX_JSON_BYTES): string {
  requireContent(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_JSON_BYTES, 'json_budget');
  const ancestors = new Set<object>();
  const chunks: string[] = [];
  let nodes = 0;
  let bytes = 0;
  function appendAscii(value: string): void {
    requireContent(bytes + value.length <= maxBytes, 'json_size');
    bytes += value.length;
    chunks.push(value);
  }
  function quotedBytes(value: string, available: number): number {
    // UTF-16 length is a lower bound for encoded JSON bytes. Reject huge strings before scanning.
    requireContent(value.length + 2 <= available, 'json_size');
    let count = 2;
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) count += 2;
      else if (code < 32) count += 6;
      else if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { count += 4; index++; }
        else count += 6;
      } else if (code >= 0xdc00 && code <= 0xdfff) count += 6;
      else count += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3;
      requireContent(count <= available, 'json_size');
    }
    return count;
  }
  function appendString(value: string): void {
    const count = quotedBytes(value, maxBytes - bytes);
    // This is the first string copy, after its exact escaped UTF-8 size passed the budget.
    chunks.push(JSON.stringify(value));
    bytes += count;
  }
  function encode(item: unknown, depth: number): void {
    requireContent(++nodes <= MAX_JSON_NODES && depth <= 32, 'json_bound');
    if (typeof item === 'string') { appendString(item); return; }
    if (item === null || typeof item === 'boolean') { appendAscii(String(item)); return; }
    if (typeof item === 'number') {
      requireContent(Number.isFinite(item) && !Object.is(item, -0), 'json_number');
      appendAscii(JSON.stringify(item));
      return;
    }
    requireContent(typeof item === 'object' && item !== null, 'json_value');
    requireContent(!ancestors.has(item), 'json_cycle');
    requireContent(
      Array.isArray(item) || Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null,
      'json_object',
    );
    ancestors.add(item);
    if (Array.isArray(item)) {
      // Check length before key enumeration, traversal or allocating a second array.
      requireContent(item.length <= MAX_JSON_NODES - nodes, 'json_bound');
      requireContent(item.length === 0 || item.length * 2 + 1 <= maxBytes - bytes, 'json_size');
      requireContent(Object.getOwnPropertySymbols(item).length === 0, 'json_symbol');
      requireContent(Object.keys(item).length === item.length && Object.getOwnPropertyNames(item).length === item.length + 1, 'json_array');
      appendAscii('[');
      for (let index = 0; index < item.length; index++) {
        if (index > 0) appendAscii(',');
        const entry = Object.getOwnPropertyDescriptor(item, String(index));
        requireContent(entry && 'value' in entry, 'json_accessor');
        encode(entry.value, depth + 1);
      }
      appendAscii(']');
    } else {
      const keys: string[] = [];
      let minimumBytes = 2;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        requireContent(keys.length < MAX_JSON_NODES - nodes, 'json_bound');
        // Count each key, colon, minimal value and comma before retaining/sorting the key set.
        minimumBytes += quotedBytes(key, maxBytes - bytes - minimumBytes) + 2 + (keys.length ? 1 : 0);
        requireContent(minimumBytes <= maxBytes - bytes, 'json_size');
        keys.push(key);
      }
      requireContent(Object.getOwnPropertySymbols(item).length === 0, 'json_symbol');
      requireContent(Object.getOwnPropertyNames(item).length === keys.length, 'json_property');
      keys.sort();
      appendAscii('{');
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index]!;
        const entry = Object.getOwnPropertyDescriptor(item, key)!;
        requireContent(entry.enumerable && 'value' in entry, 'json_accessor');
        if (index > 0) appendAscii(',');
        appendString(key);
        appendAscii(':');
        encode(entry.value, depth + 1);
      }
      appendAscii('}');
    }
    ancestors.delete(item);
  }
  encode(value, 0);
  return chunks.join('');
}

export function jsonUtf8Bytes(text: string): number {
  let bytes = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
export function freezeContent<Value>(value: Value): Immutable<Value> {
  function freeze(item: unknown): void {
    if (item === null || typeof item !== 'object') return;
    Object.values(item).forEach(freeze);
    Object.freeze(item);
  }
  freeze(value);
  return value as Immutable<Value>;
}

/** Makes a private plain-data copy before any asynchronous hash or trust check. */
export function copyContent(value: unknown, maxBytes: number): unknown {
  const encoded = canonicalContentJson(value, maxBytes);
  return JSON.parse(encoded) as unknown;
}
