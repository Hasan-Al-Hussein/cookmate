import { schema } from '@cookmate/contracts/schema';
import { compileProviderGrammar } from './provider-grammar';

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

// Preserve the full model-output shape separately from Gemini's grammar guidance.
// Shared validators and orchestration remain authoritative for values and semantics.
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

// Google's structured-output subset does not list these four constraints. Keep
// them in the full model shape and local validation, but omit them at the grammar
// boundary. Preserve properties, required fields, unions, enums and array caps.
const localOnlyKeywords = new Set(['minLength', 'maxLength', 'pattern', 'uniqueItems']);
function providerProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(providerProjection);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !localOnlyKeywords.has(key))
      .map(([key, item]) => [
        key,
        // Property names are data, even if a future property shares a keyword name.
        key === 'properties'
          ? Object.fromEntries(
              Object.entries(item).map(([name, child]) => [name, providerProjection(child)]),
            )
          : providerProjection(item),
      ]),
  );
}

const projectedStepUnion = providerProjection(MODEL_RESPONSE_SCHEMA) as Record<string, unknown>;
export const PROVIDER_RESPONSE_SCHEMA = {
  // Every root alternative is already an object. State this explicitly for the
  // provider grammar without changing the accepted value set or local validators.
  type: 'object',
  ...projectedStepUnion,
};

// Provider grammar is a structural superset. Every returned step is validated
// unchanged against MODEL_RESPONSE_SCHEMA before any branch can be dispatched.
export const PROVIDER_GRAMMAR_SCHEMA = compileProviderGrammar(PROVIDER_RESPONSE_SCHEMA);
export const PROVIDER_ENVELOPE_SCHEMA = object({ step: PROVIDER_GRAMMAR_SCHEMA });

export function isProviderEnvelope(value: unknown): value is { step: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'step') return false;
  const step = (value as { step: unknown }).step;
  return step !== null && typeof step === 'object' && !Array.isArray(step);
}
