import { useEffect, useRef, useState } from 'react';
import type { AdminDraft, AdminDraftInput, AdminUser } from '../src/contracts';
import type {
  AdminTranslation,
  AdminTranslationOriginal,
  AdminTranslationSummary,
} from '../src/translations/contracts';
import { AdminApi, errorMessage } from './api';
import { Field, Notice, formatTime } from './components';
import {
  admitTranslationForm,
  admitTranslationLanguages,
  emptyTranslationForm,
  translationStatus,
  type TranslationForm,
} from './translationForm';
import type { TranslationOperations } from './useTranslationOperations';

function Original({ input, language }: { input: AdminDraftInput; language: string }) {
  return (
    <div className="translation-original original-text" lang={language || undefined} dir="auto">
      <h3>{input.title}</h3>
      {input.description && <p>{input.description}</p>}
      <p>
        {input.category} · {input.cuisine}
      </p>
      {input.rawTags && <p>{input.rawTags}</p>}
      <h4>Original ingredients and quantities</h4>
      <ol>
        {input.ingredients.map((row, index) => (
          <li key={index}>
            {row.rawName} — {row.rawMeasure ?? 'Quantity not supplied'}
          </li>
        ))}
      </ol>
      <h4>Original instructions</h4>
      {input.instructions.map((row, index) => (
        <div key={index}>
          <span className="small muted">
            {row.presentation} {index + 1}
          </span>
          <p>{row.rawText}</p>
        </div>
      ))}
      <h4>Original sources and media</h4>
      <p>Photo reference: {input.photoAssetId ?? 'Original source photo or none; unchanged'}</p>
      {[input.recipePage, input.originalSourceUrl, input.videoUrl]
        .filter((value) => value !== null)
        .map((value, index) => (
          <p key={index}>{value}</p>
        ))}
      {input.credits.map((credit, index) => (
        <p key={index}>
          {credit.label}
          {credit.url ? ` · ${credit.url}` : ''}
        </p>
      ))}
    </div>
  );
}
type Selection = { record: AdminTranslation; original: AdminTranslationOriginal };
type Editing = {
  kind: 'create' | 'save' | 'rebase';
  input: TranslationForm;
  source: AdminDraftInput;
  sourceRevision: number;
  originalLanguage: string;
  targetLanguage: string;
  record: AdminTranslation | null;
};

