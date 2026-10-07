import { useEffect, useRef, useState } from 'react';
import type { AdminDraft, AdminPublicationTranslationSelection } from '../src/contracts';
import type { AdminTranslationSummary } from '../src/translations/contracts';
import { AdminApi, errorMessage } from './api';
import { Field, Notice } from './components';

export interface PublicationTranslationChoice {
  complete: boolean;
  selections: AdminPublicationTranslationSelection[];
  languages: { translationId: string; translationRevision: number; targetLanguage: string }[];
}
interface Choice {
  item: AdminTranslationSummary;
  statement: string;
  sourceUrl: string;
  acknowledge: boolean;
}
const noChoice: PublicationTranslationChoice = { complete: true, selections: [], languages: [] };
function selected(values: Choice[]): PublicationTranslationChoice {
  const complete =
    values.length <= 8 &&
    new Set(values.map((v) => v.item.targetLanguage)).size === values.length &&
    values.every((v) => {
      if (!v.acknowledge || !v.statement.trim() || v.statement.length > 2000) return false;
      if (!v.sourceUrl) return true;
      try {
        const url = new URL(v.sourceUrl);
        return (
          v.sourceUrl.length <= 2048 &&
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password
        );
      } catch {
        return false;
      }
    });
  const ordered = [...values].sort((a, b) =>
    a.item.translationId.localeCompare(b.item.translationId),
  );
  return {
    complete,
    selections: complete
      ? ordered.map((v) => ({
          translationId: v.item.translationId,
          translationRevision: v.item.revision,
          rights: { statement: v.statement, sourceUrl: v.sourceUrl || null, acknowledge: true },
        }))
      : [],
    languages: ordered.map((v) => ({
      translationId: v.item.translationId,
      translationRevision: v.item.revision,
      targetLanguage: v.item.targetLanguage,
    })),
  };
}

/** Select existing reviewed revisions; no translated content or quantity is authored here. */
export function PublicationTranslations({
  api,
  draft,
  disabled,
  onChange,
}: {
  api: AdminApi;
  draft: Pick<AdminDraft, 'draftId' | 'revision'>;
  disabled: boolean;
  onChange(value: PublicationTranslationChoice): void;
}) {
  const [items, setItems] = useState<AdminTranslationSummary[] | null>(null),
    [choices, setChoices] = useState<Choice[]>([]);
  const [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<string | null>(null);
  const live = useRef(false),
    flight = useRef(false),
    currentChoices = useRef(choices);
  currentChoices.current = choices;
  const generation = api.sessionGeneration;
  const latest = useRef({ api, draft, generation, disabled, onChange });
  latest.current = { api, draft, generation, disabled, onChange };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const current = () =>
    live.current &&
    latest.current.api === api &&
    latest.current.draft.draftId === draft.draftId &&
    latest.current.draft.revision === draft.revision &&
    latest.current.generation === generation &&
    api.sessionGeneration === generation;
  const change = (next: Choice[]) => {
    if (!current() || latest.current.disabled || flight.current) return;
    currentChoices.current = next;
    setChoices(next);
    latest.current.onChange(next.length ? selected(next) : noChoice);
  };
  async function load() {
    if (!current() || latest.current.disabled || flight.current) return;
    flight.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const response = await api.translations(draft.draftId);
      if (!current()) return;
      if (!Array.isArray(response.items) || response.items.length > 200)
        throw Error('Invalid translation list');
      setItems(response.items);
    } catch (error) {
      if (current()) setFailure(errorMessage(error));
    } finally {
      flight.current = false;
      if (current()) setBusy(false);
    }
  }
  return (
    <section aria-label="Translations for this package">
      <button className="text-button" disabled={disabled || busy} onClick={() => void load()}>
        {busy ? 'Loading translations…' : 'Choose reviewed translations'}
      </button>
      <p className="small muted">
        Optional. Only translations reviewed against this exact saved recipe revision can be
        included. The original text and quantities remain available.
      </p>
      {failure && <Notice tone="error">{failure}</Notice>}
      {items?.length === 0 && (
        <p className="small">No translations have been saved for this recipe.</p>
      )}
      {items?.map((item) => {
        const value = choices.find((v) => v.item.translationId === item.translationId);
        const ready =
          item.effectiveStatus === 'reviewed' &&
          item.sourceStatus.kind === 'current' &&
          item.source.draftId === draft.draftId &&
          item.source.revision === draft.revision &&
          item.review?.decision === 'approved';
        const update = (patch: Partial<Omit<Choice, 'item'>>) =>
          change(
            currentChoices.current.map((v) =>
              v.item.translationId === item.translationId ? { ...v, ...patch } : v,
            ),
          );
        return (
          <fieldset key={item.translationId} disabled={disabled || busy}>
            <legend>
              {item.originalLanguage} → {item.targetLanguage} · revision {item.revision}
            </legend>
            <label>
              <input
                type="checkbox"
                checked={!!value}
                disabled={disabled || busy || (!ready && !value) || (!value && choices.length >= 8)}
                onChange={(event) => {
                  if (event.target.checked && !ready) return;
                  if (
                    event.target.checked &&
                    currentChoices.current.some((v) => v.item.translationId === item.translationId)
                  )
                    return;
                  change(
                    event.target.checked
                      ? [
                          ...currentChoices.current,
                          { item, statement: '', sourceUrl: '', acknowledge: false },
                        ]
                      : currentChoices.current.filter(
                          (v) => v.item.translationId !== item.translationId,
                        ),
                  );
                }}
              />{' '}
              Include {item.targetLanguage} translation
            </label>
            {!ready && (
              <p className="small">
                This translation needs review against saved recipe revision {draft.revision} before
                inclusion.
              </p>
            )}
            {value && (
              <>
                <Field
                  label={`Translation permission statement · ${item.targetLanguage}`}
                  hint="Record the permission to publish this translated text. Permission for the original does not automatically cover a translation."
                >
                  <textarea
                    value={value.statement}
                    maxLength={2000}
                    onChange={(e) => update({ statement: e.target.value })}
                  />
                </Field>
                <Field
                  label={`Translation permission source URL · ${item.targetLanguage}`}
                  hint="Optional HTTP or HTTPS evidence URL."
                >
                  <input
                    type="url"
                    value={value.sourceUrl}
                    maxLength={2048}
                    onChange={(e) => update({ sourceUrl: e.target.value })}
                  />
                </Field>
                <label>
                  <input
                    type="checkbox"
                    checked={value.acknowledge}
                    onChange={(e) => update({ acknowledge: e.target.checked })}
                  />{' '}
                  I have reviewed permission to publish this exact translated version.
                </label>
              </>
            )}
          </fieldset>
        );
      })}
      {choices.length > 0 && !selected(choices).complete && (
        <p role="alert" className="small">
          Complete each translation’s permission statement and acknowledgement, use a valid optional
          URL, and select only one translation per language.
        </p>
      )}
    </section>
  );
}
