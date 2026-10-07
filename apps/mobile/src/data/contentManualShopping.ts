import { personalLimits, portablePersonalLimits } from '@cookmate/domain';
import type {
  Immutable,
  ManualShoppingPage,
  PersonalChange,
  PersonalCommand,
  PersonalMutationResult,
  PersonalReceipt,
  RepositoryResult,
} from '@cookmate/domain';
import {
  createContentPersonalAdmission,
  type ContentPersonalOptions,
  type PreparePersonalRows,
} from './contentPersonalAdmission';
import { isRevision } from './conversationRecords';
import type { PersonalState } from './personalRecords';
import type { SqlSession } from './sql';

export type ContentManualCommand = Extract<
  PersonalCommand,
  { kind: 'addManualItem' | 'editManualItem' | 'setManualPurchased' | 'deleteManualItem' }
>;
export interface ContentManualShopping {
  readState(): Promise<RepositoryResult<Immutable<PersonalState>>>;
  readManualShopping(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<RepositoryResult<Immutable<ManualShoppingPage>>>;
  execute(command: Immutable<ContentManualCommand>): Promise<PersonalMutationResult>;
  readReceipt(operationId: string): Promise<RepositoryResult<Immutable<PersonalReceipt> | null>>;
  resolveOperation(operationId: string): Promise<PersonalMutationResult>;
  subscribe(listener: (change: PersonalChange) => void): () => void;
  close(): void;
}
const maximumBytes = 8 * 1024 * 1024;
const encodedBytes = (characters: number) => characters * 6 + 2;

/** Manual owner-private rows have no dependency on recipe identity, body or ingredient projection. */
export function createContentManualShopping(
  options: ContentPersonalOptions,
): ContentManualShopping {
  const admission = createContentPersonalAdmission(options, {
    family: 'manual',
    commandKinds: ['addManualItem', 'editManualItem', 'setManualPurchased', 'deleteManualItem'],
  });
  async function admitManual(session: SqlSession) {
    const [usage] = await session.all<{
      count: number;
      active: number;
      bytes: number;
      invalid: number;
    }>(`SELECT COUNT(*) count,
      COALESCE(SUM(CASE WHEN deleted=0 THEN 1 ELSE 0 END),0) active,
      COALESCE(SUM(length(CAST(item_id AS BLOB))+COALESCE(length(CAST(name AS BLOB)),0)+COALESCE(length(CAST(amount_text AS BLOB)),0)+COALESCE(length(CAST(unit_text AS BLOB)),0)+COALESCE(length(CAST(category AS BLOB)),0)+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB))),0) bytes,
      COALESCE(SUM(CASE WHEN typeof(item_id)<>'text' OR length(CAST(item_id AS BLOB))<>36
      OR (name IS NOT NULL AND (typeof(name)<>'text' OR length(CAST(name AS BLOB))>${encodedBytes(personalLimits.itemNameCharacters)}))
      OR (amount_text IS NOT NULL AND (typeof(amount_text)<>'text' OR length(CAST(amount_text AS BLOB))>${encodedBytes(personalLimits.amountCharacters)}))
      OR (unit_text IS NOT NULL AND (typeof(unit_text)<>'text' OR length(CAST(unit_text AS BLOB))>${encodedBytes(personalLimits.unitCharacters)}))
      OR (category IS NOT NULL AND (typeof(category)<>'text' OR length(CAST(category AS BLOB))>16 OR category NOT IN ('produce','dairy','meat_fish','pantry','other')))
      OR typeof(purchased)<>'integer' OR purchased NOT IN(0,1) OR typeof(deleted)<>'integer' OR deleted NOT IN(0,1)
      OR (deleted=0 AND (name IS NULL OR category IS NULL))
      OR (deleted=1 AND (name IS NOT NULL OR amount_text IS NOT NULL OR unit_text IS NOT NULL OR category IS NOT NULL OR purchased<>0))
      OR typeof(revision)<>'integer' OR revision<1 OR revision>9007199254740991 OR revision>(SELECT revision FROM personal_state WHERE singleton=1)
      OR typeof(created_at)<>'text' OR length(CAST(created_at AS BLOB))>40 OR typeof(updated_at)<>'text' OR length(CAST(updated_at AS BLOB))>40 THEN 1 ELSE 0 END),0) invalid FROM manual_shopping_item`);
    admission.stored(
      usage &&
        isRevision(usage.count) &&
        usage.count <= portablePersonalLimits.manualItems &&
        isRevision(usage.active) &&
        usage.active <= personalLimits.manualItems &&
        isRevision(usage.bytes) &&
        usage.bytes <= maximumBytes &&
        usage.invalid === 0,
    );
  }
  const prepare: PreparePersonalRows = async (session) => {
    await admitManual(session);
    return { admit: admitManual };
  };
  return Object.freeze({
    ...admission.service,
    readManualShopping(input?: { cursor?: string; limit?: number }) {
      let page: { cursor?: string; limit?: number } | undefined;
      try {
        // Own page inputs before queueing, including callers retaining and mutating their object.
        if (input !== undefined) {
          if (!input || typeof input !== 'object' || Array.isArray(input))
            admission.reject('invalid_page', 'invalid_input');
          const descriptors = Object.getOwnPropertyDescriptors(input);
          if (
            Object.keys(descriptors).some(
              (key) =>
                !['cursor', 'limit'].includes(key) || !Object.hasOwn(descriptors[key]!, 'value'),
            )
          )
            admission.reject('invalid_page', 'invalid_input');
          page = {
            ...(descriptors.cursor ? { cursor: descriptors.cursor.value as string } : {}),
            ...(descriptors.limit ? { limit: descriptors.limit.value as number } : {}),
          };
        }
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
      return admission.read(() => admission.engine.readManualShopping(page), prepare);
    },
    execute(input: Immutable<ContentManualCommand>) {
      try {
        const command = admission.ownCommand(input);
        return admission.mutate(
          command.operationId,
          () => admission.engine.execute(command),
          prepare,
        );
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
  });
}
