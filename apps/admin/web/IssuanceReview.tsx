import { useEffect, useRef, useState } from 'react';
import type {
  AdminPublicationPreparation,
  AdminPublicationIssueReceipt,
  AdminUser,
} from '../src/contracts';
import { AdminApi, ApiError, errorMessage } from './api';
import { Notice } from './components';
import { ArchiveReleaseFields, ArchiveVersionDetails } from './ArchiveReleaseFields';
import type { ArchiveSelection } from './archiveSelection';
import { RollbackReleaseFields } from './RollbackReleaseFields';
import {
  readIssuedRollbackPage,
  rollbackReleaseState,
  prepareRollbackIssuanceProposal,
  type IssuedRollbackChoice,
  type IssuedRollbackPage,
  type RollbackSelection,
} from './rollbackIssuance';
import { createIssuanceJournal, type PendingIssuance } from './issuanceJournal';
import {
  issuanceRequestFingerprint,
  prepareIssuanceProposal,
  prepareArchiveIssuanceProposal,
  validateIssuanceReceipt,
} from './issuanceProposal';

export interface IssuanceReviewProps {
  api: AdminApi;
  user: AdminUser;
  active: boolean;
  prepared: { preparation: AdminPublicationPreparation; title: string } | null;
  archive?: ArchiveSelection | null;
  rollback?: RollbackSelection | null;
  disabled: boolean;
  onReauthenticate(): void;
  onProtectionChange(protection: { pending: boolean; busy: boolean }): void;
  onIssued?(): void;
}

type ReviewSource =
  | { kind: 'publish'; prepared: NonNullable<IssuanceReviewProps['prepared']> }
  | { kind: 'rollback'; selection: RollbackSelection; choice: IssuedRollbackChoice }
  | { kind: 'archive'; selection: ArchiveSelection; reason: string };

function sameSelection(source: ReviewSource, props: IssuanceReviewProps, reason: string) {
  return source.kind === 'rollback'
    ? source.selection === props.rollback && !props.archive
    : source.kind === 'archive'
      ? source.selection === props.archive && source.reason === reason
      : !props.archive && !props.rollback && source.prepared === props.prepared;
}

