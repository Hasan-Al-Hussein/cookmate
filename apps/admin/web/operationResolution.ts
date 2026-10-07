import type { AdminOperationResolution } from '../src/contracts';
import { ApiError } from './api';

/** Only terminal proof for the exact operation may release its recovery reference. */
export function validateOperationResolution(
  expectedId: string,
  result: AdminOperationResolution,
): AdminOperationResolution {
  if (
    !result ||
    result.operationId !== expectedId ||
    (result.status !== 'committed' && result.status !== 'cancelled') ||
    (result.status === 'committed' &&
      (!result.mutation || result.mutation.operationId !== expectedId || !result.mutation.draft))
  )
    throw new ApiError(
      0,
      'resolution_mismatch',
      'The server did not confirm this operation. Its recovery reference is retained.',
    );
  return result;
}
