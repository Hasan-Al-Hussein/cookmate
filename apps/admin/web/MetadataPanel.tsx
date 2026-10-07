import { useEffect, useRef, useState } from 'react';
import type { AdminDraft, AdminMetadataField, AdminUser } from '../src/contracts';
import { AdminApi } from './api';
import { Field, Notice } from './components';
import { MetadataRecords } from './MetadataRecords';
import { metadataForm, metadataInput, metadataLabels, nutritionLabels } from './metadataForm';
import type { useOperations } from './useOperations';

export function MetadataPanel(props: {
  api: AdminApi;
  draft: AdminDraft;
  user: AdminUser;
  operations: ReturnType<typeof useOperations>;
  blocked: boolean;
  recipeDirty: boolean;
  onDirty(dirty: boolean): void;
  onReauthenticate(): void;
}) {
  const { api, draft, user, operations, blocked, recipeDirty, onDirty, onReauthenticate } = props;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => metadataForm(draft.metadata, 'servings'));
  const [error, setError] = useState<string | null>(null);
  const live = useRef(false);
  const activeReview = useRef<symbol | null>(null);
  const reviewInstance = activeReview.current;
  const latest = useRef(props);
  latest.current = props;
  const latestForm = useRef(form);
  latestForm.current = form;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      activeReview.current = null;
    };
  }, []);
  useEffect(() => {
    activeReview.current = null;
    setEditing(false);
    setForm(metadataForm(draft.metadata, 'servings'));
    setError(null);
  }, [draft]);
  useEffect(() => {
    onDirty(editing);
    return () => onDirty(false);
  }, [editing, onDirty]);
  const canReview = user.role === 'reviewer' || user.role === 'administrator';
  const fieldsBlocked = blocked || recipeDirty || !canReview;
  const sessionGeneration = api.sessionGeneration;
  const current = () =>
    live.current &&
    latest.current.api === api &&
    api.sessionGeneration === sessionGeneration &&
    latest.current.draft === draft &&
    latest.current.user.userId === user.userId &&
    latest.current.user.role !== 'editor' &&
    !latest.current.blocked &&
    !latest.current.recipeDirty;
  function discard() {
    if (
      !live.current ||
      !reviewInstance ||
      activeReview.current !== reviewInstance ||
      latest.current.operations.busy ||
      latest.current.operations.pending
    )
      return;
    activeReview.current = null;
    setForm(metadataForm(latest.current.draft.metadata, latestForm.current.field));
    setEditing(false);
    setError(null);
  }
  return (
    <section className="edit-section" id="recipe-metadata" aria-label="Optional reviewed metadata">
      <div className="section-intro">
        <span className="section-number">06</span>
        <div>
          <h2>Optional reviewed details</h2>
          <p>Keep missing information unknown. Record evidence for one saved value at a time.</p>
        </div>
      </div>
      <p className="small muted">
        These are operator-recorded source claims, not independent verification or an allergy-safety
        guarantee. Recipe quantities and instructions stay unchanged.
      </p>
      <MetadataRecords metadata={draft.metadata} />
      {!canReview && (
        <p className="small muted">
          A reviewer or administrator must record optional metadata evidence.
        </p>
      )}
      {recipeDirty && (
        <p className="small">Save recipe edits before reviewing optional metadata.</p>
      )}
      {!editing && canReview && (
        <button
          className="secondary"
          disabled={fieldsBlocked}
          onClick={() => {
            if (!current() || activeReview.current) return;
            activeReview.current = Symbol('metadata review');
            setForm(metadataForm(draft.metadata, latestForm.current.field));
            setEditing(true);
          }}
        >
          Review optional metadata
        </button>
      )}
      {editing && (
        <form
          aria-label="Optional metadata review"
          onSubmit={(event) => {
            event.preventDefault();
            if (
              !current() ||
              !editing ||
              !reviewInstance ||
              activeReview.current !== reviewInstance ||
              latestForm.current !== form
            )
              return;
            try {
              const input = metadataInput(form);
              setError(null);
              void operations.run('metadata', draft.draftId, (operationId) =>
                api.metadata(draft.draftId, operationId, draft.revision, input),
              );
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : 'Check the supplied value and evidence.',
              );
            }
          }}
        >
          <fieldset disabled={fieldsBlocked}>
            <Field label="Detail to review">
              <select
                value={form.field}
                onChange={(event) => {
                  setForm(metadataForm(draft.metadata, event.target.value as AdminMetadataField));
                  setError(null);
                }}
              >
                {Object.entries(metadataLabels).map(([field, label]) => (
                  <option key={field} value={field}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <label>
              <input
                type="checkbox"
                checked={form.unknown}
                onChange={(event) => setForm({ ...form, unknown: event.target.checked })}
              />
              Unknown · no reviewed value
            </label>
            {!form.unknown && (
              <>
                {form.field === 'nutrition' ? (
                  <>
                    <Field label="Nutrition basis">
                      <select
                        value={form.basis}
                        onChange={(event) =>
                          setForm({ ...form, basis: event.target.value as typeof form.basis })
                        }
                      >
                        <option value="per_serving">Per serving</option>
                        <option value="per_recipe">Per recipe</option>
                      </select>
                    </Field>
                    {(Object.keys(nutritionLabels) as (keyof typeof nutritionLabels)[]).map(
                      (key) => (
                        <Field
                          label={nutritionLabels[key]}
                          key={key}
                          hint="Blank means unknown; zero is a recorded value."
                        >
                          <input
                            type="number"
                            min="0"
                            max="1000000"
                            step="any"
                            value={form.nutrition[key]}
                            onChange={(event) =>
                              setForm({
                                ...form,
                                nutrition: { ...form.nutrition, [key]: event.target.value },
                              })
                            }
                          />
                        </Field>
                      ),
                    )}
                  </>
                ) : form.field === 'dietaryTags' ? (
                  <Field label="Dietary tags · one per line">
                    <textarea
                      rows={4}
                      maxLength={2430}
                      value={form.text}
                      onChange={(event) => setForm({ ...form, text: event.target.value })}
                    />
                  </Field>
                ) : (
                  <Field label={form.field === 'servings' ? 'Servings' : 'Minutes'}>
                    <input
                      type="number"
                      min="0"
                      max={form.field === 'servings' ? '1000' : '43200'}
                      step="any"
                      value={form.text}
                      onChange={(event) => setForm({ ...form, text: event.target.value })}
                    />
                  </Field>
                )}
                <Field
                  label="Source evidence"
                  hint="Cite the source and explain the reviewed value. Do not include private credentials."
                >
                  <textarea
                    rows={3}
                    required
                    maxLength={2048}
                    value={form.source}
                    onChange={(event) => setForm({ ...form, source: event.target.value })}
                  />
                </Field>
              </>
            )}
          </fieldset>
          <p className="small">
            Recording this review creates a new draft revision and clears approval. Your identity
            and review time are recorded by the server; recent identity confirmation is required.
          </p>
          {form.field === 'servings' && draft.metadata.nutrition.value?.basis === 'per_serving' && (
            <Notice>
              Changing servings clears the current per-serving nutrition values and their evidence.
              Review nutrition again for the changed servings.
            </Notice>
          )}
          {error && <Notice tone="error">{error}</Notice>}
          {operations.error && <Notice tone="error">{operations.error}</Notice>}
          {operations.errorCode === 'reauth_required' && (
            <button type="button" className="secondary" onClick={onReauthenticate}>
              Confirm identity to continue
            </button>
          )}
          <div className="inline-actions">
            <button type="submit" className="primary" disabled={fieldsBlocked}>
              Record metadata review
            </button>
            <button
              type="button"
              className="text-button"
              disabled={operations.busy || !!operations.pending}
              onClick={discard}
            >
              Discard metadata form
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
