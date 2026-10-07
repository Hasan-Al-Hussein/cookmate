import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewRecord } from './ReviewRecord';

test('requested changes show the actual note and reviewed revision as escaped text', () => {
  const html = renderToStaticMarkup(
    createElement(ReviewRecord, {
      review: {
        decision: 'changes_requested',
        note: 'Keep 2 tbsp exactly.\nDo not use <script> or invent timings.',
        reviewerId: 'actual-reviewer',
        reviewedAt: '2026-09-30T12:00:00Z',
        inputRevision: 4,
      },
    }),
  );
  assert.match(html, /Changes requested/);
  assert.match(html, /Keep 2 tbsp exactly/);
  assert.match(html, /Stored review of revision 4/);
  assert.match(html, /actual-reviewer/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('legacy absent review records do not invent feedback', () => {
  assert.equal(renderToStaticMarkup(createElement(ReviewRecord, { review: undefined })), '');
  assert.equal(renderToStaticMarkup(createElement(ReviewRecord, { review: null })), '');
});
