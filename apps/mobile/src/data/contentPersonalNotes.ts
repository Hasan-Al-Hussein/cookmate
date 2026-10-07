import { catalogueBoundary } from '@cookmate/catalogue';
import { OVERLAY_LIMITS } from '@cookmate/catalogue/content';
import type {
  Immutable,
  PersonalChange,
  PersonalCommand,
  PersonalMutationResult,
  PersonalReceipt,
  RecipeNote,
  RepositoryResult,
} from '@cookmate/domain';
import { isAppId, isRevision } from './conversationRecords';
import {
  createContentPersonalAdmission,
  samePersonalFence,
  type ContentPersonalOptions,
  type PreparePersonalRows,
} from './contentPersonalAdmission';
import type { openContentReleaseStore } from './contentReleaseStore';
import type { PersonalState } from './personalRecords';
import { runBound, type SqlSession } from './sql';

export type ContentNoteCommand = Extract<PersonalCommand, { kind: 'saveNote' | 'deleteNote' }>;
export interface ContentRecipeNoteSnapshot {
  epoch: number;
  note: RecipeNote | null;
}
export interface ContentPersonalNotes {
  readState(): Promise<RepositoryResult<Immutable<PersonalState>>>;
  readRecipeNote(recipeId: string): Promise<RepositoryResult<Immutable<ContentRecipeNoteSnapshot>>>;
  execute(command: Immutable<ContentNoteCommand>): Promise<PersonalMutationResult>;
  readReceipt(operationId: string): Promise<RepositoryResult<Immutable<PersonalReceipt> | null>>;
  resolveOperation(operationId: string): Promise<PersonalMutationResult>;
  subscribe(listener: (change: PersonalChange) => void): () => void;
  close(): void;
}
interface Options extends ContentPersonalOptions {
  contentStore: Pick<
    Awaited<ReturnType<typeof openContentReleaseStore>>,
    'withVerifiedReferenceInspection'
  >;
}
type NoteTarget = { recipeId: string } | { noteId: string };
const recipeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,20}$/.test(value);

/** Recipe identity admission stays local to notes; scope, clocks and recovery use the common boundary. */
export function createContentPersonalNotes(options: Options): ContentPersonalNotes {
  const inspect = options.contentStore.withVerifiedReferenceInspection.bind(options.contentStore);
  const knownIds = new Set<string>();
  const admission = createContentPersonalAdmission(options, {
    family: 'notes',
    commandKinds: ['saveNote', 'deleteNote'],
    recipeIds: knownIds,
    async beforeSaveNote(session, id): Promise<void> {
      admission.check();
      if (!knownIds.has(id)) admission.reject('unknown_recipe', 'invalid_input');
      await runBound(
        session,
        'INSERT INTO recipe_identity(recipe_id) VALUES (?) ON CONFLICT(recipe_id) DO NOTHING',
        [id],
      );
    },
    onClose: () => knownIds.clear(),
  });
  async function admitNotes(session: SqlSession) {
    const [usage] = await session.all<{
      count: number;
      bytes: number;
      invalid: number;
    }>(`SELECT COUNT(*) count,
      COALESCE(SUM(length(CAST(note_id AS BLOB))+length(CAST(recipe_id AS BLOB))+COALESCE(length(CAST(text AS BLOB)),0)+length(CAST(created_at AS BLOB))+length(CAST(updated_at AS BLOB))),0) bytes,
      COALESCE(SUM(CASE WHEN typeof(note_id)<>'text' OR length(CAST(note_id AS BLOB))<>36
      OR typeof(recipe_id)<>'text' OR length(CAST(recipe_id AS BLOB)) NOT BETWEEN 1 AND 20 OR instr(recipe_id,char(0))>0 OR recipe_id GLOB '*[^0-9]*'
      OR (text IS NOT NULL AND (typeof(text)<>'text' OR length(CAST(text AS BLOB))>24002))
      OR typeof(deleted)<>'integer' OR deleted NOT IN(0,1) OR (deleted=1 AND text IS NOT NULL) OR (deleted=0 AND text IS NULL)
      OR typeof(revision)<>'integer' OR revision<1 OR revision>9007199254740991 OR revision>(SELECT revision FROM personal_state WHERE singleton=1)
      OR typeof(created_at)<>'text' OR length(CAST(created_at AS BLOB))>40 OR typeof(updated_at)<>'text' OR length(CAST(updated_at AS BLOB))>40 THEN 1 ELSE 0 END),0) invalid FROM recipe_note`);
    admission.stored(
      usage &&
        isRevision(usage.count) &&
        usage.count <= 10_000 &&
        isRevision(usage.bytes) &&
        usage.bytes <= 8 * 1024 * 1024 &&
        usage.invalid === 0,
    );
    const ids = await session.all<{ recipeId: string; noteId: string; retained: number }>(
      'SELECT n.recipe_id recipeId,n.note_id noteId,EXISTS(SELECT 1 FROM recipe_identity r WHERE r.recipe_id=n.recipe_id) retained FROM recipe_note n',
    );
    admission.stored(
      ids.every((row) => isAppId(row.noteId) && recipeId(row.recipeId) && row.retained === 1),
    );
    return ids;
  }

  function prepare(target: NoteTarget): PreparePersonalRows {
    return async (session) => {
      const notes = await admitNotes(session);
      const retained = notes.find((note) =>
        'recipeId' in target ? note.recipeId === target.recipeId : note.noteId === target.noteId,
      );
      if ('noteId' in target && !retained) admission.reject('unknown_note', 'invalid_input');
      return {
        async admit(current) {
          const rows = await admitNotes(current);
          if (retained)
            admission.stored(
              rows.some(
                (row) => row.noteId === retained.noteId && row.recipeId === retained.recipeId,
              ),
            );
        },
        async reserve(head, work) {
          knownIds.clear();
          // A persisted note and its FK identity retain private text authority, never body authority.
          if (retained) {
            knownIds.add(retained.recipeId);
            return work(admission.check);
          }
          return inspect(head, [], async (view) => {
            const guard = (): undefined => {
              admission.check();
              admission.stored(view.assertActive() === undefined);
              return undefined;
            };
            guard();
            admission.stored(samePersonalFence(view.head, head));
            const ids = view.adoptedRecipeIds;
            admission.stored(
              Array.isArray(ids) &&
                ids.length <= OVERLAY_LIMITS.overrides + catalogueBoundary.recipeIds.size &&
                ids.every(recipeId) &&
                new Set(ids).size === ids.length,
            );
            for (const id of ids) knownIds.add(id);
            return work(guard);
          });
        },
        release: () => knownIds.clear(),
      };
    };
  }
  return Object.freeze({
    ...admission.service,
    readRecipeNote(id: string) {
      try {
        if (!recipeId(id)) admission.reject('invalid_recipe', 'invalid_input');
        return admission.read(() => admission.engine.readRecipeNote(id), prepare({ recipeId: id }));
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
    execute(input: Immutable<ContentNoteCommand>) {
      try {
        const command = admission.ownCommand(input);
        return admission.mutate(
          command.operationId,
          () => admission.engine.execute(command),
          prepare(
            command.kind === 'saveNote'
              ? { recipeId: command.recipeId }
              : { noteId: command.noteId },
          ),
        );
      } catch (error) {
        return Promise.resolve(admission.failure(error));
      }
    },
  });
}
