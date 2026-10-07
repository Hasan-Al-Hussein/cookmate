import { schema } from '@cookmate/contracts/schema';

// Only application-owned schema definitions are expanded; model-provided schemas are never compiled.
function inline(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inline);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (typeof record.$ref === 'string') {
    const name = record.$ref.split('/').at(-1) as keyof typeof schema.definitions;
    return inline(schema.definitions[name]);
  }
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => key !== 'title')
      .map(([key, item]) =>
        key === 'const' ? ['enum', [item]] : [key === 'oneOf' ? 'anyOf' : key, inline(item)],
      ),
  );
}
const string = (maxLength: number) => ({ type: 'string', maxLength });
const array = (items: unknown, maxItems: number) => ({ type: 'array', items, maxItems });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const source = inline(schema.definitions.SourceReference);
const common = {
  text: string(8000),
  sources: array(source, 100),
  recipeIds: array({ type: 'string', pattern: '^[0-9]+$' }, 6),
};

// The complete output contract is supplied as trusted instructions and validated
// locally. Request-aware validators remain authoritative for values and semantics.
export const MODEL_RESPONSE_SCHEMA = {
  anyOf: [
    object({
      kind: { type: 'string', enum: ['retrieve'] },
      criteria: object(
        {
          query: string(4000),
          category: string(512),
          cuisine: string(512),
          ingredients: array(string(512), 20),
        },
        [],
      ),
      recipeIds: array({ type: 'string', pattern: '^[0-9]+$' }, 6),
      requiredFacts: array(string(300), 8),
    }),
    object({
      kind: { type: 'string', enum: ['respond'] },
      sufficiency: {
        type: 'string',
        enum: ['sufficient', 'insufficient', 'unanswerable', 'irrelevant'],
      },
      missingFacts: array(string(300), 8),
      memoryUpdate: inline(schema.definitions.ModelMemoryUpdate),
      response: {
        anyOf: [
          object({ kind: { type: 'string', enum: ['answer'] }, ...common }),
          object({
            kind: { type: 'string', enum: ['clarification'] },
            ...common,
            missing: array(
              {
                type: 'string',
                enum: ['recipe', 'date', 'meal', 'preference', 'reference', 'intent'],
              },
              6,
            ),
          }),
          object({
            kind: { type: 'string', enum: ['proposal'] },
            ...common,
            proposals: array(inline(schema.definitions.AiProposal), 8),
          }),
        ],
      },
    }),
  ],
};

export const MODEL_ENVELOPE_SCHEMA = object({ step: MODEL_RESPONSE_SCHEMA });
export const MODEL_ENVELOPE_SCHEMA_TEXT = JSON.stringify(MODEL_ENVELOPE_SCHEMA);

export function isProviderEnvelope(value: unknown): value is { step: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'step') return false;
  const step = (value as { step: unknown }).step;
  return step !== null && typeof step === 'object' && !Array.isArray(step);
}
