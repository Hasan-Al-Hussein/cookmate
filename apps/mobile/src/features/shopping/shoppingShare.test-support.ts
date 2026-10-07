import type { ContentShoppingSnapshot } from '../../data/contentWorkspaceQueries';
import type { ShoppingSnapshot } from '@cookmate/domain';

/** Synthetic public fixture; no user workspace or file access. */
export function shoppingShareFixture(): ShoppingSnapshot {
  const timestamp = '2026-09-30T08:00:00.000Z';
  return {
    scope: { scopeId: 'test-scope', revision: 2, occurrenceIds: ['meal-first', 'meal-next-week'] },
    selectedOccurrences: [
      {
        occurrenceId: 'meal-first',
        recipeId: '52839',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        placement: { actualDate: '2026-09-30', mealKey: 'dinner' },
      },
      {
        occurrenceId: 'meal-next-week',
        recipeId: '52982',
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        placement: { actualDate: '2026-10-08', mealKey: 'lunch' },
      },
    ],
    projectionRevision: 2,
    status: 'current',
    groups: [
      {
        groupKey: 'exact',
        displayName: 'Pasta',
        quantityLabel: '475 g',
        contributions: [],
        demandFingerprint: 'first',
        purchased: false,
        changed: true,
        revision: 1,
      },
      {
        groupKey: 'missing',
        displayName: 'Salt',
        quantityLabel: 'Amount not supplied',
        contributions: [],
        demandFingerprint: 'second',
        purchased: true,
        changed: false,
        revision: 1,
      },
      {
        groupKey: 'source',
        displayName: 'Sauce ingredients',
        quantityLabel: 'Review source instructions',
        contributions: [
          {
            contributionId: 'source-conflict',
            occurrenceId: 'meal-next-week',
            recipeId: '52982',
            source: { recipeId: '52982', section: 'ingredient', position: 1 },
            rawName: 'Source ingredient',
            rawMeasure: null,
            quantity: { kind: 'review_source' },
          },
        ],
        demandFingerprint: 'third',
        purchased: false,
        changed: false,
        revision: 1,
      },
    ],
  };
}

/** Controlled already-verified DTO, not evidence of cryptographic verification. */
export function contentShoppingShareFixture(): Extract<
  ContentShoppingSnapshot,
  { kind: 'current' }
> {
  const source = shoppingShareFixture();
  const refs = [
    {
      recipeId: '52839',
      revisionId: 'a0000000-0000-4000-8000-000000000001',
      contentFingerprint: 'a'.repeat(64),
    },
    {
      recipeId: '52839',
      revisionId: 'a0000000-0000-4000-8000-000000000002',
      contentFingerprint: 'b'.repeat(64),
    },
  ];
  const selectedOccurrences = source.selectedOccurrences.map((meal) => ({
    ...meal,
    recipeId: '52839',
  }));
  const snapshot = {
    ...source,
    selectedOccurrences,
    groups: source.groups.map((group) => ({
      ...group,
      contributions: group.contributions.map((entry) => ({
        ...entry,
        recipeId: '52839',
        contentRef: refs[1]!,
      })),
    })),
  };
  return {
    kind: 'current',
    snapshot,
    selected: selectedOccurrences.map((occurrence, index) => ({
      occurrence,
      contentRef: refs[index]!,
      content: {
        kind: 'readable',
        state: index === 0 ? 'historical' : 'current',
        title: index === 0 ? 'Original pasta' : 'Revised pasta',
        photoAssetId: null,
      },
    })),
    notices: [
      {
        occurrenceId: selectedOccurrences[1]!.occurrenceId,
        contentRef: refs[0]!,
        disposition: 'inherited_unresolved',
        annotations: [
          {
            annotationId: 'source-warning',
            recipeId: '52839',
            kind: 'source_gap',
            note: 'Keep this original warning exactly.',
            evidence: [{ sheet: 'Instructions', row: 2 }],
            ruleVersion: 'test',
          },
        ],
      },
    ],
    share: {
      kind: 'ready',
      recipes: [
        {
          contentRef: refs[0]!,
          contentKind: 'imported',
          title: 'Original pasta',
          recipePage: 'https://www.themealdb.com/meal/52839',
          originalSourceUrl: 'https://original.test/pasta',
          credits: [],
          retainedSources: [],
        },
        {
          contentRef: refs[1]!,
          contentKind: 'authored',
          title: 'Revised pasta',
          recipePage: null,
          originalSourceUrl: null,
          credits: [{ label: 'Recipe author', url: 'https://author.test/pasta' }],
          retainedSources: [
            {
              ref: refs[0]!,
              disposition: 'inherited_unresolved',
              title: 'Original pasta',
              recipePage: 'https://www.themealdb.com/meal/52839',
              originalSourceUrl: 'https://original.test/pasta',
            },
          ],
        },
      ],
    },
  };
}
