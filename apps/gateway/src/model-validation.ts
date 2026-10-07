import { Ajv } from 'ajv';
import { MODEL_RESPONSE_SCHEMA } from './provider-schema';

// Compile only our static exact contract. Validation must never coerce, default,
// remove wrong-branch fields or expose generated content through error prose.
const validate = new Ajv({
  strict: true,
  allErrors: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  ownProperties: true,
  messages: false,
}).compile(MODEL_RESPONSE_SCHEMA);

export function isModelStep(value: unknown): boolean {
  return validate(value);
}
