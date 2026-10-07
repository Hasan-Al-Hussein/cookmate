import type { IssuedRollbackPage, RollbackSelection } from './rollbackIssuance';

export function RollbackReleaseFields({
  selection,
  page,
  started,
  disabled,
  onEarlier,
  onReview,
}: {
  selection: RollbackSelection;
  page: IssuedRollbackPage | null;
  started: boolean;
  disabled: boolean;
  onEarlier(): void;
  onReview(): void;
}) {
  return (
    <>
      <h3>{selection.title || 'Untitled recipe'}</h3>
      <p>
        The name is the library label. Choose an exact previously issued version below. Saved drafts
        and their approvals stay unchanged.
      </p>
      <p className="small">
        Observed published version:{' '}
        <code style={{ overflowWrap: 'anywhere' }}>{selection.ref.revisionId}</code>
      </p>
      {page && (
        <>
          <p>
            Earlier signed release {page.head.sequence}:{' '}
            <code style={{ overflowWrap: 'anywhere' }}>{page.head.releaseId}</code>
          </p>
          {page.choice ? (
            <>
              <p>
                Exact issued version:{' '}
                <code style={{ overflowWrap: 'anywhere' }}>{page.choice.entry.ref.revisionId}</code>
              </p>
              <p className="small">
                Originally {page.choice.entry.state} in that release. Reviewing makes this version
                current in a new cumulative release; devices still require separate adoption.
              </p>
              <button className="secondary" disabled={disabled} onClick={onReview}>
                Review rollback release
              </button>
            </>
          ) : (
            <p>This release has no eligible issued version of this recipe.</p>
          )}
        </>
      )}
      {(!started || page?.previous) && (
        <button className="text-button" disabled={disabled} onClick={onEarlier}>
          Check earlier release
        </button>
      )}
      {started && !page?.previous && <p className="small">No earlier signed releases remain.</p>}
    </>
  );
}
