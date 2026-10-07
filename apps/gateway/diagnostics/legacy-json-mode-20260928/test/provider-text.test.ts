import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectStructuredOutputText } from '../src/provider-text';

const text = (value: unknown) => ({ type: 'text', text: value });
const output = (...content: unknown[]) => ({ type: 'model_output', content });

test('adjacent text chunks and model steps concatenate in order without inserted separators', () => {
  const summary = inspectStructuredOutputText({
    steps: [output(text('{"answer":')), output(text('"fictional 🍲"'), text('}'))],
    output_text: '{"answer":"fictional 🍲"}',
  });
  assert.deepEqual(summary, {
    valid: true,
    selectedTextBytes: Buffer.byteLength('{"answer":"fictional 🍲"}'),
    selectedTrimmedTextBytes: Buffer.byteLength('{"answer":"fictional 🍲"}'),
    modelOutputSteps: 2,
    modelTextParts: 3,
    allModelTextBytes: Buffer.byteLength('{"answer":"fictional 🍲"}'),
    matchesAllModelText: true,
  });
});

test('omitted whitespace-only prefix and suffix parts are permitted by the single final trim', () => {
  const summary = inspectStructuredOutputText({
    steps: [output(text(' \n\t')), output(text('{}')), output(text('\r\n '))],
    output_text: '{}',
  });
  assert.equal(summary.valid, true);
  assert.equal(summary.matchesAllModelText, true);
  assert.equal(summary.modelTextParts, 3);
  assert.equal(summary.allModelTextBytes, 8);
  assert.equal(summary.selectedTextBytes, 2);
});

test('byte counts use the joined model text when a Unicode pair spans chunks', () => {
  const summary = inspectStructuredOutputText({
    steps: [output(text('\ud83c'), text('\udf72'))],
    output_text: '🍲',
  });
  assert.equal(summary.valid, true);
  assert.equal(summary.modelTextParts, 2);
  assert.equal(summary.selectedTextBytes, 4);
  assert.equal(summary.allModelTextBytes, 4);
});

test('whitespace between non-whitespace parts is not silently removed or repaired', () => {
  const summary = inspectStructuredOutputText({
    steps: [output(text('{')), output(text(' ')), output(text('}'))],
    output_text: '{}',
  });
  assert.equal(summary.valid, false);
  assert.equal(summary.matchesAllModelText, false);
  assert.equal(summary.allModelTextBytes, 3);
});

test('thought-separated earlier model prose cannot be omitted by SDK final-run text selection', () => {
  const summary = inspectStructuredOutputText({
    steps: [
      output(text('Earlier fictional output.')),
      { type: 'thought', summary: 'Internal fictional thought.' },
      output({ type: 'thought', text: 'Fictional thought content.' }, text('{}')),
    ],
    output_text: '{}',
  });
  assert.equal(summary.valid, false);
  assert.equal(summary.matchesAllModelText, false);
  assert.equal(summary.modelOutputSteps, 2);
  assert.equal(summary.modelTextParts, 2);
  assert.equal(summary.allModelTextBytes, Buffer.byteLength('Earlier fictional output.{}'));
});

test('literal empty object padded with whitespace retains distinct selected and trimmed byte counts', () => {
  const selected = '  \n{}\t\r\n';
  const summary = inspectStructuredOutputText({
    steps: [output(text(selected))],
    output_text: selected,
  });
  assert.equal(summary.valid, true);
  assert.equal(summary.selectedTextBytes, Buffer.byteLength(selected));
  assert.equal(summary.selectedTrimmedTextBytes, 2);
  assert.equal(summary.allModelTextBytes, Buffer.byteLength(selected));
});

test('missing or malformed steps and model content fail without throwing', () => {
  const malformed = [
    {},
    { steps: null },
    { steps: {} },
    { steps: 'PRIVATE_STEPS' },
    { steps: [null] },
    { steps: [[]] },
    { steps: ['PRIVATE_STEP'] },
    { steps: [{}] },
    { steps: [{ type: 1 }] },
    { steps: [{ type: '' }] },
    { steps: [{ type: 'model_output' }] },
    { steps: [{ type: 'model_output', content: null }] },
    { steps: [{ type: 'model_output', content: {} }] },
    { steps: [{ type: 'model_output', content: 'PRIVATE_CONTENT' }] },
    { steps: [output(null)] },
    { steps: [output([])] },
    { steps: [output('PRIVATE_PART')] },
    { steps: [output({})] },
    { steps: [output({ type: 1 })] },
    { steps: [output({ type: '' })] },
    { steps: [output({ type: 'text' })] },
    { steps: [output(text(null))] },
    { steps: [output(text(1))] },
    { steps: [output(text({ text: '{}' }))] },
  ];
  for (const value of malformed) {
    const summary = inspectStructuredOutputText({ ...value, output_text: '{}' });
    assert.equal(summary.valid, false);
    assert.equal(summary.modelTextParts, 0);
    assert.equal(summary.allModelTextBytes, 0);
    assert.equal(summary.matchesAllModelText, false);
    assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
  }
});

