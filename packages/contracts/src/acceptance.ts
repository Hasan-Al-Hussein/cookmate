import { validateAssistantAcceptanceInput } from './generated/validators.js';

function invalidInput(reason: string): never {
  throw new TypeError(`Invalid assistant acceptance input: ${reason}.`);
}

function canonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidInput('nonfinite number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') invalidInput('non-JSON value');
  if (ancestors.has(value)) invalidInput('cyclic value');

  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
    invalidInput('nonplain object');

  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key !== 'string') invalidInput('symbol property');
    if (array && key === 'length') continue;
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
      invalidInput('hidden or accessor property');
  }

  ancestors.add(value);
  try {
    if (array) {
      if (keys.length !== value.length + 1) invalidInput('sparse or extended array');
      const entries: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) invalidInput('sparse or extended array');
        entries.push(canonicalJson(descriptor.value, ancestors));
      }
      return `[${entries.join(',')}]`;
    }
    return `{${Object.keys(descriptors)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(descriptors[key]!.value, ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Hash these exact UTF-8 bytes with SHA-256 in the platform adapter. This is a
 * full frozen-payload equality guard, not authorization or a current-state check.
 */
export function acceptanceFingerprintInput(value: unknown): string {
  const canonical = canonicalJson(value, new Set());
  // Validate the same inert snapshot that is hashed, without invoking caller
  // getters/toJSON or allowing validation to observe different values.
  if (!validateAssistantAcceptanceInput(JSON.parse(canonical)))
    invalidInput('contract validation failed');
  return canonical;
}
