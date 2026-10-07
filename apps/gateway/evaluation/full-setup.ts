import assert from 'node:assert/strict';
import type {
  AssistantTurnRequest,
  AssistantTurnResponse,
  ReferenceSet,
} from '@cookmate/contracts';
import type { DirectActionInput } from '@cookmate/domain';
import { SCRIPTS } from './materialize';
import type { SetupScript } from './materialize';
import type { CaseId } from './plan';

interface ScriptResult {
  request: AssistantTurnRequest;
  response: Exclude<AssistantTurnResponse, { kind: 'error' }>;
  accepted: { acceptanceEnvelope: { assistantMessageId: string } };
}
interface SetupPorts {
  scripted(script: SetupScript): Promise<ScriptResult>;
  direct(input: DirectActionInput): Promise<unknown>;
  commit(result: ScriptResult): Promise<void>;
  reopen(localDate: string): Promise<unknown>;
  persisted(): Promise<Record<string, unknown>>;
  setClock(localDate: string, instant: string): void;
  bindings: Record<string, string | ReferenceSet>;
  setup: unknown[];
}
/** Additional controlled setups. The existing eight setups remain in materialize(). */
export async function fullSetup(id: CaseId, p: SetupPorts) {
  const reference = async (key: 'RA' | 'RB' | 'RC', script = SCRIPTS[key] as SetupScript) => {
    const result = await p.scripted(script);
    p.bindings[key] = structuredClone(result.response.referenceSets[0]!);
    p.bindings[`M${key.slice(1)}`] = result.accepted.acceptanceEnvelope.assistantMessageId;
  };
  const age = async () => {
    for (let i = 0; i < 10; i++) await p.scripted(SCRIPTS.neutral);
  };
  if (id === 'L13')
    await p.scripted({
      user: 'Compare Padron peppers, Bread omelette, Choripán and Chicken Enchilada Casserole.',
      text: '1. Padron peppers\n2. Bread omelette\n3. Choripán\n4. Chicken Enchilada Casserole',
      ids: ['53150', '53076', '53136', '52765'],
    });
  if (id === 'L16')
    await p.scripted({
      user: 'Show Padron peppers and Fettucine alfredo.',
      text: '1. Padron peppers\n2. Fettucine alfredo',
      ids: ['53150', '52835'],
    });
  if (['L19', 'L20', 'L22', 'L24', 'L39'].includes(id)) await reference('RA');
  if (['L20', 'L22', 'L24'].includes(id)) await reference('RB');
  if (id === 'L22') await age();
  if (id === 'L23')
    await p.scripted({
      user: 'Show Adana kebab.',
      text: 'Adana kebab is selected.',
      ids: ['53262'],
      selection: { selectedRecipeId: '53262' },
    });
  if (id === 'L26') {
    p.setClock('2026-09-28', '2026-09-28T19:55:00.000Z');
    await p.scripted({
      user: "No peanuts for tomorrow's dinner",
      text: 'I will keep that restriction for this conversation.',
      ids: [],
      retain: 'context',
    });
    await p.scripted({
      user: 'Lunch instead; same day and restriction.',
      text: 'The meal correction is noted for this conversation.',
      ids: [],
      retain: 'context',
    });
    await p.reopen('2026-09-29');
  }
  if (id === 'L27') {
    await p.scripted({
      user: 'Avoid peanut butter for this meal',
      text: 'Noted for this meal.',
      ids: [],
      retain: 'context',
    });
    await p.scripted({
      user: "Maybe include peanut butter after all—I haven't decided",
      text: 'That choice remains unresolved.',
      ids: [],
      retain: 'unresolved_intent',
    });
    await age();
  }
  if (id === 'L36')
    await p.scripted({
      user: 'Tell me about Padron peppers.',
      text: 'Saved Padron peppers',
      ids: ['53150'],
    });
  if (id === 'L38') {
    const result = await p.scripted({
      user: 'Plan Adana kebab for dinner on Monday 5 October 2026.',
      text: 'Review this dinner plan.',
      ids: ['53262'],
      proposal: {
        kind: 'addPlan',
        recipeId: '53262',
        placement: { actualDate: '2026-10-05', mealKey: 'dinner' },
        expectedTarget: { kind: 'empty' },
      },
      retain: 'context',
    });
    await p.commit(result);
    p.bindings.predecessorIntent = result.request.userIntentId;
  }
  if (id === 'L40') await p.commit(await p.scripted(SCRIPTS.preference));
  if (id === 'L41') {
    await p.commit(
      await p.scripted({
        user: 'Remember that I avoid peanut butter.',
        text: 'Review saving this preference.',
        ids: [],
        proposal: {
          kind: 'savePreference',
          type: 'ingredient_avoid',
          explicitValue: 'peanut butter',
        },
        retain: 'context',
      }),
    );
    await p.scripted(SCRIPTS.RA);
    const before = await p.persisted();
    await p.direct({ kind: 'clearConversation' });
    const after = await p.persisted();
    const beforeHeader = (
      before.conversation as { conversation_id: string; generation: number }[]
    )[0]!;
    const afterHeader = (
      after.conversation as { conversation_id: string; generation: number; next_sequence: number }[]
    )[0]!;
    assert.equal(afterHeader.conversation_id, beforeHeader.conversation_id);
    assert.equal(afterHeader.generation, beforeHeader.generation + 1);
    assert.equal(afterHeader.next_sequence, 0);
    for (const table of [
      'message',
      'message_context',
      'memory_source_review',
      'memory_entry',
      'memory_relation',
      'reference_set',
      'reference_item',
      'assistant_intent_context',
      'assistant_acceptance',
      'assistant_acceptance_envelope',
      'assistant_action_plan',
    ])
      assert.deepEqual(after[table], [], `clear_left_${table}`);
    assert.deepEqual(after.saved_preference, before.saved_preference);
    const oldAssistantIds = (before.assistant_intent_context as { user_intent_id: string }[]).map(
      (row) => row.user_intent_id,
    );
    assert.ok(oldAssistantIds.length > 0);
    assert.ok(
      (after.pending_intent as { user_intent_id: string }[]).every(
        (row) => !oldAssistantIds.includes(row.user_intent_id),
      ),
      'clear_left_assistant_pending_intent',
    );
    const oldReceipts = before.operation_receipt as Record<string, unknown>[];
    const newReceipts = after.operation_receipt as Record<string, unknown>[];
    assert.ok(oldReceipts.length > 0);
    for (const receipt of oldReceipts)
      assert.ok(
        newReceipts.some((candidate) => JSON.stringify(candidate) === JSON.stringify(receipt)),
        'clear_lost_receipt',
      );
    p.setup.push({ kind: 'REAL_CLEAR_PRESERVATION_PROOF', before, after });
  }
  if (id === 'L42')
    await reference('RC', {
      ...SCRIPTS.RC,
      text: '1. Fettuccine Alfredo (6 ingredient rows)\n2. Fettucine alfredo (7 ingredient rows)',
    });
  assert.ok(
    !['L25', 'L44', 'L45', 'L48'].includes(id) || !Object.keys(p.bindings).length,
    'special_adapter_must_start_F0',
  );
}