test('malformed parts do not hide later text counts or authorize an otherwise matching selection', () => {
  const summary = inspectStructuredOutputText({
    steps: [output(text(1)), null, output(text('{}'))],
    output_text: '{}',
  });
  assert.equal(summary.valid, false);
  assert.equal(summary.modelOutputSteps, 2);
  assert.equal(summary.modelTextParts, 1);
  assert.equal(summary.allModelTextBytes, 2);
});

test('missing or non-string selected output never falls back to a model text part', () => {
  for (const selected of [undefined, null, false, 42, {}, ['{}']]) {
    const summary = inspectStructuredOutputText({
      steps: [output(text('{}'))],
      output_text: selected,
    });
    assert.equal(summary.valid, false);
    assert.equal(summary.selectedTextBytes, null);
    assert.equal(summary.selectedTrimmedTextBytes, null);
    assert.equal(summary.modelTextParts, 1);
    assert.equal(summary.allModelTextBytes, 2);
    assert.equal(summary.matchesAllModelText, false);
  }
});

test('selected mismatch and reordered chunks fail without choosing any alternative text', () => {
  for (const selected of ['{"a":2}', '}', '}{']) {
    const summary = inspectStructuredOutputText({
      steps: [output(text('{'), text('}'))],
      output_text: selected,
    });
    assert.equal(summary.valid, false);
    assert.equal(summary.matchesAllModelText, false);
    assert.equal(summary.modelTextParts, 2);
    assert.equal(summary.allModelTextBytes, 2);
  }
});

test('non-model text and non-text content are ignored without affecting ordered model comparison', () => {
  const summary = inspectStructuredOutputText({
    steps: [
      { type: 'user_input', content: [text('PRIVATE_USER_TEXT')] },
      { type: 'thought', text: 'PRIVATE_THOUGHT_TEXT' },
      output({ type: 'image', data: 'PRIVATE_IMAGE_DATA' }, text('{}')),
      { type: 'tool_result', content: [text('PRIVATE_TOOL_TEXT')] },
    ],
    output_text: '{}',
  });
  assert.equal(summary.valid, true);
  assert.equal(summary.modelOutputSteps, 1);
  assert.equal(summary.modelTextParts, 1);
  assert.equal(summary.allModelTextBytes, 2);
  assert.equal(JSON.stringify(summary).includes('PRIVATE'), false);
});

test('at least one model string text part is required even when selected text is empty', () => {
  for (const steps of [[], [output()], [output({ type: 'thought', text: 'ignored' })]]) {
    const summary = inspectStructuredOutputText({ steps, output_text: '' });
    assert.equal(summary.valid, false);
    assert.equal(summary.modelTextParts, 0);
    assert.equal(summary.matchesAllModelText, false);
  }
  const present = inspectStructuredOutputText({ steps: [output(text(''))], output_text: '' });
  assert.equal(present.valid, true);
  assert.equal(present.modelTextParts, 1);
  assert.equal(present.allModelTextBytes, 0);
});

test('metadata exposes only the fixed numeric and boolean fields, never secret prose', () => {
  const secret = 'Bearer FICTIONAL_SECRET_ONLY sk-fictional_credential';
  const summary = inspectStructuredOutputText({
    steps: [output(text(secret))],
    output_text: secret,
  });
  assert.deepEqual(Object.keys(summary).sort(), [
    'allModelTextBytes',
    'matchesAllModelText',
    'modelOutputSteps',
    'modelTextParts',
    'selectedTextBytes',
    'selectedTrimmedTextBytes',
    'valid',
  ]);
  assert.ok(
    Object.values(summary).every(
      (value) => typeof value === 'number' || typeof value === 'boolean',
    ),
  );
  assert.equal(JSON.stringify(summary).includes(secret), false);
  assert.equal(JSON.stringify(summary).includes('FICTIONAL'), false);
});
