import { OVERLAY_LIMITS } from '@cookmate/catalogue/content';
import { Field } from './components';
import type { ArchiveSelection } from './archiveSelection';

export function ArchiveVersionDetails({ selection }: { selection: ArchiveSelection }) {
  return (
    <>
      <h3>{selection.title || 'Untitled recipe'}</h3>
      <p>
        Archive the published{' '}
        {selection.matchingDraftRevision === null
          ? 'catalogue version'
          : `draft revision ${selection.matchingDraftRevision}`}
        . Saved drafts stay unchanged
        {selection.latestDraftRevision !== null &&
        selection.latestDraftRevision !== selection.matchingDraftRevision
          ? `, including latest draft revision ${selection.latestDraftRevision}`
          : ''}
        .
      </p>
      <p className="small muted">
        The recipe name above is the library label. The exact published version below identifies
        what will be archived.
      </p>
      <p className="small">
        Published version:{' '}
        <code style={{ overflowWrap: 'anywhere' }}>{selection.ref.revisionId}</code>
      </p>
      <p className="small">
        Selected from signed release {selection.head.sequence}:{' '}
        <code style={{ overflowWrap: 'anywhere' }}>{selection.head.releaseId}</code>
      </p>
      <p className="small">
        After a device verifies and adopts this release, the recipe leaves Discover. Existing exact
        recipe references remain readable.
      </p>
    </>
  );
}

export function ArchiveReleaseFields({
  selection,
  reason,
  disabled,
  onReasonChange,
}: {
  selection: ArchiveSelection;
  reason: string;
  disabled: boolean;
  onReasonChange(reason: string): void;
}) {
  return (
    <>
      <ArchiveVersionDetails selection={selection} />
      <Field
        label="Reason for archiving"
        hint="This reason will be retained in the signed release."
      >
        <textarea
          rows={3}
          value={reason}
          maxLength={OVERLAY_LIMITS.reasonCharacters}
          required
          disabled={disabled}
          onChange={(event) => onReasonChange(event.target.value)}
        />
      </Field>
    </>
  );
}
