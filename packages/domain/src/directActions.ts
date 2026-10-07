import type {
  CommandPayload,
  Placement,
  PlanOccurrence,
  PreferenceSnapshot,
  PreferenceType,
  ShoppingScope,
} from '@cookmate/contracts';
import type { Immutable } from './search';

interface ShoppingSelectionGroupState {
  quantityLabel: string;
  purchased: boolean;
  changed: boolean;
}
interface ShoppingSelectionGroupEffect {
  groupKey: string;
  displayName: string;
  before: ShoppingSelectionGroupState | null;
  after: ShoppingSelectionGroupState | null;
}

/** User choices only. The data adapter resolves current targets, IDs and revisions. */
export type DirectActionInput =
  | { kind: 'setFavourite'; recipeId: string; saved: boolean }
  | { kind: 'placeRecipe'; recipeId: string; placement: Placement; occurrenceId?: string }
  | { kind: 'removePlan'; occurrenceId: string }
  | { kind: 'setShoppingSelection'; occurrenceIds: readonly string[] }
  | { kind: 'setPurchased'; groupKey: string; purchased: boolean }
  | { kind: 'savePreference'; preferenceId?: string; type: PreferenceType; explicitValue: string }
  | { kind: 'removePreference'; preferenceId: string }
  | { kind: 'clearPreferences' }
  | { kind: 'clearConversation' };

export type DirectActionConsequences =
  | { kind: 'favourite'; recipeId: string; saved: boolean }
  | {
      kind: 'plan';
      /** Existing occurrence being edited/moved/removed, or null for an add/replacement. */
      source: Immutable<PlanOccurrence> | null;
      /** Existing destination at the chosen placement; explicit occupied consequences use this. */
      destination: Immutable<PlanOccurrence> | null;
      resultRecipeId: string | null;
      resultPlacement: Immutable<Placement> | null;
      sourceSelected: boolean;
      destinationSelected: boolean;
      resultSelected: boolean;
      shoppingScope: Immutable<ShoppingScope>;
    }
  | {
      kind: 'shopping_selection';
      before: Immutable<ShoppingScope>;
      afterOccurrenceIds: readonly string[];
      afterOccurrences: readonly Immutable<PlanOccurrence>[];
      shoppingEffects: {
        added: readonly ShoppingSelectionGroupEffect[];
        removed: readonly ShoppingSelectionGroupEffect[];
        /** Exact demand provenance changed, even if its displayed quantity is the same. */
        demandChanged: readonly ShoppingSelectionGroupEffect[];
        unchanged: readonly ShoppingSelectionGroupEffect[];
        checkedMarksRequiringReview: number;
        checkedMarksRemoved: number;
      };
    }
  | {
      kind: 'purchase';
      groupKey: string;
      displayName: string;
      quantityLabel: string;
      purchased: boolean;
    }
  | { kind: 'preference'; before: Immutable<PreferenceSnapshot> }
  | {
      kind: 'conversation_clear';
      conversationId: string;
      generation: number;
      messageCount: number;
      scope: {
        /** Unicode code points, including whitespace, in the durable composer draft. */
        draftCharacterCount: number;
        referenceSetCount: number;
        /** All retained temporary memory entries, including those outside the working selection. */
        contextItemCount: number;
        /** Accepted proposal groups with work remaining; completed/cancelled groups are excluded. */
        pendingProposalCount: number | null;
        outstandingRequestCount: number;
        hasAnythingToClear: boolean;
      };
    };

export interface DirectActionReview {
  guard: DirectReviewGuard;
  input: Immutable<DirectActionInput>;
  /** Retain this exact reviewed payload through confirmation; stale guards cause refreshed review. */
  payload: Immutable<CommandPayload>;
  consequences: Immutable<DirectActionConsequences>;
}
export type DirectReviewGuard =
  | { kind: 'none' }
  | { kind: 'shopping_selection'; planRevision: number; shoppingScopeRevision: number };
