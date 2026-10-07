import { Ajv } from 'ajv';
import type { ErrorObject } from 'ajv';
import { MODEL_RESPONSE_SCHEMA, PROVIDER_GRAMMAR_SCHEMA } from './provider-schema';

const MAX_INPUT_BYTES = 128 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 4096;
const MAX_ERRORS = 16;
const REDACTED = '[REDACTED]';
const rootFields = [
  'kind',
  'criteria',
  'recipeIds',
  'requiredFacts',
  'sufficiency',
  'missingFacts',
  'memoryUpdate',
  'response',
] as const;
const keywords = [
  'type',
  'required',
  'additionalProperties',
  'enum',
  'anyOf',
  'minLength',
  'maxLength',
  'pattern',
  'uniqueItems',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
] as const;

export type SyntheticJson =
  | null
  | boolean
  | number
  | string
  | SyntheticJson[]
  | {
      [key: string]: SyntheticJson;
    };
export type SyntheticOutputStatus =
  | 'included'
  | 'omitted_invalid'
  | 'omitted_too_large'
  | 'omitted_depth_limit'
  | 'omitted_node_limit';
export interface SyntheticModelOutputSummary {
  validationPerformed: boolean;
  projectedShapeValid: boolean;
  fullShapeValid: boolean;
  kind: 'retrieve' | 'respond' | 'unknown';
  responseKind: 'answer' | 'clarification' | 'proposal' | 'unknown';
  rootFields: (typeof rootFields)[number][];
  errors: {
    schema: 'projected' | 'full';
    keyword: (typeof keywords)[number] | 'unknown';
    instancePath: string;
    schemaPath: string;
  }[];
  errorCount: number;
  errorsTruncated: boolean;
  generatedJson: SyntheticJson;
  generatedJsonStatus: SyntheticOutputStatus;
  generatedJsonBytes: number | null;
  redactionCount: number;
}

// Compile only these application-owned static schemas, never a model-supplied schema.
const ajv = new Ajv({ strict: false, allErrors: true, messages: false, ownProperties: true });
const projectedShape = ajv.compile(PROVIDER_GRAMMAR_SCHEMA);
const fullShape = ajv.compile(MODEL_RESPONSE_SCHEMA);
const schemaNames = new Set<string>(['properties', 'items', ...keywords]);
function collectSchemaNames(value: unknown): void {
  if (Array.isArray(value)) value.forEach(collectSchemaNames);
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'properties' && child && typeof child === 'object')
        Object.keys(child).forEach((name) => schemaNames.add(name));
      collectSchemaNames(child);
    }
  }
}
collectSchemaNames(MODEL_RESPONSE_SCHEMA);

class InvalidInput extends Error {
  constructor(readonly status: Exclude<SyntheticOutputStatus, 'included'>) {
    super('Synthetic diagnostic input omitted');
  }
}

/** Copy plain JSON without calling toJSON, getters or serializers on untrusted objects. */
function boundedJson(input: unknown): SyntheticJson {
  let nodes = 0;
  let bytes = 0;
  const seen = new WeakSet<object>();
  function addBytes(count: number): void {
    bytes += count;
    if (bytes > MAX_INPUT_BYTES) throw new InvalidInput('omitted_too_large');
  }
  function stringBytes(value: string): number {
    if (value.length > MAX_INPUT_BYTES) throw new InvalidInput('omitted_too_large');
    return Buffer.byteLength(JSON.stringify(value));
  }
  function visit(value: unknown, depth: number): SyntheticJson {
    if (depth > MAX_DEPTH) throw new InvalidInput('omitted_depth_limit');
    if (++nodes > MAX_NODES) throw new InvalidInput('omitted_node_limit');
    if (value === null || typeof value === 'boolean') {
      addBytes(value === null || value === true ? 4 : 5);
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      addBytes(String(value).length);
      return value;
    }
    if (typeof value === 'string') {
      addBytes(stringBytes(value));
      return value;
    }
    if (!value || typeof value !== 'object' || seen.has(value))
      throw new InvalidInput('omitted_invalid');
    seen.add(value);
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null)
      throw new InvalidInput('omitted_invalid');
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_NODES + (array ? 1 : 0)) throw new InvalidInput('omitted_node_limit');
    if (keys.some((key) => typeof key !== 'string')) throw new InvalidInput('omitted_invalid');
    const names = keys.filter((key): key is string => typeof key === 'string');
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES)
        throw new InvalidInput('omitted_node_limit');
      if (
        names.length !== length + 1 ||
        names.some((key) => key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key))
      )
        throw new InvalidInput('omitted_invalid');
      addBytes(2 + Math.max(0, length - 1));
      const result: SyntheticJson[] = [];
      for (let index = 0; index < length; index++) {
        const property = Object.getOwnPropertyDescriptor(value, String(index));
        if (!property || !('value' in property) || !property.enumerable)
          throw new InvalidInput('omitted_invalid');
        result.push(visit(property.value, depth + 1));
      }
      return result;
    }
    addBytes(2 + Math.max(0, names.length - 1));
    const entries: [string, SyntheticJson][] = [];
    for (const key of names) {
      addBytes(stringBytes(key) + 1);
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !('value' in property) || !property.enumerable)
        throw new InvalidInput('omitted_invalid');
      entries.push([key, visit(property.value, depth + 1)]);
    }
    // Defining own data properties also preserves hostile __proto__ keys safely.
    return Object.fromEntries(entries);
  }
  return visit(input, 0);
}