/** One shell-owned journal survives editor navigation and reload. Never activates content. */
export function IssuanceReview(props: IssuanceReviewProps) {
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState<PendingIssuance | null>(null);
  const [review, setReview] = useState<{
    reference: PendingIssuance;
    source: ReviewSource;
    sessionGeneration: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [storageFailure, setStorageFailure] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);
  const [receipt, setReceipt] = useState<AdminPublicationIssueReceipt | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [resolveReview, setResolveReview] = useState(false);
  const [archiveReason, setArchiveReason] = useState('');
  const [rollbackPage, setRollbackPage] = useState<IssuedRollbackPage | null>(null);
  const [rollbackStarted, setRollbackStarted] = useState(false);
  const rollbackScope = useRef<{
    selection: RollbackSelection;
    api: AdminApi;
    sessionGeneration: number;
  } | null>(null);
  const journal = useRef<ReturnType<typeof createIssuanceJournal> | null>(null);
  const running = useRef(false);
  const mounted = useRef(false);
  const epoch = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPrepared = useRef(props.prepared);
  const previousArchive = useRef(props.archive);
  const latest = useRef({
    props,
    review,
    pending,
    ready,
    archiveReason,
    rollbackPage,
    rollbackStarted,
  });
  latest.current = { props, review, pending, ready, archiveReason, rollbackPage, rollbackStarted };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, []);
  useEffect(() => {
    epoch.current++;
    setReview(null);
    setReceipt(null);
    setFailure(null);
    setResolveReview(false);
  }, [props.api, props.user.userId, props.active]);
  useEffect(() => {
    if (props.user.role !== 'administrator') return;
    let current = true;
    setReady(false);
    void (async () => {
      try {
        journal.current = createIssuanceJournal(sessionStorage);
        const retained = await journal.current.read();
        if (current) {
          setPending(retained);
          setStorageFailure(null);
          setReady(true);
        }
      } catch {
        if (current)
          setStorageFailure(
            'Release recovery storage is unavailable or unreadable. Issuance is blocked; existing records have not been reset.',
          );
      }
    })();
    return () => {
      current = false;
    };
  }, [props.user.userId, props.user.role, props.active]);
  useEffect(() => {
    latest.current.props.onProtectionChange({ pending: !!pending || !!storageFailure, busy });
  }, [pending, storageFailure, busy]);
  useEffect(() => {
    if (review) heading.current?.focus();
  }, [review]);
  useEffect(() => {
    const arrived = previousPrepared.current !== props.prepared;
    previousPrepared.current = props.prepared;
    if (
      arrived &&
      props.prepared &&
      props.active &&
      props.user.role === 'administrator' &&
      !pending
    ) {
      // Preparation happens below the editor. Default focus scrolling reveals its
      // next explicit action without fetching a release or starting issuance.
      heading.current?.focus();
    }
  }, [props.prepared, props.active, props.user.role, pending]);
  useEffect(() => {
    const arrived = previousArchive.current !== props.archive;
    previousArchive.current = props.archive;
    if (arrived) {
      setArchiveReason('');
      setReview(null);
      setNotConfigured(false);
      if (props.archive && props.active && props.user.role === 'administrator' && !pending)
        heading.current?.focus();
    }
  }, [props.archive, props.active, props.user.role, pending]);
  useEffect(() => {
    rollbackScope.current = null;
    setRollbackPage(null);
    setRollbackStarted(false);
    setReview(null);
    setFailure(null);
    if (props.rollback && props.active && props.user.role === 'administrator' && !pending)
      heading.current?.focus();
  }, [
    props.rollback,
    props.api,
    props.api.sessionGeneration,
    props.active,
    props.user.userId,
    props.user.role,
  ]);
  const eligible = (recovery = false) => {
    const current = latest.current;
    return (
      mounted.current &&
      current.props.active &&
      current.props.user.role === 'administrator' &&
      (!current.props.disabled || recovery) &&
      current.ready &&
      !running.current
    );
  };
  function start() {
    running.current = true;
    setBusy(true);
    setFailure(null);
    const identity = {
      api: props.api,
      actorId: props.user.userId,
      epoch: epoch.current,
      sessionGeneration: props.api.sessionGeneration,
    };
    return () =>
      mounted.current &&
      latest.current.props.active &&
      latest.current.props.user.role === 'administrator' &&
      latest.current.props.user.userId === identity.actorId &&
      latest.current.props.api === identity.api &&
      epoch.current === identity.epoch &&
      identity.api.sessionGeneration === identity.sessionGeneration;
  }
  function finish() {
    running.current = false;
    if (mounted.current) setBusy(false);
  }
  function rollbackPageCurrent() {
    const scope = rollbackScope.current;
    return (
      !!scope &&
      scope.selection === props.rollback &&
      scope.api === props.api &&
      scope.sessionGeneration === props.api.sessionGeneration
    );
  }
  async function earlier() {
    const selection = props.rollback;
    const page = rollbackPage;
    if (
      !eligible() ||
      latest.current.pending ||
      !selection ||
      latest.current.props.rollback !== selection ||
      latest.current.rollbackPage !== page ||
      (rollbackStarted && !rollbackPageCurrent()) ||
      (rollbackStarted && !page?.previous)
    )
      return;
    const current = start();
    const valid = () =>
      current() &&
      latest.current.props.rollback === selection &&
      latest.current.rollbackPage === page;
    latest.current.review = null;
    setReview(null);
    setReceipt(null);
    try {
      const state = await rollbackReleaseState(
        await props.api.publicationReleaseState(),
        selection,
      );
      if (!valid()) return;
      const expected = rollbackStarted ? page!.previous : state.manifest!.previous;
      if (!expected) {
        rollbackScope.current = {
          selection,
          api: props.api,
          sessionGeneration: props.api.sessionGeneration,
        };
        setRollbackStarted(true);
        return;
      }
      const result = await readIssuedRollbackPage(
        await props.api.issuedPublicationPackage(expected.releaseId),
        expected,
        selection,
      );
      if (!valid()) return;
      // An independent administrator may issue while the historical package is in flight.
      await rollbackReleaseState(await props.api.publicationReleaseState(), selection);
      if (!valid()) return;
      rollbackScope.current = {
        selection,
        api: props.api,
        sessionGeneration: props.api.sessionGeneration,
      };
      setRollbackPage(result);
      setRollbackStarted(true);
    } catch (error) {
      if (valid()) setFailure(error);
    } finally {
      finish();
    }
  }
  async function prepare() {
    if (props.rollback && !rollbackPageCurrent()) return;
    if (
      !eligible() ||
      latest.current.pending ||
      ((!props.archive || latest.current.props.archive !== props.archive) &&
        (!props.rollback ||
          latest.current.props.rollback !== props.rollback ||
          !rollbackPage?.choice ||
          latest.current.rollbackPage !== rollbackPage) &&
        (!props.prepared || latest.current.props.prepared !== props.prepared))
    )
      return;
    const source: ReviewSource = props.archive
      ? { kind: 'archive', selection: props.archive, reason: archiveReason }
      : props.rollback && rollbackPage?.choice
        ? { kind: 'rollback', selection: props.rollback, choice: rollbackPage.choice }
        : { kind: 'publish', prepared: props.prepared! };
    if (!sameSelection(source, latest.current.props, latest.current.archiveReason)) return;
    const current = start();
    setReview(null);
    setReceipt(null);
    setCancelled(false);
    try {
      const state = await props.api.publicationReleaseState();
      if (!current() || !sameSelection(source, latest.current.props, latest.current.archiveReason))
        return;
      if (state.status === 'not_configured') {
        setNotConfigured(true);
        return;
      }
      const operationId = crypto.randomUUID();
      const request =
        source.kind === 'archive'
          ? await prepareArchiveIssuanceProposal(
              state,
              source.selection,
              source.reason,
              operationId,
            )
          : source.kind === 'rollback'
            ? await prepareRollbackIssuanceProposal(state, source.choice, operationId)
            : await prepareIssuanceProposal(state, source.prepared.preparation, operationId);
      const requestFingerprint = await issuanceRequestFingerprint(request);
      if (current() && sameSelection(source, latest.current.props, latest.current.archiveReason)) {
        setNotConfigured(false);
        setReview({
          source,
          sessionGeneration: props.api.sessionGeneration,
          reference: {
            version: 1,
            actorId: props.user.userId,
            recipeTitle: source.kind === 'publish' ? source.prepared.title : source.selection.title,
            request,
            requestFingerprint,
          },
        });
      }
    } catch (error) {
      if (current()) setFailure(error);
    } finally {
      finish();
    }
  }
  async function accept(raw: unknown, reference: PendingIssuance, current: () => boolean) {
    const checked = await validateIssuanceReceipt(
      raw,
      reference.actorId,
      reference.request,
      reference.requestFingerprint,
    );
    if (!current()) return;
    // Only a validated exact receipt, or durable cancellation below, may release the journal.
    await journal.current!.forget(reference);
    if (!current()) return;
    setPending(null);
    setReview(null);
    setReceipt(checked);
    setResolveReview(false);
    latest.current.props.onIssued?.();
  }
  async function dispatch(reference: PendingIssuance, mode: 'issue' | 'recover' | 'resolve') {
    if (
      !eligible(!!latest.current.pending) ||
      reference.actorId !== latest.current.props.user.userId
    )
      return;
    if (mode === 'issue' && !latest.current.pending) {
      if (
        latest.current.review?.reference !== reference ||
        !sameSelection(
          latest.current.review.source,
          latest.current.props,
          latest.current.archiveReason,
        ) ||
        latest.current.review.sessionGeneration !== props.api.sessionGeneration
      )
        return;
    } else if (latest.current.pending !== reference) return;
    const current = start();
    try {
      // Save and read back the complete detached request before any write or retry.
      let retained: PendingIssuance;
      try {
        retained = await journal.current!.remember(reference);
      } catch (storageError) {
        // A write can have persisted even when read-back failed. Surface its exact record
        // before allowing another operation; unreadable storage remains fail-closed.
        try {
          const recovered = await journal.current!.read();
          if (mounted.current) {
            setPending(recovered);
            setStorageFailure(null);
          }
        } catch {
          if (mounted.current) {
            setReady(false);
            setStorageFailure(
              'The release recovery record could not be confirmed. Issuance is blocked. Reload to recover the retained record when storage is available; do not reset browser data.',
            );
          }
        }
        throw storageError;
      }
      if (mounted.current) setPending(retained);
      if (!current()) return;
      setReview(null);
      if (mode === 'resolve') {
        const resolution = await props.api.resolvePublicationRelease(
          retained.request.operationId,
          retained.requestFingerprint,
        );
        if (!current()) return;
        if (resolution.status === 'committed') await accept(resolution.receipt, retained, current);
        else if (
          resolution.status === 'cancelled' &&
          Object.keys(resolution).length === 4 &&
          resolution.actorId === retained.actorId &&
          resolution.operationId === retained.request.operationId &&
          resolution.requestFingerprint === retained.requestFingerprint
        ) {
          await journal.current!.forget(retained);
          if (!current()) return;
          setPending(null);
          setResolveReview(false);
          setCancelled(true);
        } else
          throw new ApiError(
            0,
            'issuance_receipt_mismatch',
            'The resolution does not match this exact release request. Its recovery record is kept.',
          );
      } else {
        const result = await (mode === 'issue'
          ? props.api.issuePublicationRelease(retained.request)
          : props.api.publicationReleaseOperation(
              retained.request.operationId,
              retained.requestFingerprint,
            ));
        if (current()) await accept(result, retained, current);
      }
    } catch (error) {
      if (current())
        setFailure(
          error instanceof Error && !(error instanceof ApiError)
            ? new ApiError(0, 'issuance_storage', error.message)
            : error,
        );
    } finally {
      finish();
    }
  }
  if (props.user.role !== 'administrator') return null;
  const recoveryBlocked = !props.active || !ready || busy;
  const blocked = props.disabled || recoveryBlocked;
  const visibleReview =
    review &&
    sameSelection(review.source, props, archiveReason) &&
    review.sessionGeneration === props.api.sessionGeneration
      ? review
      : null;
  if (
    ready &&
    !props.prepared &&
    !props.archive &&
    !props.rollback &&
    !pending &&
    !failure &&
    !storageFailure &&
    !receipt &&
    !cancelled
  )
    return null;
  return (
    <section className="panel" aria-label="Signed release issuance" aria-busy={busy}>
      <p className="eyebrow">PRIVATE RELEASE REVIEW</p>
      <h2 ref={heading} tabIndex={-1}>
        {props.archive && !pending
          ? 'Archive a published recipe'
          : props.rollback && !pending
            ? 'Roll back to an issued recipe version'
            : 'Issue a signed recipe release'}
      </h2>
      <p className="small muted">
        A signed release is retained on this server. CookMate devices must separately verify and
        adopt it; issuance does not change the app.
      </p>
      {storageFailure && <Notice tone="error">{storageFailure}</Notice>}
      {!ready && !storageFailure && <p role="status">Checking release recovery…</p>}
      {failure !== null && (
        <Notice tone="error">
          {failure instanceof Error && !(failure instanceof ApiError)
            ? failure.message
            : errorMessage(failure)}
          {failure instanceof ApiError &&
            ['reauth_required', 'session_required', 'unauthorized'].includes(failure.code) && (
              <button
                className="text-button"
                disabled={busy || !props.active}
                onClick={props.onReauthenticate}
              >
                Confirm identity to continue
              </button>
            )}
        </Notice>
      )}
      {pending ? (
        <Notice title="A release request needs confirmation">
          <p>{pending.recipeTitle}</p>
          <p className="small">
            This tab retains the exact cumulative request. A missing receipt does not mean it
            failed. No new release can start until this one is resolved.
          </p>
          <code>{pending.request.operationId}</code>
          {pending.actorId !== props.user.userId ? (
            <p>Sign in as the administrator who started this request to recover it.</p>
          ) : (
            <>
              <div className="inline-actions">
                <button
                  className="secondary"
                  disabled={recoveryBlocked}
                  onClick={() => void dispatch(pending, 'recover')}
                >
                  Check release receipt
                </button>
                <button
                  className="text-button"
                  disabled={recoveryBlocked}
                  onClick={() => void dispatch(pending, 'issue')}
                >
                  Retry exact release request
                </button>
                <button
                  className="text-button"
                  disabled={recoveryBlocked}
                  onClick={() => {
                    if (eligible(true)) setResolveReview(true);
                  }}
                >
                  Resolve unconfirmed release
                </button>
              </div>
              {resolveReview && (
                <div>
                  <p>
                    If already issued, recover its receipt. Otherwise, ask the server to cancel this
                    exact operation so a late request cannot issue it. This does not remove any
                    issued release.
                  </p>
                  <button
                    className="secondary"
                    disabled={recoveryBlocked}
                    onClick={() => void dispatch(pending, 'resolve')}
                  >
                    Confirm release resolution
                  </button>
                  <button
                    className="text-button"
                    disabled={recoveryBlocked}
                    onClick={() => setResolveReview(false)}
                  >
                    Keep recovery record
                  </button>
                </div>
              )}
            </>
          )}
        </Notice>
      ) : visibleReview ? (
        <div>
          {visibleReview.source.kind === 'archive' ? (
            <>
              <ArchiveVersionDetails selection={visibleReview.source.selection} />
              <p>
                <strong>Reason:</strong> {visibleReview.source.reason}
              </p>
            </>
          ) : visibleReview.source.kind === 'rollback' ? (
            <>
              <h3>{visibleReview.reference.recipeTitle}</h3>
              <p>
                Make the exact version from signed release{' '}
                {visibleReview.source.choice.sourceHead.sequence} current in a new release.
              </p>
              <p className="small">
                Issued version:{' '}
                <code style={{ overflowWrap: 'anywhere' }}>
                  {visibleReview.source.choice.entry.ref.revisionId}
                </code>
              </p>
              <p className="small">
                The complete previously issued publication, including its retained permissions and
                any reviewed translations, is reused unchanged. Saved drafts, rights reviews and
                approvals are not restored or replaced.
              </p>
            </>
          ) : (
            <>
              <h3>{visibleReview.reference.recipeTitle}</h3>
              <p>
                Use prepared draft revision{' '}
                {visibleReview.source.prepared.preparation.draftRevision} as the current version of
                this recipe.
              </p>
              <p className="small">
                {visibleReview.source.prepared.preparation.translations?.length
                  ? `Reviewed translations included: ${visibleReview.source.prepared.preparation.translations.map((item) => `${item.targetLanguage} · translation revision ${item.translationRevision}`).join(', ')}. Original text and quantities remain unchanged.`
                  : 'Original text only. No translations are included in this package.'}
              </p>
            </>
          )}
          <p className="small">
            Release sequence {(visibleReview.reference.request.expectedHead?.sequence ?? 0) + 1}.
            Cumulative membership: {visibleReview.reference.request.entries.length} recipe entries.
            All other current, archived and withdrawn entries are preserved.
          </p>
          <div className="inline-actions">
            <button
              className="primary"
              disabled={blocked}
              onClick={() => void dispatch(visibleReview.reference, 'issue')}
            >
              Issue signed release
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => {
                if (eligible()) setReview(null);
              }}
            >
              Cancel release review
            </button>
          </div>
        </div>
      ) : (
        <>
          {props.archive ? (
            <>
              <ArchiveReleaseFields
                selection={props.archive}
                reason={archiveReason}
                disabled={blocked}
                onReasonChange={(reason) => {
                  if (eligible() && latest.current.props.archive === props.archive) {
                    latest.current.archiveReason = reason;
                    latest.current.review = null;
                    setArchiveReason(reason);
                    setReview(null);
                  }
                }}
              />
              <button
                className="secondary"
                disabled={blocked || !archiveReason.trim()}
                onClick={() => void prepare()}
              >
                {busy ? 'Checking release…' : 'Review archive release'}
              </button>
            </>
          ) : props.rollback ? (
            <RollbackReleaseFields
              selection={props.rollback}
              page={rollbackPageCurrent() ? rollbackPage : null}
              started={rollbackPageCurrent() ? rollbackStarted : false}
              disabled={blocked}
              onEarlier={() => void earlier()}
              onReview={() => void prepare()}
            />
          ) : props.prepared ? (
            <>
              <p>
                Prepared: <strong>{props.prepared.title}</strong> · draft revision{' '}
                {props.prepared.preparation.draftRevision}
              </p>
              <button className="secondary" disabled={blocked} onClick={() => void prepare()}>
                {busy ? 'Checking release…' : 'Review signed release'}
              </button>
            </>
          ) : (
            <p className="small muted">
              Prepare an approved saved recipe to review a new release. Retained requests can be
              recovered here after reload.
            </p>
          )}
          {notConfigured && (
            <Notice title="Issuance is not configured">
              Private signing and release storage must be configured by the workspace operator.
              Prepared packages remain unchanged.
            </Notice>
          )}
        </>
      )}
      {receipt && (
        <Notice title="Signed release issued · Not activated" tone="success">
          <p>
            Release {receipt.envelope.manifest.sequence} is retained. No device adoption is
            confirmed.
          </p>
        </Notice>
      )}
      {cancelled && (
        <Notice title="Release request cancelled">
          The server confirmed cancellation of that exact operation. Review the current release
          before starting another request.
        </Notice>
      )}
    </section>
  );
}
