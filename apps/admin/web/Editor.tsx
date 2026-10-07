import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdminAsset,
  AdminDraft,
  AdminDraftInput,
  AdminHistoryEntry,
  AdminUser,
  AdminPublicationPreparation,
} from '../src/contracts';
import { AdminApi, errorMessage } from './api';
import { Badge, Dialog, Field, Notice, formatTime } from './components';
import { PhotoEditor } from './PhotoEditor';
import { RecipePreview } from './RecipePreview';
import { RevisionComparison } from './RevisionComparison';
import { RecipePreviewPanel } from './RecipePreviewPanel';
import { ReviewRecord } from './ReviewRecord';
import { RightsPanel } from './RightsPanel';
import { MetadataPanel } from './MetadataPanel';
import { recipeMetadataContextChanged } from '../src/drafts/metadataContext';
import { publicationInputIssues } from '../src/publishing/readiness';
import { PublicationCheck } from './PublicationCheck';
import type { useOperations } from './useOperations';
import { TranslationPanel } from './TranslationPanel';
import type { TranslationOperations } from './useTranslationOperations';

type Operations = ReturnType<typeof useOperations>;
const cloneInput = (value: AdminDraftInput): AdminDraftInput =>
  JSON.parse(JSON.stringify(value)) as AdminDraftInput;
