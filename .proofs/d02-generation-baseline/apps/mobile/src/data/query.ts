import type { RepositoryResult } from '@cookmate/domain';
import { StorageFault } from './sql';
import type { SerializedReader, SqlSession } from './sql';

export async function readRevision(session: SqlSession, collection: string): Promise<number> {
  const revision = (
    await session.all<{ revision: number }>(
      'SELECT revision FROM state_revision WHERE collection = ?',
      [collection],
    )
  )[0]?.revision;
  if (!Number.isSafeInteger(revision) || revision === undefined || revision < 0)
    throw new StorageFault('storage_failure', 'Stored revision is invalid');
  return revision;
}

export function freezeResult<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freezeResult);
    Object.freeze(value);
  }
  return value;
}

/** No default write or partial result is allowed when a collection cannot be read. */
export async function readSnapshot<Value>(
  reader: SerializedReader,
  read: (session: SqlSession) => Promise<Value>,
): Promise<RepositoryResult<Value>> {
  try {
    return await reader.transaction(async (session) => ({
      kind: 'ready' as const,
      revision: await readRevision(session, 'store'),
      value: freezeResult(await read(session)),
    }));
  } catch {
    return {
      kind: 'failed',
      error: {
        code: 'storage_failure',
        messageKey: 'storage.read_failed',
        retry: 'after_correction',
      },
    };
  }
}
