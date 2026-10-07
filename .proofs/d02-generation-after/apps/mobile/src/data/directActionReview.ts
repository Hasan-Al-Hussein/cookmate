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
import { isAppId, readConversationHeader } from './conversationRecords';
import { freezeResult, readRevision } from './query';
import { readShoppingLedgerInSnapshot } from './shoppingRepository';
import {
  readPlanInSnapshot,
  readPreferencesInSnapshot,
  readShoppingScopeInSnapshot,
} from './stateRepositories';
import { StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';

interface ReviewOptions extends ShoppingProjectionOptions {
  catalogue: CatalogueBoundary;
  platform: Pick<CommandPlatform, 'newId'>;
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
): Promise<Omit<DirectActionReview, 'guard'>> {
  if (input.kind === 'setFavourite')
    return {
      input,
      payload: input,
      consequences: { kind: 'favourite', recipeId: input.recipeId, saved: input.saved },
    };
  if (input.kind === 'placeRecipe' || input.kind === 'removePlan') {
    const scope = await readShoppingScopeInSnapshot(session);
    const source =
      input.occurrenceId !== undefined
        ? await occurrenceById(session, input.occurrenceId, options.catalogue)
        : null;
    if (input.kind === 'removePlan') {
      if (!source) rejectCommand('stale_context', 'plan.occurrence_missing');
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
    const scope = await readShoppingScopeInSnapshot(session);
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
      },
      consequences: {
        kind: 'shopping_selection',
        before: scope,
        afterOccurrenceIds: ids,
        afterOccurrences,
      },
    };
  }
  if (input.kind === 'setPurchased') {
    const { snapshot } = await readShoppingLedgerInSnapshot(session, options);
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
    const header = await readConversationHeader(session);
    const count = (
      await session.all<{ count: number }>(
        'SELECT COUNT(*) AS count FROM message WHERE conversation_id=? AND generation=?',
        [header.conversationId, header.generation],
      )
    )[0]!.count;
    return {
      input,
      payload: {
        kind: 'clearConversation',
        conversationId: header.conversationId,
        expectedGeneration: header.generation,
      },
      consequences: {
        kind: 'conversation_clear',
        conversationId: header.conversationId,
        generation: header.generation,
        messageCount: count,
      },
    };
  }
  rejectCommand('invalid_input', 'command.unknown_direct_action');
}

/** Read-only preparation of concrete consequences; only explicit confirmation authorizes registration. */
export function createDirectActionReviewer(reader: SerializedReader, options: ReviewOptions) {
  return async (
    input: Immutable<DirectActionInput>,
  ): Promise<RepositoryResult<Immutable<DirectActionReview>>> => {
    try {
      const owned = JSON.parse(JSON.stringify(input)) as DirectActionInput;
      return await reader.transaction(async (session) => {
        const base = await reviewInSnapshot(session, owned, options);
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
          options.catalogue,
        );
        if (!check.ok) throw new CommandFault(check.error);
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