function move<Value>(items: Value[], from: number, direction: -1 | 1): Value[] {
  const target = from + direction;
  if (target < 0 || target >= items.length) return items;
  const copy = [...items];
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item!);
  return copy;
}
function RowTools({
  label,
  index,
  count,
  onMove,
  onRemove,
}: {
  label: string;
  index: number;
  count: number;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}) {
  return (
    <div className="row-tools">
      <button
        type="button"
        className="icon-button"
        aria-label={`Move ${label} ${index + 1} up`}
        disabled={index === 0}
        onClick={() => onMove(-1)}
      >
        ↑
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label={`Move ${label} ${index + 1} down`}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      >
        ↓
      </button>
      <button
        type="button"
        className="icon-button remove"
        aria-label={`Remove ${label} ${index + 1}`}
        onClick={onRemove}
      >
        ×
      </button>
    </div>
  );
}
export function Editor({
  api,
  draft,
  user,
  operations,
  translationOperations,
  onDirty,
  onLocalBusy,
  onLoad,
  onBack,
  onReauthenticate,
  onPrepared,
  onPreparationInvalidated,
  externalBlocked = false,
}: {
  api: AdminApi;
  draft: AdminDraft;
  user: AdminUser;
  operations: Operations;
  translationOperations?: TranslationOperations;
  onDirty: (dirty: boolean) => void;
  onLocalBusy: (busy: boolean) => void;
  onLoad: (draft: AdminDraft) => void;
  onBack: () => void;
  onReauthenticate: () => void;
  onPrepared?: (preparation: AdminPublicationPreparation, title: string) => void;
  onPreparationInvalidated?: () => void;
  externalBlocked?: boolean;
}) {
  const [input, setInput] = useState(() => cloneInput(draft.input));
  const [asset, setAsset] = useState<AdminAsset | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [tab, setTab] = useState<'edit' | 'preview' | 'history' | 'translations'>('edit');
  const [history, setHistory] = useState<AdminHistoryEntry[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historical, setHistorical] = useState<AdminDraft | null>(null);
  const [comparing, setComparing] = useState(false);
  const [restoreReview, setRestoreReview] = useState(false);
  const [review, setReview] = useState<'approved' | 'changes_requested' | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reloadReview, setReloadReview] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [reloadBusy, setReloadBusy] = useState(false);
  const [rightsDirty, setRightsDirty] = useState(false);
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [translationDirty, setTranslationDirty] = useState(false);
  const reviewDirty = rightsDirty || metadataDirty || translationDirty;
  const generation = useRef(0);
  const historyLive = useRef(false);
  const historyContext = useRef({ api, draft, userId: user.userId, epoch: 0 });
  if (
    historyContext.current.api !== api ||
    historyContext.current.draft !== draft ||
    historyContext.current.userId !== user.userId
  )
    historyContext.current = {
      api,
      draft,
      userId: user.userId,
      epoch: historyContext.current.epoch + 1,
    };
  const historyEpoch = historyContext.current.epoch;
  const historySessionGeneration = api.sessionGeneration;
  const dirty = JSON.stringify(input) !== JSON.stringify(draft.input);
  const publicationIssues = useMemo(() => publicationInputIssues(input), [input]);
  const blocked = externalBlocked || operations.blocked || uploadBusy || reloadBusy;
  const writesBlocked = blocked || reviewDirty;
  const clearsMetadata =
    Object.values(draft.metadata).some((field) => field.value !== null) &&
    recipeMetadataContextChanged(draft.input, input);
  useEffect(() => {
    setInput(cloneInput(draft.input));
    setAsset(null);
    setRestoreReview(false);
    setReview(null);
    setReloadReview(false);
  }, [draft]);
  useEffect(() => {
    generation.current++;
    setHistorical(null);
    setComparing(false);
    setHistory(null);
    setHistoryBusy(false);
    setHistoryError(null);
  }, [api, draft, user.userId, historySessionGeneration]);
  useEffect(() => {
    onDirty(dirty || reviewDirty);
  }, [dirty, reviewDirty, onDirty]);
  useEffect(() => {
    onLocalBusy(uploadBusy || reloadBusy);
    return () => onLocalBusy(false);
  }, [uploadBusy, reloadBusy, onLocalBusy]);
  useEffect(() => {
    historyLive.current = true;
    return () => {
      historyLive.current = false;
      generation.current++;
    };
  }, []);
  const edit = <Key extends keyof AdminDraftInput>(key: Key, value: AdminDraftInput[Key]) =>
    setInput((current) => ({ ...current, [key]: value }));
  const currentHistoryContext = () =>
    historyLive.current &&
    historyContext.current.epoch === historyEpoch &&
    api.sessionGeneration === historySessionGeneration;
  async function loadHistory() {
    if (!currentHistoryContext()) return;
    setTab('history');
    setHistoryBusy(true);
    setHistoryError(null);
    const own = ++generation.current;
    try {
      const result = await api.history(draft.draftId);
      if (own === generation.current && currentHistoryContext()) setHistory(result.items);
    } catch (failure) {
      if (own === generation.current && currentHistoryContext())
        setHistoryError(errorMessage(failure));
    } finally {
      if (own === generation.current && currentHistoryContext()) setHistoryBusy(false);
    }
  }
  async function inspectRevision(revision: number) {
    if (!currentHistoryContext()) return;
    setHistoryBusy(true);
    setHistoryError(null);
    setHistorical(null);
    setComparing(false);
    const own = ++generation.current;
    try {
      const result = await api.revision(draft.draftId, revision);
      if (own !== generation.current || !currentHistoryContext()) return;
      if (
        result.draftId !== draft.draftId ||
        result.recipeId !== draft.recipeId ||
        result.revision !== revision
      )
        throw new Error('The returned revision does not match the selected saved recipe.');
      setHistorical(result);
    } catch (failure) {
      if (own === generation.current && currentHistoryContext())
        setHistoryError(errorMessage(failure));
    } finally {
      if (own === generation.current && currentHistoryContext()) setHistoryBusy(false);
    }
  }
  async function reload() {
    if (reloadBusy) return;
    setReloadBusy(true);
    setReloadError(null);
    try {
      onLoad(await api.draft(draft.draftId));
    } catch (failure) {
      setReloadError(errorMessage(failure));
    } finally {
      setReloadBusy(false);
    }
  }
  function save() {
    const exact = cloneInput(input);
    void operations.run('save', draft.draftId, (id) =>
      api.save(draft.draftId, id, draft.revision, exact),
    );
  }
  return (
    <>
      <div className="editor-heading">
        <button
          className="text-button"
          onClick={onBack}
          disabled={uploadBusy || operations.blocked}
        >
          ← Recipe library
        </button>
        <p className="small muted">
          Recipe {draft.recipeId} · Revision {draft.revision} ·{' '}
          {dirty ? 'Unsaved edits' : 'Saved draft'}
        </p>
      </div>
      <div className="editor-compact-save" aria-label="Quick draft save">
        <div>
          <strong>{dirty ? 'Unsaved edits' : `Revision ${draft.revision} saved`}</strong>
          <span>Local draft · app catalogue unchanged</span>
        </div>
        <button className="primary" disabled={writesBlocked || !dirty} onClick={save}>
          {operations.busy ? 'Saving…' : 'Save draft'}
        </button>
      </div>
      <div className="section-heading">
        <div>
          <p className="eyebrow">RECIPE STUDIO</p>
          <h1 className="editor-title">{input.title || 'A new recipe'}</h1>
          <p className="muted">
            {draft.basedOn
              ? 'Editing a copy of the app catalogue. Original source evidence is retained.'
              : 'A new recipe draft, ready for your own ingredients and instructions.'}
          </p>
        </div>
        <Badge status={draft.status} />
      </div>
      {dirty && publicationIssues.length > 0 && (
        <Notice title="These edits need attention before publication">
          <p>
            Your edits remain here. No text or quantities have been shortened. Very large drafts may
            also exceed the save limit.
          </p>
          <ul>
            {publicationIssues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </Notice>
      )}
      <nav className="editor-tabs" aria-label="Recipe workspace">
        <button
          disabled={uploadBusy || reviewDirty}
          aria-pressed={tab === 'edit'}
          onClick={() => setTab('edit')}
        >
          Edit recipe
        </button>
        <button
          disabled={uploadBusy || reviewDirty}
          aria-pressed={tab === 'preview'}
          onClick={() => setTab('preview')}
        >
          Preview
        </button>
        <button
          disabled={uploadBusy || reviewDirty}
          aria-pressed={tab === 'history'}
          onClick={() => void loadHistory()}
        >
          Version history
        </button>
        {translationOperations && (
          <button
            disabled={uploadBusy || reviewDirty || dirty || blocked}
            aria-pressed={tab === 'translations'}
            onClick={() => setTab('translations')}
          >
            Translations
          </button>
        )}
      </nav>
      {tab === 'translations' && translationOperations && (
        <TranslationPanel
          api={api}
          draft={draft}
          user={user}
          operations={translationOperations}
          blocked={blocked || rightsDirty || metadataDirty}
          recipeDirty={dirty}
          onDirty={setTranslationDirty}
        />
      )}
      {tab === 'preview' && (
        <RecipePreviewPanel
          unsaved={dirty}
          draft={{ ...draft, input, photoUrl: asset?.photoUrl ?? draft.photoUrl }}
        />
      )}
      {tab === 'history' && (
        <section className="history-panel">
          <div className="section-heading">
            <div>
              <h2>Every saved version, kept.</h2>
              <p className="muted">
                Up to 100 recent revisions. Restoring creates a new draft revision and requires
                fresh review.
              </p>
            </div>
            <button className="secondary" disabled={historyBusy} onClick={() => void loadHistory()}>
              Refresh history
            </button>
          </div>
          <p className="small muted">
            Translation drafts and their exact originals are available in the Translations
            workspace. Their review status is separate from recipe review.
          </p>
          {historyError && <Notice tone="error">{historyError}</Notice>}
          {historyBusy && <p role="status">Reading revision history…</p>}
          <div className="history-list">
            {history?.map((item) => (
              <button
                key={item.revision}
                className="history-row"
                disabled={historyBusy}
                onClick={() => void inspectRevision(item.revision)}
              >
                <span className="revision-number">{item.revision}</span>
                <span>
                  <strong>{item.changeSummary || 'Saved recipe draft'}</strong>
                  <span className="muted">
                    {item.author.username} · {formatTime(item.createdAt)}
                  </span>
                  {item.review && (
                    <span className="history-review">
                      <strong>
                        {item.review.decision === 'changes_requested'
                          ? 'Changes requested'
                          : 'Approval recorded'}
                      </strong>
                      <span className="original-text">
                        {item.review.note || 'No review note supplied.'}
                      </span>
                    </span>
                  )}
                  {!!item.rights?.length && (
                    <span className="small muted">
                      {item.rights.length} permission scope{item.rights.length === 1 ? '' : 's'}{' '}
                      recorded at this revision
                    </span>
                  )}
                </span>
                <Badge status={item.status} />
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
          {historical && (
            <div className="historical-preview">
              <div className="section-heading">
                <h3>Revision {historical.revision}</h3>
                <button
                  className="secondary"
                  disabled={writesBlocked || dirty || historical.revision === draft.revision}
                  onClick={() => setRestoreReview(true)}
                >
                  Restore as a new revision
                </button>
              </div>
              {dirty && (
                <p className="small">
                  Save or deliberately discard your current edits before restoring another revision.
                </p>
              )}
              <button
                className="secondary"
                disabled={historyBusy || historical.revision === draft.revision}
                aria-pressed={comparing}
                onClick={() => setComparing(!comparing)}
              >
                {comparing
                  ? 'Show selected revision preview'
                  : `Compare with saved revision ${draft.revision}`}
              </button>
              {comparing ? (
                <RevisionComparison previous={historical} current={draft} />
              ) : (
                <RecipePreview draft={historical} showMetadata />
              )}
            </div>
          )}
        </section>
      )}
      {tab === 'edit' && (
        <div className="editor-layout">
          <div className="editor-main">
            {rightsDirty && (
              <Notice>
                Finish or discard the open <a href="#recipe-rights">permission review</a> before
                editing this recipe.
              </Notice>
            )}
            {metadataDirty && (
              <Notice>
                Finish or discard the open <a href="#recipe-metadata">metadata review</a> before
                editing this recipe.
              </Notice>
            )}
            <PhotoEditor
              api={api}
              userId={user.userId}
              draft={draft}
              asset={asset}
              blocked={externalBlocked || operations.blocked || reviewDirty}
              onBusy={setUploadBusy}
              onAsset={(next) => {
                setAsset(next);
                edit('photoAssetId', next.assetId);
              }}
            />
            <fieldset disabled={writesBlocked} className="editor-fields">
              <section className="edit-section" id="recipe-details">
                <div className="section-intro">
                  <span className="section-number">01</span>
                  <div>
                    <h2>The recipe</h2>
                    <p>Names, context and a clear introduction.</p>
                  </div>
                </div>
                <Field label="Recipe title">
                  <input
                    value={input.title}
                    maxLength={500}
                    onChange={(event) => edit('title', event.target.value)}
                  />
                </Field>
                <Field
                  label="Description"
                  hint="Your editorial introduction; original instructions stay in their own section."
                >
                  <textarea
                    rows={3}
                    value={input.description ?? ''}
                    maxLength={4000}
                    onChange={(event) => edit('description', event.target.value || null)}
                  />
                </Field>
                <div className="field-pair">
                  <Field label="Category">
                    <input
                      value={input.category}
                      maxLength={128}
                      list="recipe-categories"
                      onChange={(event) => edit('category', event.target.value)}
                    />
                    <datalist id="recipe-categories">
                      {[
                        'Breakfast',
                        'Dessert',
                        'Pasta',
                        'Seafood',
                        'Chicken',
                        'Vegetarian',
                        'Side',
                        'Soup',
                      ].map((value) => (
                        <option key={value} value={value} />
                      ))}
                    </datalist>
                  </Field>
                  <Field label="Cuisine">
                    <input
                      value={input.cuisine}
                      maxLength={128}
                      onChange={(event) => edit('cuisine', event.target.value)}
                    />
                  </Field>
                </div>
                <Field
                  label="Source tags"
                  hint="Keep supplied tags as written. They are not verified dietary or allergy claims."
                >
                  <input
                    value={input.rawTags ?? ''}
                    maxLength={2000}
                    onChange={(event) => edit('rawTags', event.target.value || null)}
                  />
                </Field>
              </section>
              <section className="edit-section" id="recipe-ingredients">
                <div className="section-intro">
                  <span className="section-number">02</span>
                  <div>
                    <h2>Ingredients</h2>
                    <p>
                      Keep exact quantities and their original order. Leave an unknown amount blank.
                    </p>
                  </div>
                </div>
                <div className="ordered-list">
                  {input.ingredients.map((item, index) => (
                    <div className="ingredient-editor" key={index}>
                      <span className="order-number">{index + 1}</span>
                      <Field label={`Ingredient ${index + 1}`}>
                        <input
                          value={item.rawName}
                          maxLength={512}
                          onChange={(event) =>
                            edit(
                              'ingredients',
                              input.ingredients.map((row, position) =>
                                position === index ? { ...row, rawName: event.target.value } : row,
                              ),
                            )
                          }
                        />
                      </Field>
                      <Field label="Original amount">
                        <input
                          value={item.rawMeasure ?? ''}
                          maxLength={512}
                          placeholder="Not supplied"
                          onChange={(event) =>
                            edit(
                              'ingredients',
                              input.ingredients.map((row, position) =>
                                position === index
                                  ? { ...row, rawMeasure: event.target.value || null }
                                  : row,
                              ),
                            )
                          }
                        />
                      </Field>
                      <RowTools
                        label="ingredient"
                        index={index}
                        count={input.ingredients.length}
                        onMove={(direction) =>
                          edit('ingredients', move(input.ingredients, index, direction))
                        }
                        onRemove={() =>
                          edit(
                            'ingredients',
                            input.ingredients.filter((_, position) => position !== index),
                          )
                        }
                      />
                    </div>
                  ))}
                </div>
                <button
                  className="add-row"
                  disabled={input.ingredients.length >= 100}
                  onClick={() =>
                    edit('ingredients', [...input.ingredients, { rawName: '', rawMeasure: null }])
                  }
                >
                  ＋ Add ingredient
                </button>
              </section>
              <section className="edit-section" id="recipe-instructions">
                <div className="section-intro">
                  <span className="section-number">03</span>
                  <div>
                    <h2>Instructions</h2>
                    <p>
                      Preserve headings and passages. A passage is not automatically a timed step.
                    </p>
                  </div>
                </div>
                {input.instructions.map((item, index) => (
                  <div className="instruction-editor" key={index}>
                    <div className="instruction-top">
                      <span className="order-number">{index + 1}</span>
                      <label className="inline-field">
                        Content type
                        <select
                          value={item.presentation}
                          onChange={(event) =>
                            edit(
                              'instructions',
                              input.instructions.map((row, position) =>
                                position === index
                                  ? {
                                      ...row,
                                      presentation: event.target.value as 'heading' | 'passage',
                                    }
                                  : row,
                              ),
                            )
                          }
                        >
                          <option value="passage">Passage</option>
                          <option value="heading">Heading</option>
                        </select>
                      </label>
                      <RowTools
                        label="instruction"
                        index={index}
                        count={input.instructions.length}
                        onMove={(direction) =>
                          edit('instructions', move(input.instructions, index, direction))
                        }
                        onRemove={() =>
                          edit(
                            'instructions',
                            input.instructions.filter((_, position) => position !== index),
                          )
                        }
                      />
                    </div>
                    <Field
                      label={`${item.presentation === 'heading' ? 'Heading' : 'Passage'} ${index + 1}`}
                    >
                      <textarea
                        rows={item.presentation === 'heading' ? 2 : 4}
                        maxLength={12000}
                        value={item.rawText}
                        onChange={(event) =>
                          edit(
                            'instructions',
                            input.instructions.map((row, position) =>
                              position === index ? { ...row, rawText: event.target.value } : row,
                            ),
                          )
                        }
                      />
                    </Field>
                  </div>
                ))}
                <button
                  className="add-row"
                  disabled={input.instructions.length >= 200}
                  onClick={() =>
                    edit('instructions', [
                      ...input.instructions,
                      { rawText: '', presentation: 'passage' },
                    ])
                  }
                >
                  ＋ Add instruction
                </button>
              </section>
              <section className="edit-section" id="recipe-credits">
                <div className="section-intro">
                  <span className="section-number">04</span>
                  <div>
                    <h2>Video & credits</h2>
                    <p>Keep original publisher links and clearly name additional sources.</p>
                  </div>
                </div>
                <Field
                  label="YouTube video link"
                  hint="A supported YouTube watch, short or embed URL. No video is loaded automatically."
                >
                  <input
                    type="url"
                    value={input.videoUrl ?? ''}
                    maxLength={2048}
                    placeholder="https://www.youtube.com/watch?v=…"
                    onChange={(event) => edit('videoUrl', event.target.value || null)}
                  />
                </Field>
                <Field label="Recipe collection URL">
                  <input
                    type="url"
                    value={input.recipePage ?? ''}
                    maxLength={2048}
                    onChange={(event) => edit('recipePage', event.target.value || null)}
                  />
                </Field>
                <Field label="Original publisher URL">
                  <input
                    type="url"
                    value={input.originalSourceUrl ?? ''}
                    maxLength={2048}
                    onChange={(event) => edit('originalSourceUrl', event.target.value || null)}
                  />
                </Field>
                {input.credits.map((credit, index) => (
                  <div className="credit-editor" key={index}>
                    <Field label={`Credit ${index + 1}`}>
                      <input
                        value={credit.label}
                        maxLength={256}
                        onChange={(event) =>
                          edit(
                            'credits',
                            input.credits.map((row, position) =>
                              position === index ? { ...row, label: event.target.value } : row,
                            ),
                          )
                        }
                      />
                    </Field>
                    <Field label="Credit URL · optional">
                      <input
                        type="url"
                        value={credit.url ?? ''}
                        maxLength={2048}
                        onChange={(event) =>
                          edit(
                            'credits',
                            input.credits.map((row, position) =>
                              position === index
                                ? { ...row, url: event.target.value || null }
                                : row,
                            ),
                          )
                        }
                      />
                    </Field>
                    <RowTools
                      label="credit"
                      index={index}
                      count={input.credits.length}
                      onMove={(direction) => edit('credits', move(input.credits, index, direction))}
                      onRemove={() =>
                        edit(
                          'credits',
                          input.credits.filter((_, position) => position !== index),
                        )
                      }
                    />
                  </div>
                ))}
                <button
                  className="add-row"
                  disabled={input.credits.length >= 20}
                  onClick={() => edit('credits', [...input.credits, { label: '', url: null }])}
                >
                  ＋ Add credit
                </button>
              </section>
              <section className="edit-section">
                <Field
                  label="Change summary"
                  hint="Describe this revision so the next editor can follow your work."
                >
                  <textarea
                    rows={2}
                    value={input.changeSummary}
                    maxLength={2000}
                    onChange={(event) => edit('changeSummary', event.target.value)}
                  />
                </Field>
              </section>
            </fieldset>
            <RightsPanel
              api={api}
              draft={draft}
              user={user}
              operations={operations}
              blocked={blocked || metadataDirty}
              recipeDirty={dirty}
              onDirty={setRightsDirty}
              onReauthenticate={onReauthenticate}
            />
            <MetadataPanel
              api={api}
              draft={draft}
              user={user}
              operations={operations}
              blocked={blocked || rightsDirty}
              recipeDirty={dirty}
              onDirty={setMetadataDirty}
              onReauthenticate={onReauthenticate}
            />
          </div>
          <aside className="editor-aside">
            <div className="save-panel">
              <p className="eyebrow">YOUR WORKSPACE</p>
              <h3>{dirty ? 'Ready to save your edits?' : 'This draft is saved.'}</h3>
              <p>
                Saving creates a new local revision. It does not publish or update the mobile
                catalogue.
              </p>
              {clearsMetadata && (
                <Notice title="Optional details need a fresh review">
                  Saving these recipe changes clears the current servings, times, dietary tags and
                  nutrition values and their evidence. Their earlier values remain in revision
                  history. A change-summary-only edit keeps them.
                </Notice>
              )}
              <button
                className="primary full-width"
                disabled={writesBlocked || !dirty}
                onClick={save}
              >
                {operations.busy ? 'Saving…' : 'Save draft'}
              </button>
              <p className="small muted">
                Last saved by {draft.updatedBy.username}
                <br />
                {formatTime(draft.updatedAt)}
              </p>
              <button
                className="text-button"
                disabled={blocked}
                onClick={() => setReloadReview(true)}
              >
                Reload saved version
              </button>
              {reloadError && <Notice tone="error">{reloadError}</Notice>}
            </div>
            <nav className="editor-index" aria-label="Editor sections">
              <a href="#recipe-details">01 · The recipe</a>
              <a href="#recipe-ingredients">02 · Ingredients</a>
              <a href="#recipe-instructions">03 · Instructions</a>
              <a href="#recipe-credits">04 · Video & credits</a>
              <a href="#recipe-rights">05 · Rights & permissions</a>
            </nav>
            <div className="readiness-panel">
              <h3>Readiness</h3>
              <p className="small muted">
                Checks for saved revision {draft.revision}
                {dirty ? '; unsaved changes have not been validated.' : '.'}
              </p>
              {draft.validationIssues.length ? (
                <ul>
                  {draft.validationIssues.map((issue, index) => (
                    <li key={index}>{issue.replaceAll('_', ' ')}</li>
                  ))}
                </ul>
              ) : (
                <p>
                  Saved content checks passed. Preparation and release issuance require their own
                  review.
                </p>
              )}
              <ReviewRecord review={draft.review} />
              {user.role !== 'editor' &&
                !dirty &&
                !reviewDirty &&
                draft.status === 'reviewed' &&
                draft.validationIssues.length === 0 && (
                  <PublicationCheck
                    key={`${draft.draftId}:${draft.revision}`}
                    api={api}
                    draft={draft}
                    disabled={blocked}
                    onReauthenticate={onReauthenticate}
                    {...(onPreparationInvalidated
                      ? { onInvalidated: onPreparationInvalidated }
                      : {})}
                    {...(user.role === 'administrator' && onPrepared
                      ? {
                          onPrepared: (preparation: AdminPublicationPreparation) =>
                            onPrepared(preparation, draft.input.title),
                        }
                      : {})}
                  />
                )}
              {!draft.review && draft.approval && (
                <p className="small">
                  Review recorded by {draft.approval.reviewerId} for revision{' '}
                  {draft.approval.revision}. {draft.approval.note}
                </p>
              )}
              {user.role !== 'editor' && (
                <div className="review-actions">
                  <button
                    className="secondary"
                    disabled={writesBlocked || dirty || draft.validationIssues.length > 0}
                    onClick={() => setReview('approved')}
                  >
                    Review & approve
                  </button>
                  <button
                    className="text-button"
                    disabled={writesBlocked || dirty}
                    onClick={() => setReview('changes_requested')}
                  >
                    Request changes
                  </button>
                  <small>
                    Own reviews are permitted and are not an independent review. Media rights must
                    be reviewed before approval.
                  </small>
                </div>
              )}
              <details>
                <summary>Recipe metadata</summary>
                <p className="small">
                  Servings: {draft.metadata.servings.value ?? 'Not verified'}
                  <br />
                  Preparation:{' '}
                  {draft.metadata.prepMinutes.value === null
                    ? 'Not verified'
                    : `${draft.metadata.prepMinutes.value} minutes`}
                  <br />
                  Cooking:{' '}
                  {draft.metadata.cookMinutes.value === null
                    ? 'Not verified'
                    : `${draft.metadata.cookMinutes.value} minutes`}
                </p>
                <p className="small">
                  <a href="#recipe-metadata">Review optional details and source evidence</a>.
                </p>
              </details>
            </div>
          </aside>
        </div>
      )}
      {reloadReview && (
        <Dialog
          title="Reload the saved version?"
          onClose={() => {
            if (!reloadBusy) setReloadReview(false);
          }}
        >
          <p>
            {dirty || reviewDirty
              ? 'Your unsaved edits will be replaced with the latest server version. They have not been saved.'
              : 'Read the current saved revision from the server.'}
          </p>
          {reloadError && <Notice tone="error">{reloadError}</Notice>}
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={reloadBusy}
              onClick={() => setReloadReview(false)}
            >
              Keep editing
            </button>
            <button className="primary" disabled={reloadBusy} onClick={() => void reload()}>
              {reloadBusy ? 'Reading saved version…' : 'Reload saved version'}
            </button>
          </div>
        </Dialog>
      )}
      {restoreReview && historical && (
        <Dialog
          title={`Restore revision ${historical.revision}?`}
          onClose={() => setRestoreReview(false)}
        >
          <p>
            This creates a new draft revision from revision {historical.revision}. Existing history
            remains intact. Any earlier approval does not transfer.
          </p>
          <p>
            Optional metadata becomes unknown and its review evidence does not transfer. Earlier
            values stay in revision history; review any needed servings, times, dietary tags or
            nutrition again.
          </p>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setRestoreReview(false)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={writesBlocked || dirty}
              onClick={() => {
                const selected = historical.revision;
                setRestoreReview(false);
                void operations.run('restore', draft.draftId, (id) =>
                  api.restore(draft.draftId, id, draft.revision, selected),
                );
              }}
            >
              Create restored revision
            </button>
          </div>
        </Dialog>
      )}
      {review && (
        <Dialog
          title={review === 'approved' ? 'Approve this saved revision?' : 'Request changes'}
          onClose={() => setReview(null)}
        >
          <p>
            This records your decision on saved revision {draft.revision}. It does not publish the
            recipe. Your username and review time will be recorded.
          </p>
          <Field label="Review note">
            <textarea
              rows={4}
              value={reviewNote}
              maxLength={2000}
              onChange={(event) => setReviewNote(event.target.value)}
            />
          </Field>
          <div className="dialog-actions">
            <button className="secondary" onClick={() => setReview(null)}>
              Cancel
            </button>
            <button
              className="primary"
              disabled={blocked}
              onClick={() => {
                const decision = review;
                const note = reviewNote;
                setReview(null);
                void operations.run('review', draft.draftId, (id) =>
                  api.review(draft.draftId, id, draft.revision, decision, note),
                );
              }}
            >
              Record review
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
