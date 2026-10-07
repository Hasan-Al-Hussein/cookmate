import { canonicalContentJson, type ReviewedMetadata } from '@cookmate/catalogue/content';
import type { AdminDraft, AdminMetadataField, AdminRightsScope } from '../src/contracts';
import { metadataLabels, nutritionLabels } from './metadataForm';

export interface ComparisonLine {
  label: string;
  value: string | null;
}
export interface RevisionComparisonGroup {
  key: string;
  label: string;
  changed: boolean;
  before: ComparisonLine[];
  after: ComparisonLine[];
}
const line = (label: string, value: string | number | null): ComparisonLine => ({
  label,
  value: value === null ? null : String(value),
});
const recipeFields = {
  title: 'Title',
  description: 'Description',
  category: 'Category',
  cuisine: 'Cuisine',
  rawTags: 'Original tags',
  recipePage: 'Recipe collection link',
  originalSourceUrl: 'Original publisher link',
  videoUrl: 'Video link',
  photoAssetId: 'Selected photo asset',
  changeSummary: 'Change summary',
} as const;
const rightsScopes: Record<AdminRightsScope, string> = {
  recipe_text: 'Recipe text permission',
  photo: 'Photo permission',
  video_embed: 'Video embedding permission',
};
function metadataLines(field: ReviewedMetadata[AdminMetadataField]): ComparisonLine[] {
  const value = field.value;
  const values =
    value === null || typeof value === 'number'
      ? [line('Value', value)]
      : Array.isArray(value)
        ? [
            line('Tag count', value.length),
            ...value.map((tag, index) => line(`Tag ${index + 1}`, tag)),
          ]
        : [
            line('Basis', value.basis),
            ...Object.entries(nutritionLabels).map(([key, label]) =>
              line(label, value[key as keyof typeof nutritionLabels]),
            ),
          ];
  return [
    ...values,
    ...(field.review
      ? [
          line('Source evidence', field.review.source),
          line('Recorded by', field.review.reviewerId),
          line('Recorded at', field.review.reviewedAt),
        ]
      : [line('Review evidence', null)]),
  ];
}
/** Compare saved wire values exactly. No trimming, inferred list matching, mutation or translation. */
export function compareSavedRevisions(
  before: AdminDraft,
  after: AdminDraft,
): RevisionComparisonGroup[] | null {
  if (before.draftId !== after.draftId || before.recipeId !== after.recipeId) return null;
  const groups: RevisionComparisonGroup[] = [];
  function add<Value>(
    key: string,
    label: string,
    previous: Value,
    current: Value,
    lines: (value: Value) => ComparisonLine[],
  ) {
    groups.push({
      key,
      label,
      changed: canonicalContentJson(previous) !== canonicalContentJson(current),
      before: lines(previous),
      after: lines(current),
    });
  }
  for (const [key, label] of Object.entries(recipeFields)) {
    const field = key as keyof typeof recipeFields;
    add(field, label, before.input[field], after.input[field], (value) => [line(label, value)]);
  }
  add(
    'ingredients',
    'Ingredients, amounts and order',
    before.input.ingredients,
    after.input.ingredients,
    (items) => [
      line('Ingredient count', items.length),
      ...items.flatMap((item, index) => [
        line(`${index + 1} · Ingredient`, item.rawName),
        line(`${index + 1} · Amount`, item.rawMeasure),
      ]),
    ],
  );
  add(
    'instructions',
    'Instructions, passage types and order',
    before.input.instructions,
    after.input.instructions,
    (items) => [
      line('Original section count', items.length),
      ...items.flatMap((item, index) => [
        line(`${index + 1} · Section type`, item.presentation),
        line(`${index + 1} · Original text`, item.rawText),
      ]),
    ],
  );
  add('credits', 'Credits and their links', before.input.credits, after.input.credits, (items) => [
    line('Credit count', items.length),
    ...items.flatMap((item, index) => [
      line(`${index + 1} · Credit`, item.label),
      line(`${index + 1} · Link`, item.url),
    ]),
  ]);
  add('photoUrl', 'Saved photograph reference', before.photoUrl, after.photoUrl, (value) => [
    line('Photo URL', value),
  ]);
  add('basedOn', 'Original content reference', before.basedOn, after.basedOn, (value) =>
    value
      ? [
          line('Recipe ID', value.recipeId),
          line('Revision ID', value.revisionId),
          line('Content fingerprint', value.contentFingerprint),
        ]
      : [line('Original content reference', null)],
  );
  for (const [key, label] of Object.entries(metadataLabels)) {
    const field = key as AdminMetadataField;
    add(
      `metadata.${field}`,
      `${label} and source evidence`,
      before.metadata[field],
      after.metadata[field],
      metadataLines,
    );
  }
  for (const [key, label] of Object.entries(rightsScopes)) {
    const previous = before.rights?.find((record) => record.scope === key) ?? null;
    const current = after.rights?.find((record) => record.scope === key) ?? null;
    add(`rights.${key}`, label, previous, current, (value) =>
      value
        ? [
            line('Status', value.status),
            line('Statement', value.statement),
            line('Evidence source', value.sourceUrl),
            line('Recorded by', value.reviewerId),
            line('Recorded at', value.reviewedAt),
            line('Reviewed input revision', value.inputRevision),
            line('Content binding', value.contentBinding),
          ]
        : [line('Permission evidence', null)],
    );
  }
  add('status', 'Draft status', before.status, after.status, (value) => [line('Status', value)]);
  add('review', 'Review decision and note', before.review ?? null, after.review ?? null, (value) =>
    value
      ? [
          line('Decision', value.decision),
          line('Note', value.note),
          line('Reviewed by', value.reviewerId),
          line('Reviewed at', value.reviewedAt),
          line('Reviewed input revision', value.inputRevision),
        ]
      : [line('Review record', null)],
  );
  add('approval', 'Approval evidence', before.approval, after.approval, (value) =>
    value
      ? [
          line('Note', value.note),
          line('Approved by', value.reviewerId),
          line('Approved at', value.reviewedAt),
          line('Approved revision', value.revision),
        ]
      : [line('Approval', null)],
  );
  return groups;
}