export function TranslationPanel(props: {
  api: AdminApi;
  draft: AdminDraft;
  user: AdminUser;
  operations: TranslationOperations;
  blocked: boolean;
  recipeDirty: boolean;
  onDirty(value: boolean): void;
}) {
  const { api, draft, user, operations, blocked, recipeDirty, onDirty } = props;
  const [items, setItems] = useState<AdminTranslationSummary[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [decision, setDecision] = useState<'approved' | 'changes_requested'>('changes_requested');
  const [note, setNote] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [history, setHistory] = useState<AdminTranslationSummary[] | null>(null);
  const [historical, setHistorical] = useState<Selection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(false),
    flight = useRef(0);
  const activeReview = useRef<symbol | null>(null);
  const latestReview = useRef({ decision, note, acknowledged });
  latestReview.current = { decision, note, acknowledged };
  const latest = useRef(props);
  latest.current = props;
  const currentEditing = useRef(editing);
  currentEditing.current = editing;
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const generation = api.sessionGeneration;
  const scope = useRef({ api, draft, userId: user.userId, role: user.role, generation, epoch: 0 });
  if (
    scope.current.api !== api ||
    scope.current.draft !== draft ||
    scope.current.userId !== user.userId ||
    scope.current.role !== user.role ||
    scope.current.generation !== generation
  ) {
    activeReview.current = null;
    scope.current = {
      api,
      draft,
      userId: user.userId,
      role: user.role,
      generation,
      epoch: scope.current.epoch + 1,
    };
  }
  const reviewInstance = activeReview.current;
  const epoch = scope.current.epoch;
  const current = () =>
    live.current && scope.current.epoch === epoch && api.sessionGeneration === generation;
  const writable = () =>
    current() &&
    !latest.current.blocked &&
    !latest.current.recipeDirty &&
    !latest.current.operations.blocked;
  const canReview = user.role !== 'editor';
  const disabled = blocked || recipeDirty || operations.blocked || busy;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      flight.current++;
    };
  }, []);
  useEffect(() => {
    onDirty(!!editing || reviewing);
    return () => onDirty(false);
  }, [editing, reviewing, onDirty]);
  async function loadList() {
    if (!current()) return;
    const ticket = ++flight.current;
    setBusy(true);
    setError(null);
    try {
      const result = await api.translations(draft.draftId);
      if (current() && flight.current === ticket) {
        setItems(result.items);
        // A refreshed summary does not attest a previously opened detail/review snapshot.
        setSelection(null);
        setHistory(null);
        setHistorical(null);
      }
    } catch (cause) {
      if (current() && flight.current === ticket) setError(errorMessage(cause));
    } finally {
      if (current() && flight.current === ticket) setBusy(false);
    }
  }
  useEffect(() => {
    // Unsaved text belongs to this owner/source, not to a session generation.
    setEditing(null);
  }, [draft.draftId, draft.revision, user.userId]);
  useEffect(() => {
    activeReview.current = null;
    setSelection(null);
    setReviewing(false);
    setHistory(null);
    setHistorical(null);
    void loadList();
  }, [api, draft, user.userId, user.role, generation]);
  async function readSelection(id: string, version?: number): Promise<Selection> {
    const record = await api.translation(id, version);
    if (!current()) throw new Error('Session changed');
    if (
      record.translationId !== id ||
      record.source.draftId !== draft.draftId ||
      record.source.recipeId !== draft.recipeId ||
      (version !== undefined && record.revision !== version)
    )
      throw new Error('Translation source mismatch');
    const original = await api.translationOriginal(id, record.revision);
    if (
      original.source.draftId !== record.source.draftId ||
      original.source.revision !== record.source.revision ||
      original.source.recipeId !== record.source.recipeId ||
      original.source.inputFingerprint !== record.source.inputFingerprint ||
      original.originalLanguage !== record.originalLanguage
    )
      throw new Error('Original revision mismatch');
    return { record, original };
  }
  async function select(id: string, version?: number) {
    if (!current() || editing || reviewing || operations.blocked || busy) return;
    const ticket = ++flight.current;
    setBusy(true);
    setError(null);
    try {
      const result = await readSelection(id, version);
      if (!current() || flight.current !== ticket) return;
      if (version === undefined) {
        setSelection(result);
        setHistory(null);
        setHistorical(null);
      } else setHistorical(result);
    } catch (cause) {
      if (current() && flight.current === ticket) setError(errorMessage(cause));
    } finally {
      if (current() && flight.current === ticket) setBusy(false);
    }
  }
  useEffect(() => {
    const result = operations.lastCommit;
    if (!result || result.translation.source.draftId !== draft.draftId || !current()) return;
    const ticket = ++flight.current;
    setBusy(true);
    setError(null);
    void readSelection(result.translation.translationId)
      .then((next) => {
        if (!current() || flight.current !== ticket) return;
        activeReview.current = null;
        setSelection(next);
        setEditing(null);
        setReviewing(false);
        setHistory(null);
        setHistorical(null);
        setItems((previous) => {
          const { input: _input, ...summary } = next.record;
          return [
            ...previous.filter((item) => item.translationId !== summary.translationId),
            summary,
          ];
        });
      })
      .catch((cause: unknown) => {
        if (current() && flight.current === ticket) setError(errorMessage(cause));
      })
      .finally(() => {
        if (current() && flight.current === ticket) setBusy(false);
      });
  }, [operations.lastCommit]);
  function start(kind: Editing['kind']) {
    if (!writable() || busy || editing || reviewing) return;
    const record = selection?.record ?? null;
    if (kind !== 'create' && !record) return;
    if (kind === 'rebase' && record!.source.revision === draft.revision) return;
    const source = kind === 'save' ? selection!.original.input : draft.input;
    setEditing({
      kind,
      record,
      source,
      sourceRevision: kind === 'save' ? record!.source.revision : draft.revision,
      originalLanguage: kind === 'create' ? '' : record!.originalLanguage,
      targetLanguage: kind === 'create' ? '' : record!.targetLanguage,
      input: kind === 'save' ? structuredClone(record!.input) : emptyTranslationForm(source),
    });
    setError(null);
  }
  function change<Key extends keyof TranslationForm>(key: Key, value: TranslationForm[Key]) {
    if (!writable() || !editing || currentEditing.current !== editing) return;
    setEditing({ ...editing, input: { ...editing.input, [key]: value } });
  }
  function save() {
    if (!writable() || !editing || currentEditing.current !== editing) return;
    try {
      admitTranslationLanguages(editing.originalLanguage, editing.targetLanguage);
      const input = admitTranslationForm(editing.input);
      setError(null);
      const base = { draftId: draft.draftId, sourceRevision: editing.sourceRevision };
      void operations.run(
        editing.kind === 'create'
          ? {
              ...base,
              kind: 'create',
              originalLanguage: editing.originalLanguage,
              targetLanguage: editing.targetLanguage,
              input,
            }
          : {
              ...base,
              kind: editing.kind,
              id: editing.record!.translationId,
              expectedRevision: editing.record!.revision,
              input,
            },
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the translated fields.');
    }
  }
  const selected = selection?.record;
  const shown = historical ?? selection;
  return (
    <section className="translation-panel" aria-label="Recipe translations">
      <div className="section-heading">
        <div>
          <h2>Translations, linked to their original.</h2>
          <p className="muted">
            Saved editorial drafts. Translations are not included in signed releases or shown in the
            app yet.
          </p>
        </div>
        <button
          className="secondary"
          disabled={disabled || !!editing || reviewing}
          onClick={() => start('create')}
        >
          New translation
        </button>
      </div>
      <p className="small">
        Declare the original and target language. Original quantities, row order, headings, media
        and source credits stay unchanged. Machine text does not become human-reviewed by being
        saved.
      </p>
      {recipeDirty && <Notice>Save or discard recipe edits before working on translations.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {busy && <p role="status">Reading exact translation revisions…</p>}
      <div className="inline-actions">
        <button
          className="text-button"
          disabled={disabled || !!editing || reviewing}
          onClick={() => void loadList()}
        >
          Refresh translations
        </button>
      </div>
      {!busy && !error && items.length === 0 && (
        <p>No translation has been saved for this recipe.</p>
      )}
      <div className="history-list">
        {items.map((item) => (
          <button
            className="history-row"
            key={item.translationId}
            disabled={disabled || !!editing || reviewing}
            onClick={() => void select(item.translationId)}
          >
            <span>
              <strong>
                {item.originalLanguage} → {item.targetLanguage}
              </strong>
              <span>
                Translation revision {item.revision} · source revision {item.source.revision}
              </span>
              <span>{translationStatus(item.effectiveStatus)}</span>
            </span>
          </button>
        ))}
      </div>
      {selected && !editing && (
        <>
          <h3>
            {selected.originalLanguage} → {selected.targetLanguage}
          </h3>
          <p>
            {translationStatus(selected.effectiveStatus)} · translation revision {selected.revision}{' '}
            · exact source revision {selected.source.revision}
          </p>
          <p className="small">
            Source fingerprint <code>{selected.source.inputFingerprint}</code>
          </p>
          {selected.machineAssisted && (
            <Notice>
              Machine input is retained in this translation’s history. Any review below is an
              authenticated operator’s acknowledgement, not independent language-quality
              certification.
            </Notice>
          )}
          {selected.review && (
            <p className="original-text">
              {selected.effectiveStatus === 'stale' ? 'Historical review; no longer current. ' : ''}
              {selected.review.decision === 'approved'
                ? 'Operator acknowledgement'
                : 'Changes requested'}{' '}
              by {selected.review.reviewerId} · {formatTime(selected.review.reviewedAt)}.{' '}
              {selected.review.note}
            </p>
          )}
          {selected.effectiveStatus === 'stale' && (
            <Notice>
              The original is now revision{' '}
              {selected.sourceStatus.kind === 'stale'
                ? selected.sourceStatus.currentRevision
                : draft.revision}
              . Existing text remains linked to revision {selected.source.revision}. Load the latest
              recipe draft before rebasing if this editor is older.
            </Notice>
          )}
          <div className="inline-actions">
            <button
              className="secondary"
              disabled={disabled || reviewing}
              onClick={() => start('save')}
            >
              Edit translated text
            </button>
            {selected.source.revision !== draft.revision && (
              <button
                className="secondary"
                disabled={disabled || reviewing}
                onClick={() => start('rebase')}
              >
                Rebase onto source revision {draft.revision}
              </button>
            )}
            {canReview && (
              <button
                className="secondary"
                disabled={disabled || reviewing || selected.effectiveStatus === 'stale'}
                onClick={() => {
                  if (!writable() || currentSelection.current !== selection || activeReview.current)
                    return;
                  activeReview.current = Symbol('translation review');
                  setHistorical(null);
                  setReviewing(true);
                  setDecision('changes_requested');
                  setNote('');
                  setAcknowledged(false);
                }}
              >
                Review saved translation
              </button>
            )}
            <button
              className="text-button"
              disabled={disabled || reviewing}
              onClick={() => {
                if (!current()) return;
                const ticket = ++flight.current;
                setBusy(true);
                void api
                  .translationHistory(selected.translationId)
                  .then((result) => {
                    if (current() && ticket === flight.current) setHistory(result.items);
                  })
                  .catch((cause: unknown) => {
                    if (current() && ticket === flight.current) setError(errorMessage(cause));
                  })
                  .finally(() => {
                    if (current() && ticket === flight.current) setBusy(false);
                  });
              }}
            >
              Translation history
            </button>
          </div>
          {!canReview && (
            <p className="small muted">
              A reviewer or administrator must record translation review.
            </p>
          )}
        </>
      )}
      {history && !editing && (
        <div className="history-list" aria-label="Translation revision history">
          <p>Up to 100 recent translation revisions; every entry retains its exact original.</p>
          {history.map((item) => (
            <button
              className="history-row"
              key={item.revision}
              disabled={disabled || reviewing}
              onClick={() => void select(item.translationId, item.revision)}
            >
              Translation revision {item.revision} · source {item.source.revision} ·{' '}
              {translationStatus(item.effectiveStatus)}
            </button>
          ))}
        </div>
      )}
      {shown && !editing && (
        <div className="translation-saved">
          {historical && (
            <p className="small">
              Inspecting historical translation revision {historical.record.revision}. Editing
              actions above apply to the current saved translation.
            </p>
          )}
          <details>
            <summary>View original · source revision {shown.record.source.revision}</summary>
            <Original input={shown.original.input} language={shown.original.originalLanguage} />
          </details>
          <div lang={shown.record.targetLanguage} dir="auto" className="original-text">
            <h3>{shown.record.input.title || 'Untitled translation draft'}</h3>
            {shown.record.input.description && <p>{shown.record.input.description}</p>}
            <p>
              {shown.record.input.category} · {shown.record.input.cuisine}
            </p>
            {shown.record.input.rawTags && <p>{shown.record.input.rawTags}</p>}
            <ol>
              {shown.record.input.ingredients.map((row, index) => (
                <li key={index}>
                  {row.rawName || 'Translation pending'} —{' '}
                  {shown.original.input.ingredients[index]?.rawMeasure ?? 'Quantity not supplied'}
                </li>
              ))}
            </ol>
            {shown.record.input.instructions.map((row, index) => (
              <div key={index}>
                <span className="small muted">
                  {shown.original.input.instructions[index]?.presentation} {index + 1}
                </span>
                <p>{row.rawText || 'Translation pending'}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && (
        <form
          aria-label="Translation editing"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <h3>
            {editing.kind === 'rebase'
              ? 'Rebase translation'
              : editing.kind === 'create'
                ? 'New translation draft'
                : 'Edit saved translation'}
          </h3>
          <p>
            Exact source revision {editing.sourceRevision}. Saving creates an unreviewed translation
            revision.
          </p>
          {editing.kind === 'rebase' && (
            <Notice>
              Source rows may have changed. Translation fields start empty so old text is not
              silently attached to different ingredients or passages. The previous saved translation
              and its original remain in history. Check and enter each translation deliberately.
            </Notice>
          )}
          <details>
            <summary>View original · source revision {editing.sourceRevision}</summary>
            <Original input={editing.source} language={editing.originalLanguage} />
          </details>
          <fieldset disabled={disabled}>
            <div className="field-pair">
              <Field
                label="Original language"
                hint="Declared by the editor; not inferred from the text."
              >
                <input
                  maxLength={35}
                  placeholder="en"
                  value={editing.originalLanguage}
                  disabled={editing.kind !== 'create'}
                  onChange={(event) => {
                    if (writable() && currentEditing.current === editing)
                      setEditing({ ...editing, originalLanguage: event.target.value });
                  }}
                />
              </Field>
              <Field label="Target language">
                <input
                  maxLength={35}
                  placeholder="ar"
                  value={editing.targetLanguage}
                  disabled={editing.kind !== 'create'}
                  onChange={(event) => {
                    if (writable() && currentEditing.current === editing)
                      setEditing({ ...editing, targetLanguage: event.target.value });
                  }}
                />
              </Field>
            </div>
            <Field label="Translation input attribution">
              <select
                value={editing.input.attribution}
                onChange={(event) =>
                  change('attribution', event.target.value as TranslationForm['attribution'])
                }
              >
                <option value="">Choose attribution</option>
                <option value="human">Human-written input</option>
                <option value="machine">Machine-generated input</option>
                <option value="mixed">Mixed human and machine input</option>
              </select>
            </Field>
            <Field label="Translated title">
              <input
                dir="auto"
                lang={editing.targetLanguage || undefined}
                maxLength={500}
                value={editing.input.title}
                onChange={(event) => change('title', event.target.value)}
              />
            </Field>
            <Field label="Translated description">
              <textarea
                dir="auto"
                maxLength={10000}
                value={editing.input.description ?? ''}
                onChange={(event) => change('description', event.target.value || null)}
              />
            </Field>
            <div className="field-pair">
              {(['category', 'cuisine'] as const).map((key) => (
                <Field key={key} label={`Translated ${key}`}>
                  <input
                    dir="auto"
                    maxLength={200}
                    value={editing.input[key]}
                    onChange={(event) => change(key, event.target.value)}
                  />
                </Field>
              ))}
            </div>
            <Field label="Translated tags">
              <input
                dir="auto"
                maxLength={2000}
                value={editing.input.rawTags ?? ''}
                onChange={(event) => change('rawTags', event.target.value || null)}
              />
            </Field>
            <h4>Ingredient names · original quantities retained</h4>
            {editing.source.ingredients.map((row, index) => (
              <div className="translation-row" key={index}>
                <p className="original-text">
                  {index + 1}. {row.rawName} — {row.rawMeasure ?? 'Quantity not supplied'}
                </p>
                <Field label={`Translated ingredient ${index + 1}`}>
                  <input
                    dir="auto"
                    maxLength={1000}
                    value={editing.input.ingredients[index]!.rawName}
                    onChange={(event) =>
                      change(
                        'ingredients',
                        editing.input.ingredients.map((item, position) =>
                          position === index ? { rawName: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
            ))}
            <h4>Instructions · original order and presentation retained</h4>
            {editing.source.instructions.map((row, index) => (
              <div className="translation-row" key={index}>
                <p className="small muted">
                  Original {row.presentation} {index + 1}
                </p>
                <p className="original-text">{row.rawText}</p>
                <Field label={`Translated ${row.presentation} ${index + 1}`}>
                  <textarea
                    dir="auto"
                    maxLength={20000}
                    rows={row.presentation === 'heading' ? 2 : 5}
                    value={editing.input.instructions[index]!.rawText}
                    onChange={(event) =>
                      change(
                        'instructions',
                        editing.input.instructions.map((item, position) =>
                          position === index ? { rawText: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </Field>
              </div>
            ))}
            <Field label="Translation change summary">
              <textarea
                maxLength={2000}
                value={editing.input.changeSummary}
                onChange={(event) => change('changeSummary', event.target.value)}
              />
            </Field>
            <div className="inline-actions">
              <button className="primary" type="submit">
                {editing.kind === 'rebase'
                  ? 'Save rebased translation draft'
                  : 'Save translation draft'}
              </button>
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  if (!current() || operations.blocked || currentEditing.current !== editing)
                    return;
                  setEditing(null);
                }}
              >
                Discard translation edits
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {reviewing && selected && (
        <form
          aria-label="Translation review"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !writable() ||
              !canReview ||
              !reviewInstance ||
              activeReview.current !== reviewInstance ||
              latestReview.current.decision !== decision ||
              latestReview.current.note !== note ||
              latestReview.current.acknowledged !== acknowledged ||
              currentSelection.current !== selection ||
              selected.effectiveStatus === 'stale' ||
              (decision === 'approved' && !acknowledged)
            )
              return;
            void operations.run({
              kind: 'review',
              draftId: draft.draftId,
              sourceRevision: selected.source.revision,
              id: selected.translationId,
              expectedRevision: selected.revision,
              decision,
              note,
              acknowledgeHumanReview: decision === 'approved' && acknowledged,
            });
          }}
        >
          <h3>Review exact saved translation revision {selected.revision}</h3>
          <p>
            {selected.originalLanguage} → {selected.targetLanguage} · original revision{' '}
            {selected.source.revision}. Read both versions above. Recording review is your operator
            acknowledgement, not independent certification or publication.
          </p>
          <fieldset disabled={disabled}>
            <Field label="Translation review decision">
              <select
                value={decision}
                onChange={(event) => {
                  setDecision(event.target.value as typeof decision);
                  setAcknowledged(false);
                }}
              >
                <option value="changes_requested">Request changes</option>
                <option value="approved">Record operator review</option>
              </select>
            </Field>
            <Field label="Translation review note">
              <textarea
                maxLength={2000}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </Field>
            {decision === 'approved' && (
              <label className="translation-ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I personally compared this exact saved translation with its original, including
                ingredient names, preserved quantities and every passage.
              </label>
            )}
            <div className="inline-actions">
              <button className="primary" disabled={decision === 'approved' && !acknowledged}>
                Record translation review decision
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  if (current() && !operations.blocked) {
                    activeReview.current = null;
                    setReviewing(false);
                  }
                }}
              >
                Cancel translation review
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}
