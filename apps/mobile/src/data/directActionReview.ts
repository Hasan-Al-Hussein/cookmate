import { checkLocalCommand, CONTRACT_SCHEMA_VERSION } from '@cookmate/contracts';
import type { CatalogueBoundary, CommandPayload, PlanOccurrence } from '@cookmate/contracts';
import type {
  CommandPlatform,
  Immutable,
  RepositoryResult,
  ShoppingProjectionOptions,
} from '@cookmate/domain';
import type { DirectActionInput, DirectActionReview } from '@cookmate/domain';
import { isSupportedPlanDate } from '@cookmate/domain';
import { CommandFault, rejectCommand } from './commandExecutor';
import { isAppId } from './conversationRecords';
import { readConversationClearScope } from './conversationClearScope';
import { freezeResult, readRevision } from './query';
import { readShoppingLedgerInSnapshot } from './shoppingRepository';
import { shoppingSelectionEffects } from './shoppingSelectionEffects';
import {
  readPlanInSnapshot,
  readPreferencesInSnapshot,
  readShoppingScopeInSnapshot,
} from './stateRepositories';
import { StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';
import { contentCommandSession, type ContentCommandContext } from './contentCommandContext';

interface ReviewOptions extends ShoppingProjectionOptions {
  catalogue: CatalogueBoundary;
  platform: Pick<CommandPlatform, 'newId'>;
  /** Capture private authority from the same SQL snapshot as the visible consequences. */
  onReviewed?(session: SqlSession, review: Immutable<DirectActionReview>): Promise<void>;
}
async function occurrenceById(
  session: SqlSession,
  id: string,
  catalogue: CatalogueBoundary,
): Promise<PlanOccurrence> {
  if (!isAppId(id)) rejectCommand('invalid_input', 'plan.invalid_occurrence');
  const row = (
    await session.all<{ actualDate: string }>(
      'SELECT local_date AS actualDate FROM plan_occurrence WHERE occurrence_id=?',
      [id],
    )
  )[0];
  if (!row) rejectCommand('stale_context', 'plan.occurrence_missing');
  if (!isSupportedPlanDate(row.actualDate))
    throw new StorageFault('storage_failure', 'Stored occurrence date is invalid');
  const occurrence = (
    await readPlanInSnapshot(session, catalogue, row.actualDate, row.actualDate)
  ).occurrences.find((item) => item.occurrenceId === id);
  if (!occurrence) throw new StorageFault('storage_failure', 'Stored occurrence is unavailable');
  return JSON.parse(JSON.stringify(occurrence)) as PlanOccurrence;
}

async function reviewInSnapshot(
  session: SqlSession,
  input: Immutable<DirectActionInput>,
  options: ReviewOptions,
  content?: ContentCommandContext,
): Promise<Omit<DirectActionReview, 'guard'>> {
  if (input.kind === 'setFavourite')
    return {
      input,
      payload: input,
      consequences: { kind: 'favourite', recipeId: input.recipeId, saved: input.saved },
    };
  if (input.kind === 'placeRecipe' || input.kind === 'removePlan') {
    const scope = content
      ? (await readShoppingLedgerInSnapshot(session, await content.projection(session))).snapshot
          .scope
      : await readShoppingScopeInSnapshot(session);
    const source =
      input.occurrenceId !== undefined
        ? await occurrenceById(session, input.occurrenceId, options.catalogue)
        : null;
    if (input.kind === 'removePlan') {
      if (!source) rejectCommand('stale_context', 'plan.occurrence_missing');
      if (content) await content.readPin(session, source.occurrenceId, source.recipeId);
      return {
        input,
        payload: {
          kind: 'removePlan',
          occurrenceId: source.occurrenceId,
          expectedRevision: source.revision,
          expectedShoppingScopeRevision: scope.revision,
        },
        consequences: {
          kind: 'plan',
          source,
          destination: null,
          resultRecipeId: null,
          resultPlacement: null,
          sourceSelected: scope.occurrenceIds.includes(source.occurrenceId),
          destinationSelected: false,
          resultSelected: false,
          shoppingScope: scope,
        },
      };
    }
    if (!isSupportedPlanDate(input.placement.actualDate))
      rejectCommand('invalid_input', 'plan.invalid_date');
    const destination =
      (
        await readPlanInSnapshot(
          session,
          options.catalogue,
          input.placement.actualDate,
          input.placement.actualDate,
        )
      ).occurrences.find((item) => item.placement.mealKey === input.placement.mealKey) ?? null;
    if (content) {
      const existing = source ?? destination;
      if (!existing || existing.recipeId !== input.recipeId) content.requireCurrent(input.recipeId);
      const occurrences = [source, destination].filter(
        (item): item is PlanOccurrence => item !== null,
      );
      // Unselected history can be moved/removed without exposing a withdrawn body.
      // Selected demand was validated above; new/different targets require current content.
      for (const item of new Map(occurrences.map((item) => [item.occurrenceId, item])).values())
        await content.readPin(session, item.occurrenceId, item.recipeId);
    }
    let payload: CommandPayload;
    if (source && destination && source.occurrenceId !== destination.occurrenceId)
      payload = {
        kind: 'movePlanReplacing',
        occurrenceId: source.occurrenceId,
        expectedRevision: source.revision,
        expectedShoppingScopeRevision: scope.revision,
        destinationOccurrenceId: destination.occurrenceId,
        expectedDestinationRevision: destination.revision,
        recipeId: input.recipeId,
        placement: { ...input.placement },
      };
    else if (source) {
      payload = {
        kind: 'editPlan',
        occurrenceId: source.occurrenceId,
        expectedRevision: source.revision,
        expectedShoppingScopeRevision: scope.revision,
        recipeId: input.recipeId,
        placement: { ...input.placement },
      };
    } else if (destination)
      payload = {
        kind: 'replacePlanRecipe',
        occurrenceId: destination.occurrenceId,
        expectedRevision: destination.revision,
        expectedShoppingScopeRevision: scope.revision,
        recipeId: input.recipeId,
        placement: { ...input.placement },
      };
    else
      payload = {
        kind: 'addPlan',
        occurrenceId: options.platform.newId(),
        recipeId: input.recipeId,
        placement: { ...input.placement },
        expectedTarget: { kind: 'empty' },
      };
    const sourceSelected = source !== null && scope.occurrenceIds.includes(source.occurrenceId);
    const destinationSelected =
      destination !== null && scope.occurrenceIds.includes(destination.occurrenceId);
    return {
      input,
      payload,
      consequences: {
        kind: 'plan',
        source,
        destination,
        resultRecipeId: input.recipeId,
        resultPlacement: input.placement,
        sourceSelected,
        destinationSelected,
        resultSelected: source ? sourceSelected : destinationSelected,
        shoppingScope: scope,
      },
    };
  }
  if (input.kind === 'setShoppingSelection') {
    const ledger = await readShoppingLedgerInSnapshot(
      session,
      content ? await content.projection(session) : options,
    );
    const scope = ledger.snapshot.scope;
    const ids = [...new Set(input.occurrenceIds)].sort();
    if (
      ids.length > 1000 ||
      ids.length !== input.occurrenceIds.length ||
      ids.some((id) => !isAppId(id))
    )
      rejectCommand('invalid_input', 'shopping.invalid_selection');
    const afterOccurrences: PlanOccurrence[] = [];
    for (const id of ids)
      afterOccurrences.push(await occurrenceById(session, id, options.catalogue));
    return {
      input,
      payload: {
        kind: 'setShoppingSelection',
        occurrenceIds: ids,
        expectedShoppingScopeRevision: scope.revision,
        expectedShoppingRevision: await readRevision(session, 'shopping'),
      },
      consequences: {
        kind: 'shopping_selection',
        before: scope,
        afterOccurrenceIds: ids,
        afterOccurrences,
        shoppingEffects: await shoppingSelectionEffects(
          ledger,
          afterOccurrences,
          content ? await content.projectionForOccurrences(session, afterOccurrences) : options,
        ),
      },
    };
  }
  if (input.kind === 'setPurchased') {
    const { snapshot } = await readShoppingLedgerInSnapshot(
      session,
      content ? await content.projection(session) : options,
    );
    const group = snapshot.groups.find((item) => item.groupKey === input.groupKey);
    if (!group) rejectCommand('stale_context', 'shopping.group_missing');
    return {
      input,
      payload: {
        kind: 'setPurchased',
        groupKey: group.groupKey,
        scopeId: snapshot.scope.scopeId,
        expectedDemandFingerprint: group.demandFingerprint,
        expectedRevision: group.revision,
        purchased: input.purchased,
      },
      consequences: {
        kind: 'purchase',
        groupKey: group.groupKey,
        displayName: group.displayName,
        quantityLabel: group.quantityLabel,
        purchased: input.purchased,
      },
    };
  }
  if (
    input.kind === 'savePreference' ||
    input.kind === 'removePreference' ||
    input.kind === 'clearPreferences'
  ) {
    const before = await readPreferencesInSnapshot(session);
    const expectedPreferenceRevision = before.revision;
    let payload: CommandPayload;
    if (input.kind === 'savePreference') {
      if (
        input.preferenceId &&
        !before.items.some((item) => item.preferenceId === input.preferenceId)
      )
        rejectCommand('stale_context', 'preferences.preference_missing');
      payload = {
        kind: 'savePreference',
        preferenceId: input.preferenceId ?? options.platform.newId(),
        type: input.type,
        explicitValue: input.explicitValue,
        expectedPreferenceRevision,
      };
    } else payload = { ...input, expectedPreferenceRevision };
    return { input, payload, consequences: { kind: 'preference', before } };
  }
  if (input.kind === 'clearConversation') {
    const { header, fingerprint, messageCount, scope } = await readConversationClearScope(
      session,
      options,
    );
    return {
      input,
      payload: {
        kind: 'clearConversation',
        conversationId: header.conversationId,
        expectedGeneration: header.generation,
        expectedScopeFingerprint: fingerprint,
      },
      consequences: {
        kind: 'conversation_clear',
        conversationId: header.conversationId,
        generation: header.generation,
        messageCount,
        scope,
      },
    };
  }
  rejectCommand('invalid_input', 'command.unknown_direct_action');
}

/** Read-only preparation of concrete consequences; only explicit confirmation authorizes registration. */
export function createDirectActionReviewer(
  reader: SerializedReader,
  options: ReviewOptions,
  content?: ContentCommandContext,
) {
  const reviewedOptions = content ? { ...options, catalogue: content.commandBoundary } : options;
  return async (
    input: Immutable<DirectActionInput>,
  ): Promise<RepositoryResult<Immutable<DirectActionReview>>> => {
    try {
      if (
        content &&
        input.kind === 'setShoppingSelection' &&
        (!Array.isArray(input.occurrenceIds) ||
          input.occurrenceIds.length > 1000 ||
          input.occurrenceIds.some(
            (id) => typeof id !== 'string' || id.length !== 36 || !isAppId(id),
          ) ||
          new Set(input.occurrenceIds).size !== input.occurrenceIds.length)
      )
        rejectCommand('invalid_input', 'shopping.invalid_selection');
      const owned = JSON.parse(JSON.stringify(input)) as DirectActionInput;
      return await reader.transaction(async (raw) => {
        const session = content ? await contentCommandSession(raw, content) : raw;
        const base = await reviewInSnapshot(session, owned, reviewedOptions, content);
        const review: DirectActionReview = {
          ...base,
          guard:
            base.payload.kind === 'setShoppingSelection'
              ? {
                  kind: 'shopping_selection',
                  planRevision: await readRevision(session, 'plan'),
                  shoppingScopeRevision: base.payload.expectedShoppingScopeRevision,
                }
              : { kind: 'none' },
        };
        const check = checkLocalCommand(
          {
            schemaVersion: CONTRACT_SCHEMA_VERSION,
            operationId: options.platform.newId(),
            userIntentId: options.platform.newId(),
            intentRevision: 0,
            payloadFingerprint: '0'.repeat(64),
            command: review.payload,
          },
          reviewedOptions.catalogue,
        );
        if (!check.ok) throw new CommandFault(check.error);
        await options.onReviewed?.(session, review);
        return {
          kind: 'ready',
          value: freezeResult(review),
          revision: await readRevision(session, 'store'),
        };
      });
    } catch (error) {
      return {
        kind: 'failed',
        error:
          error instanceof CommandFault
            ? error.detail
            : {
                code: 'storage_failure',
                messageKey: 'storage.direct_review_failed',
                retry: 'after_correction',
              },
      };
    }
  };
}
