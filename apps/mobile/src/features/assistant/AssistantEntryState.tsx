import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';
import type { SearchCriteria } from '@cookmate/domain';
import { useWorkspace } from '../workspace/WorkspaceProvider';

export const assistantMessageLimit = 4000;
const previewDraftKey = 'cookmate.preview.assistant-draft.v1';

export function searchContextLabel(criteria: SearchCriteria) {
  return [
    criteria.query?.trim(),
    criteria.category,
    criteria.cuisine,
    ...(criteria.ingredients ?? []),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function suggestedSearchQuestion(criteria: SearchCriteria) {
  const query = criteria.query?.trim();
  const filters = [
    criteria.category && `category: ${criteria.category}`,
    criteria.cuisine && `cuisine: ${criteria.cuisine}`,
    criteria.ingredients?.length && `ingredients: ${criteria.ingredients.join(', ')}`,
  ].filter(Boolean);
  return `${query ? `Help me choose a recipe for “${query}”.` : 'Help me choose a recipe.'}${filters.length ? `\nMy current search filters are ${filters.join('; ')}.` : ''}`;
}

export function appendSuggestedQuestion(draft: string, question: string) {
  const next = draft ? `${draft}\n\n${question}` : question;
  return [...next].length <= assistantMessageLimit ? next : null;
}

interface SearchEntry {
  id: number;
  criteria: SearchCriteria;
  question: string;
}
interface EntryState {
  search: SearchEntry | null;
  openSearch(criteria: SearchCriteria): void;
  setQuestion(question: string): void;
  clearSearch(): void;
  previewDraft: string;
  setPreviewDraft(text: string): void;
  previewDraftError: boolean;
}
const Context = createContext<EntryState | null>(null);

/** UI handoffs only: never a saved preference, provider request or memory-scope change. */
export function AssistantEntryProvider({
  children,
  scopeKey,
}: {
  children: ReactNode;
  scopeKey?: string;
}) {
  const workspace = useWorkspace();
  const workspaceKey = scopeKey ?? workspace.workspaceKey;
  const draftKey =
    workspaceKey === 'guest'
      ? previewDraftKey
      : `${previewDraftKey}.${encodeURIComponent(workspaceKey)}`;
  const [search, setSearch] = useState<SearchEntry | null>(null);
  const sequence = useRef(0);
  const [previewDraft, setDraft] = useState('');
  const [previewDraftError, setDraftError] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
      setDraft(window.sessionStorage.getItem(draftKey) ?? '');
    } catch {
      setDraftError(true);
    }
  }, [draftKey]);
  const setPreviewDraft = (text: string) => {
    setDraft(text);
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(draftKey, text);
      setDraftError(false);
    } catch {
      setDraftError(true);
    }
  };
  return (
    <Context.Provider
      value={{
        search,
        openSearch: (criteria) => {
          const snapshot = {
            ...criteria,
            ...(criteria.ingredients ? { ingredients: [...criteria.ingredients] } : {}),
          };
          setSearch({
            id: ++sequence.current,
            criteria: snapshot,
            question: suggestedSearchQuestion(snapshot),
          });
        },
        setQuestion: (question) =>
          setSearch((current) => (current ? { ...current, question } : null)),
        clearSearch: () => setSearch(null),
        previewDraft,
        setPreviewDraft,
        previewDraftError,
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function useAssistantEntry() {
  const state = useContext(Context);
  if (!state) throw new Error('AssistantEntryProvider is missing');
  return state;
}
