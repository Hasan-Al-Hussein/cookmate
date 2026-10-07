export interface StructuredOutputTextInspection {
  valid: boolean;
  selectedTextBytes: number | null;
  selectedTrimmedTextBytes: number | null;
  modelOutputSteps: number;
  modelTextParts: number;
  allModelTextBytes: number;
  matchesAllModelText: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Inspect the already body-bounded SDK result without retaining or choosing output text. */
export function inspectStructuredOutputText(result: {
  steps?: unknown;
  output_text?: unknown;
}): StructuredOutputTextInspection {
  const selected =
    record(result) && typeof result.output_text === 'string' ? result.output_text : null;
  const selectedTrimmed = selected?.trim() ?? null;
  const steps = record(result) && Array.isArray(result.steps) ? result.steps : null;
  let wellFormed = steps !== null;
  let modelOutputSteps = 0;
  const parts: string[] = [];
  for (const step of steps ?? []) {
    if (!record(step) || typeof step.type !== 'string' || !step.type) {
      wellFormed = false;
      continue;
    }
    if (step.type !== 'model_output') continue;
    modelOutputSteps++;
    if (!Array.isArray(step.content)) {
      wellFormed = false;
      continue;
    }
    for (const content of step.content) {
      if (!record(content) || typeof content.type !== 'string' || !content.type) {
        wellFormed = false;
        continue;
      }
      if (content.type !== 'text') continue;
      if (typeof content.text !== 'string') {
        wellFormed = false;
        continue;
      }
      parts.push(content.text);
    }
  }
  const allModelText = parts.join('');
  const matchesAllModelText =
    selectedTrimmed !== null && parts.length > 0 && allModelText.trim() === selectedTrimmed;
  return {
    valid: wellFormed && matchesAllModelText,
    selectedTextBytes: selected === null ? null : Buffer.byteLength(selected),
    selectedTrimmedTextBytes: selectedTrimmed === null ? null : Buffer.byteLength(selectedTrimmed),
    modelOutputSteps,
    modelTextParts: parts.length,
    allModelTextBytes: Buffer.byteLength(allModelText),
    matchesAllModelText,
  };
}
