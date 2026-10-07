import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AdminDraft, AdminPublicationTranslationSelection } from '../src/contracts';
import type { AdminTranslation, AdminTranslationInput } from '../src/translations/contracts';
import type { Client } from './helpers';

/** Synthetic text and operator assertions for a disposable local bridge, never language/rights acceptance. */
export async function prepareReviewedTranslationFixture(client: Client, draft: AdminDraft) {
  const input: AdminTranslationInput = {
    title: 'مثال اختبار للترجمة — غير مخصص للطهي',
    description: 'نص تجريبي لاختبار العرض فقط. لم يراجعه مترجم مستقل.',
    category: 'مثال اختبار',
    cuisine: 'مثال اختبار',
    rawTags: null,
    ingredients: draft.input.ingredients.map((_, index) => ({
      rawName: `مكوّن تجريبي ${index + 1}`,
    })),
    instructions: draft.input.instructions.map((_, index) => ({
      rawText: `فقرة اختبار ${index + 1} — ارجع إلى النص الأصلي للطهي.`,
    })),
    changeSummary:
      'Synthetic signed translation fixture; not real language review or rights clearance.',
    attribution: 'machine',
  };
  const created = await client.request('POST', `/admin/api/drafts/${draft.draftId}/translations`, {
    operationId: randomUUID(),
    sourceRevision: draft.revision,
    originalLanguage: 'en',
    targetLanguage: 'ar',
    input,
  });
  assert.equal(created.statusCode, 200, created.body);
  const record = created.json().translation as AdminTranslation;
  const reviewed = await client.request(
    'POST',
    `/admin/api/translations/${record.translationId}/reviews`,
    {
      operationId: randomUUID(),
      expectedRevision: record.revision,
      decision: 'approved',
      note: 'Synthetic local operator acknowledgement; no human translation quality claim.',
      acknowledgeHumanReview: true,
    },
  );
  assert.equal(reviewed.statusCode, 200, reviewed.body);
  const translation = reviewed.json().translation as AdminTranslation;
  const selection: AdminPublicationTranslationSelection = {
    translationId: translation.translationId,
    translationRevision: translation.revision,
    rights: {
      statement: 'Synthetic translation test assertion only; not real publication permission.',
      sourceUrl: null,
      acknowledge: true,
    },
  };
  return { translation, selection };
}