function path(value: string): string {
  const parts = value.split('/');
  return parts
    .slice(0, 32)
    .map((part, index) => {
      if (index === 0 && (part === '' || part === '#')) return part;
      const decoded = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (schemaNames.has(decoded)) return decoded;
      return /^[0-9]+$/.test(decoded) ? '*' : '[unknown]';
    })
    .join('/');
}

function errors(
  projected: ErrorObject[] | null | undefined,
  full: ErrorObject[] | null | undefined,
): SyntheticModelOutputSummary['errors'] {
  const result: SyntheticModelOutputSummary['errors'] = [];
  const lists = [
    { schema: 'projected' as const, errors: projected ?? [] },
    { schema: 'full' as const, errors: full ?? [] },
  ];
  // Interleave schemas so one noisy branch cannot hide the other validator entirely.
  for (let index = 0; index < MAX_ERRORS && result.length < MAX_ERRORS; index++) {
    for (const list of lists) {
      const error = list.errors[index];
      if (error && result.length < MAX_ERRORS)
        result.push({
          schema: list.schema,
          keyword: keywords.find((keyword) => keyword === error.keyword) ?? 'unknown',
          instancePath: path(error.instancePath),
          schemaPath: path(error.schemaPath),
        });
    }
  }
  return result;
}

function redact(value: SyntheticJson, apiKey: string) {
  let count = 0;
  function text(input: string): string {
    let result = input;
    if (apiKey) {
      const parts = result.split(apiKey);
      count += parts.length - 1;
      result = parts.join(REDACTED);
    }
    for (const pattern of [
      /AIza[A-Za-z0-9_-]{35}/g,
      /\bsk-[A-Za-z0-9_-]+/g,
      /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    ])
      result = result.replace(pattern, () => {
        count++;
        return REDACTED;
      });
    return result;
  }
  function visit(item: SyntheticJson): SyntheticJson {
    if (typeof item === 'string') return text(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, child]) => {
          const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
          const sensitive =
            /authorization|authentication|apikey|token|password|passwd|secret|credential|privatekey|passphrase|cookie|connectionstring/.test(
              normalized,
            ) || ['auth', 'pwd', 'key'].includes(normalized);
          if (sensitive) count++;
          return [text(key), sensitive ? REDACTED : visit(child)];
        }),
      );
    return item;
  }
  const generatedJson = visit(value);
  return { generatedJson, redactionCount: count };
}

/** Diagnostic exception for a fixed fictional fixture only. Never pass HTTP bodies,
 * headers, SDK errors, real conversation content or unparsed provider text here. */
export function summarizeSyntheticModelOutput(
  value: unknown,
  apiKey: string,
): SyntheticModelOutputSummary {
  const summary: SyntheticModelOutputSummary = {
    validationPerformed: false,
    projectedShapeValid: false,
    fullShapeValid: false,
    kind: 'unknown',
    responseKind: 'unknown',
    rootFields: [],
    errors: [],
    errorCount: 0,
    errorsTruncated: false,
    generatedJson: null,
    generatedJsonStatus: 'omitted_invalid',
    generatedJsonBytes: null,
    redactionCount: 0,
  };
  try {
    const json = boundedJson(value);
    summary.projectedShapeValid = projectedShape(json);
    summary.fullShapeValid = fullShape(json);
    summary.validationPerformed = true;
    summary.errors = errors(projectedShape.errors, fullShape.errors);
    summary.errorCount = (projectedShape.errors?.length ?? 0) + (fullShape.errors?.length ?? 0);
    summary.errorsTruncated = summary.errorCount > summary.errors.length;
    if (json && typeof json === 'object' && !Array.isArray(json)) {
      summary.kind = json.kind === 'retrieve' || json.kind === 'respond' ? json.kind : 'unknown';
      summary.rootFields = rootFields.filter((name) => Object.hasOwn(json, name));
      const response = json.response;
      if (response && typeof response === 'object' && !Array.isArray(response))
        summary.responseKind =
          response.kind === 'answer' ||
          response.kind === 'clarification' ||
          response.kind === 'proposal'
            ? response.kind
            : 'unknown';
    }
    const redacted = redact(json, apiKey);
    const bytes = Buffer.byteLength(JSON.stringify(redacted.generatedJson));
    summary.redactionCount = redacted.redactionCount;
    summary.generatedJsonBytes = bytes;
    summary.generatedJsonStatus = bytes <= MAX_OUTPUT_BYTES ? 'included' : 'omitted_too_large';
    if (bytes <= MAX_OUTPUT_BYTES) summary.generatedJson = redacted.generatedJson;
  } catch (error) {
    summary.generatedJsonStatus = error instanceof InvalidInput ? error.status : 'omitted_invalid';
  }
  return summary;
}
