import type {
  ContentPlanOccurrence,
  ContentShoppingSnapshot,
} from '../../data/contentWorkspaceQueries';
import {
  recipeReferenceKey,
  shoppingNotes,
  shoppingPresentation,
  shoppingSelection,
} from './ordinaryShoppingModel';
const meal = (revision: string, date: string): ContentPlanOccurrence => ({
  occurrence: {
    occurrenceId: revision,
    recipeId: '52839',
    placement: { actualDate: date, mealKey: 'dinner' },
    revision: 1,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  contentRef: {
    recipeId: '52839',
    revisionId: revision,
    contentFingerprint: revision === 'old' ? 'a'.repeat(64) : 'b'.repeat(64),
  },
  content: {
    kind: 'readable',
    state: revision === 'old' ? 'historical' : 'current',
    title: revision === 'old' ? 'Saved old title' : 'Reviewed new title',
    photoAssetId: null,
  },
});
const selected = [meal('old', '2026-10-01'), meal('new', '2026-10-08')];
const scope = { scopeId: 'scope', revision: 3, occurrenceIds: ['old', 'new'] };
const current: Extract<ContentShoppingSnapshot, { kind: 'current' }> = {
  kind: 'current',
  selected,
  notices: [],
  share: {
    kind: 'ready',
    recipes: selected.map((entry) => ({
      contentRef: entry.contentRef,
      contentKind: 'authored' as const,
      title: entry.content.kind === 'readable' ? entry.content.title : 'Unavailable recipe',
      recipePage: null,
      originalSourceUrl: null,
      credits: [],
      retainedSources: [],
    })),
  },
  snapshot: {
    scope,
    selectedOccurrences: selected.map((entry) => entry.occurrence),
    projectionRevision: 3,
    status: 'current',
    groups: [],
  },
};
const query = (value: ContentShoppingSnapshot) => ({
  mode: 'content' as const,
  state: { kind: 'ready' as const, value, revision: 3 },
  retry: () => undefined,
});
test('unavailable exact ingredients never become an empty current list; full cross-week selection survives', () => {
  const input = query({ kind: 'unavailable', scope, selected, reason: 'content_unavailable' });
  expect(shoppingPresentation(input)).toEqual({
    kind: 'failed',
    error: expect.objectContaining({ messageKey: 'content.shopping_unavailable' }),
  });
  const selection = shoppingSelection(input);
  expect(selection.kind === 'ready' && selection.value.selectedOccurrences).toEqual(
    selected.map((entry) => entry.occurrence),
  );
  expect(selection.kind === 'ready' && selection.value.scope.occurrenceIds).toEqual(['old', 'new']);
});
test('same recipe in two revisions retains distinct titles, reference links and complete source notes', () => {
  const notices: Extract<ContentShoppingSnapshot, { kind: 'current' }>['notices'] = selected.map(
    (entry) => ({
      occurrenceId: entry.occurrence.occurrenceId,
      contentRef: entry.contentRef,
      disposition: 'current_revision',
      annotations: [
        {
          annotationId: 'same-note',
          recipeId: '52839',
          kind: 'source_gap',
          note: `Exact ${entry.contentRef.revisionId} warning`,
          ruleVersion: '1',
          evidence: [{ sheet: 'Instructions', row: 2 }],
        },
      ],
    }),
  );
  // Use the actual annotation schema fixture below; no synthetic quantities enter projections.
  const notes = shoppingNotes(query({ ...current, notices }));
  expect(notes.map((entry) => entry.title)).toEqual(['Saved old title', 'Reviewed new title']);
  expect(notes.map((entry) => entry.notes[0]?.note)).toEqual([
    'Exact old warning',
    'Exact new warning',
  ]);
  expect(new Set(notes.map((entry) => recipeReferenceKey(entry.contentRef!))).size).toBe(2);
});
