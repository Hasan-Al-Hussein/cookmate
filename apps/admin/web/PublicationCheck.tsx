import { useEffect, useRef, useState } from 'react';
import type {
  AdminDraft,
  AdminPublicationPreparation,
  AdminRetainedPublicationSummary,
} from '../src/contracts';
import { canonicalContentJson } from '@cookmate/catalogue/content';
import { AdminApi, ApiError, errorMessage } from './api';
import { Notice } from './components';
import {
  PublicationTranslations,
  type PublicationTranslationChoice,
} from './PublicationTranslations';

/** Mounted only for one saved, approved revision; never changes publication state. */
export function PublicationCheck({
  api,
  draft,
  disabled,
  onReauthenticate,
  onPrepared,
  onInvalidated,
}: {
  api: AdminApi;
  draft: Pick<AdminDraft, 'draftId' | 'revision'>;
  disabled: boolean;
  onReauthenticate(): void;
  onPrepared?(preparation: AdminPublicationPreparation): void;
  onInvalidated?(): void;
}) {
  const [result, setResult] = useState<AdminPublicationPreparation | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<PublicationTranslationChoice>({
    complete: true,
    selections: [],
    languages: [],
  });
  const [attempt, setAttempt] = useState<PublicationTranslationChoice | null>(null);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const [retained, setRetained] = useState<AdminRetainedPublicationSummary[] | null>(null);
  const active = useRef(false);
  const pending = useRef(false);
  const sessionGeneration = api.sessionGeneration;
  const apiLifetime = useRef({ api, version: 0 });
  if (apiLifetime.current.api !== api)
    apiLifetime.current = { api, version: apiLifetime.current.version + 1 };
  const latest = useRef({
    disabled,
    onPrepared,
    onInvalidated,
    api,
    draft,
    sessionGeneration,
    choice,
  });
  latest.current = { disabled, onPrepared, onInvalidated, api, draft, sessionGeneration, choice };
  useEffect(() => {
    setResult(null);
    setFailure(null);
    setRetained(null);
    setAttempt(null);
    attemptRef.current = null;
    setChoice({ complete: true, selections: [], languages: [] });
  }, [api, draft.draftId, draft.revision, sessionGeneration]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const sameContext = () =>
    latest.current.api === api &&
    latest.current.draft.draftId === draft.draftId &&
    latest.current.draft.revision === draft.revision &&
    latest.current.sessionGeneration === sessionGeneration &&
    api.sessionGeneration === sessionGeneration;
  async function check(recoverOnly = false) {
    if (!active.current || latest.current.disabled || !sameContext() || pending.current) return;
    const selected = attemptRef.current ?? latest.current.choice;
    if (!selected.complete) return;
    const request: PublicationTranslationChoice = JSON.parse(canonicalContentJson(selected));
    latest.current.onInvalidated?.();
    attemptRef.current = request;
    setAttempt(request);
    pending.current = true;
    setBusy(true);
    setResult(null);
    setFailure(null);
    try {
      const response = await (recoverOnly
        ? api.publicationPreparation(draft.draftId, draft.revision, request.selections)
        : api.preparePublication(draft.draftId, draft.revision, request.selections));
      if (
        response.draftId !== draft.draftId ||
        response.draftRevision !== draft.revision ||
        response.status !== 'prepared_not_published' ||
        canonicalContentJson(response.translations ?? []) !==
          canonicalContentJson(request.languages)
      )
        throw new ApiError(
          0,
          'receipt_mismatch',
          'The returned package does not match this saved revision. Recover its receipt before continuing.',
        );
      if (active.current && sameContext()) {
        setResult(response);
        attemptRef.current = null;
        setAttempt(null);
        if (!latest.current.disabled) latest.current.onPrepared?.(response);
      }
    } catch (error) {
      if (active.current && sameContext()) {
        setFailure(error);
        // A rejected lookup cannot cancel an earlier unconfirmed preparation.
        if (!recoverOnly && error instanceof ApiError && !error.uncertain && !attempt) {
          attemptRef.current = null;
          setAttempt(null);
        }
      }
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  async function retainedPackages(selected?: AdminRetainedPublicationSummary) {
    if (
      !active.current ||
      latest.current.disabled ||
      !sameContext() ||
      pending.current ||
      attemptRef.current
    )
      return;
    pending.current = true;
    setBusy(true);
    setFailure(null);
    try {
      if (!selected) {
        const response = await api.retainedPublicationPreparations(draft.draftId);
        if (active.current && sameContext()) setRetained(response.items);
      } else {
        const response = await api.publicationPreparationByOperation(
          draft.draftId,
          selected.operationId,
        );
        if (
          response.operationId !== selected.operationId ||
          response.draftId !== draft.draftId ||
          response.draftRevision !== selected.draftRevision ||
          response.revisionId !== selected.revisionId ||
          canonicalContentJson(response.translations ?? []) !==
            canonicalContentJson(selected.translations)
        )
          throw new ApiError(
            0,
            'receipt_mismatch',
            'The retained package did not match the selected reference.',
          );
        if (active.current && sameContext()) {
          setResult(response);
          if (!latest.current.disabled && selected.draftRevision === draft.revision)
            latest.current.onPrepared?.(response);
        }
      }
    } catch (error) {
      if (active.current && sameContext()) setFailure(error);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return (
    <section aria-label="Publication preparation">
      <PublicationTranslations
        key={`${apiLifetime.current.version}:${draft.draftId}:${draft.revision}:${sessionGeneration}`}
        api={api}
        draft={draft}
        disabled={disabled || busy || !!attempt}
        onChange={(value) => {
          if (
            !active.current ||
            latest.current.disabled ||
            !sameContext() ||
            pending.current ||
            attemptRef.current
          )
            return;
          latest.current.onInvalidated?.();
          setChoice(value);
          setResult(null);
          setFailure(null);
        }}
      />
      <button
        className="secondary"
        disabled={disabled || busy || !choice.complete}
        onClick={() => void check()}
      >
        {busy
          ? 'Checking approved content…'
          : attempt
            ? 'Retry the same preparation'
            : 'Prepare publication package'}
      </button>
      <p className="small muted">
        Checks the saved approval, original evidence and actual photo, then retains one private
        package for this exact recipe and translation selection. Does not publish or change the app.
      </p>
      {failure !== null && (
        <Notice tone="error">
          {errorMessage(failure)}
          {failure instanceof ApiError &&
            (failure.uncertain || failure.code === 'preparation_unknown') && (
              <>
                <p className="small">
                  The outcome is unconfirmed. Recover the saved package, or retry preparation for
                  these same choices; both use the original operation. Translation selections and
                  permission evidence stay fixed until the outcome is confirmed.
                </p>
                <button
                  className="text-button"
                  disabled={disabled || busy}
                  onClick={() => void check(true)}
                >
                  Recover prepared package
                </button>
              </>
            )}
          {failure instanceof ApiError && failure.code === 'reauth_required' && (
            <button className="text-button" onClick={onReauthenticate}>
              Sign in again to check
            </button>
          )}
        </Notice>
      )}
      <button
        className="text-button"
        disabled={disabled || busy || !!attempt}
        onClick={() => void retainedPackages()}
      >
        Find retained packages
      </button>
      {retained?.length === 0 && (
        <p className="small">No retained packages for this recipe and account.</p>
      )}
      {retained?.map((saved) => (
        <div key={saved.operationId}>
          <p className="small">
            Recipe revision {saved.draftRevision} ·{' '}
            {saved.translations.length
              ? saved.translations
                  .map((t) => `${t.targetLanguage} revision ${t.translationRevision}`)
                  .join(', ')
              : 'Original text only'}
          </p>
          <button
            className="text-button"
            disabled={disabled || busy || !!attempt}
            onClick={() => void retainedPackages(saved)}
          >
            Recover package {saved.operationId}
          </button>
        </div>
      ))}
      {result && (
        <Notice title="Package retained privately · Not published">
          <p>
            Checked draft revision {result.draftRevision}. Exact text and measures were retained; no
            missing metadata was filled in.
          </p>
          <p className="small">
            Document: {result.documentBytes.toLocaleString()} bytes. Permission scopes:{' '}
            {result.permissionScopes.map((scope) => scope.replaceAll('_', ' ')).join(', ')}.
          </p>
          <p className="small">
            {result.originalEvidenceRetained
              ? 'Original catalogue evidence is retained.'
              : 'This is an independently authored draft.'}
          </p>
          <p className="small">A signed release and safe client activation are still required.</p>
          {!!result.translations?.length && (
            <p className="small">
              Included reviewed translations:{' '}
              {result.translations
                .map((item) => `${item.targetLanguage} · revision ${item.translationRevision}`)
                .join(', ')}
              . Original quantities are unchanged.
            </p>
          )}
          {result.draftRevision !== draft.revision && (
            <p className="small">
              This is a retained earlier package. It is not approval of the current recipe or
              translations.
            </p>
          )}
          <p className="small">
            Retained {new Date(result.retainedAt).toLocaleString()}. Repeating this action recovers
            the same package.
          </p>
        </Notice>
      )}
    </section>
  );
}
