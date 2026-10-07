import { useRef, useState } from 'react';
import { View } from 'react-native';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import type { Immutable } from '@cookmate/domain';
import { ActionButton, Notice } from '../../components/Controls';
import { AppText } from '../../components/Typography';
import type { ContentCookedReceipt } from '../../data/contentCookingHistoryRecords';
import type { ContentCookingReaderHost } from './contentCookingPorts';
import {
  contentCookingReferenceId,
  type ContentCookingReference,
} from './contentCookingReferences';
import type { useContentSessionOperations } from './useContentCookingProgress';

/** Metadata-only recovery is available even when no recipe body can be opened. */
export function ContentCookingRecovery({
  host,
  operations,
  isCurrent,
  onConfirmed,
  onCookedReceipt,
}: {
  host: ContentCookingReaderHost;
  operations: ReturnType<typeof useContentSessionOperations>;
  isCurrent(): boolean;
  onConfirmed(): Promise<void>;
  onCookedReceipt?: (
    receipt: Immutable<ContentCookedReceipt>,
    record: Immutable<ContentCookingReference>,
  ) => Promise<boolean>;
}) {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const running = useRef(false),
    latest = useRef({ operations, onConfirmed, onCookedReceipt });
  latest.current = { operations, onConfirmed, onCookedReceipt };
  async function cooked(record: Immutable<ContentCookingReference>, resolve: boolean) {
    if (
      record.kind !== 'cooked' ||
      !isCurrent() ||
      running.current ||
      operations.busy ||
      !latest.current.operations.recovery.records.some(
        (entry) => canonicalContentJson(entry) === canonicalContentJson(record),
      )
    )
      return;
    running.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = resolve
        ? await host.cooked.resolveCookedRecovery(record.reference)
        : await host.cooked.readCookedRecovery(record.reference);
      if (!isCurrent()) return;
      if (result.kind !== 'ready' || !result.value) {
        setMessage(
          'No terminal cooking receipt could be confirmed. The original reference is retained; no entry has been repeated.',
        );
        return;
      }
      const receipt = result.value,
        id = receipt.kind === 'saved' ? receipt.event.eventId : receipt.eventId;
      if (id !== record.reference.eventId) throw new Error('Mismatched receipt');
      if (
        latest.current.onCookedReceipt &&
        !(await latest.current.onCookedReceipt(receipt, record))
      )
        return;
      if (!isCurrent()) return;
      await latest.current.operations.recovery.release(record);
      if (!isCurrent()) return;
      await latest.current.onConfirmed();
      if (isCurrent())
        setMessage(
          receipt.kind === 'saved'
            ? 'The cooking entry was confirmed.'
            : receipt.kind === 'cancelled'
              ? 'The unsaved request was cancelled. It cannot create a late duplicate.'
              : 'The earlier entry belongs to history that was cleared. It has not been recreated.',
        );
    } catch {
      if (isCurrent())
        setMessage(
          'The result could not be confirmed. Keep this operation reference and check again.',
        );
    } finally {
      running.current = false;
      if (isCurrent()) setBusy(false);
    }
  }
  const disabled = busy || operations.busy;
  return (
    <>
      {operations.recovery.records.map((record) => (
        <Notice
          key={contentCookingReferenceId(record)}
          title={
            record.kind === 'session'
              ? 'Check an earlier reading change'
              : 'Check an earlier cooking entry'
          }
          tone="caution"
        >
          <AppText role="support" selectable>
            Operation ID: {contentCookingReferenceId(record)}
          </AppText>
          {record.kind === 'session' ? (
            <>
              <AppText>
                The original request is retained. Checking does not repeat it; retry uses the same
                operation and saved-session baseline.
              </AppText>
              <ActionButton
                label="Check saved reading position"
                disabled={disabled}
                onPress={() => {
                  if (isCurrent()) void operations.check(record);
                }}
              />
              <ActionButton
                label="Retry this same request"
                variant="secondary"
                disabled={disabled}
                onPress={() => {
                  if (isCurrent()) void operations.retry(record);
                }}
              />
            </>
          ) : (
            <>
              <AppText>
                Check the receipt, or resolve this request to confirm a saved entry or cancel an
                unsaved request. No private note draft is stored in this reference.
              </AppText>
              <ActionButton
                label="Check cooking receipt"
                disabled={disabled}
                onPress={() => void cooked(record, false)}
              />
              <ActionButton
                label="Resolve unconfirmed cooking change"
                variant="secondary"
                disabled={disabled}
                onPress={() => void cooked(record, true)}
              />
            </>
          )}
        </Notice>
      ))}
      {operations.recovery.error && (
        <Notice title="Cooking recovery needs attention" tone="error">
          {operations.recovery.error}
          <ActionButton
            label="Reload cooking recovery"
            variant="quiet"
            disabled={disabled}
            onPress={() => {
              if (isCurrent()) operations.recovery.reload();
            }}
          />
        </Notice>
      )}
      {operations.error && (
        <Notice title="Reading progress needs attention" tone="caution">
          {operations.error}
        </Notice>
      )}
      {message && (
        <View>
          <AppText accessibilityLiveRegion="polite">{message}</AppText>
        </View>
      )}
    </>
  );
}
