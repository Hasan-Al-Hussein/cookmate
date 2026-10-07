import type { ContentPrivateState } from './contentPrivateState';
import {
  openPrivateContentRuntime,
  type PrivateContentRuntimeOptions,
} from './privateContentRuntime';

/** Called only while the selection owns the closed lease. Retained restore archives are
 * terminal history, not unfinished operations; verify their original receipts in the host. */
export async function assertContentGuestRecoverySettled(
  workspace: PrivateContentRuntimeOptions,
  references: ContentPrivateState['references'],
  assertClosed: () => void,
) {
  assertClosed();
  const installationId = workspace.config.installationId;
  for (const store of [
    references.notes,
    references.manual,
    references.collections,
    references.cooking,
    references.history,
  ]) {
    const pending = await store.load(installationId);
    assertClosed();
    if (pending.length)
      throw new Error('Finish the guest workspace’s pending changes before signing in.');
  }
  const restores = await references.restore.load(installationId);
  assertClosed();
  // Headless verification owns the only guest host inside this closed operation, and is
  // completely closed before the marked copy starts. It executes no mutation or recovery.
  const guest = await openPrivateContentRuntime(workspace);
  try {
    assertClosed();
    if (guest.host.getSnapshot().status !== 'ready')
      throw new Error('Review the pending recipe update before signing in.');
    for (const reference of restores) {
      const receipt = await guest.host.restore.readReceipt(reference.operationId);
      assertClosed();
      if (receipt.kind !== 'ready' || !receipt.value)
        throw new Error('Confirm the original guest restore result before signing in.');
    }
  } finally {
    await guest.close();
  }
  assertClosed();
}
