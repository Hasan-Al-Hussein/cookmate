import { useEffect, useRef, useState } from 'react';
import type { AdminLibrary, AdminLibraryItem, AdminUser } from '../src/contracts';
import { AdminApi, ApiError, errorMessage, type LibraryStatus } from './api';
import { Badge, Notice, Photo, formatTime } from './components';
import { archiveSelection, type ArchiveSelection } from './archiveSelection';
import { rollbackSelection, type RollbackSelection } from './rollbackIssuance';

const failureState = (failure: unknown) => ({
  message: errorMessage(failure),
  notConfigured: failure instanceof ApiError && failure.code === 'publication_not_configured',
});

export function Library({
  api,
  status,
  refresh,
  blocked,
  active,
  onStatus,
  onOpen,
  onCreate,
  user,
  onArchive,
  onRollback,
}: {
  api: AdminApi;
  status: LibraryStatus;
  refresh: number;
  blocked: boolean;
  active: boolean;
  onStatus: (status: LibraryStatus) => void;
  onOpen: (item: AdminLibraryItem) => void;
  onCreate: () => void;
  user?: AdminUser;
  onArchive?: (selection: ArchiveSelection) => void;
  onRollback?: (selection: RollbackSelection) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<AdminLibrary | null>(null);
  const [error, setError] = useState<{ message: string; notConfigured: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const generation = useRef(0);
  const request = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ active, blocked, user, onArchive, onRollback, page, api });
  latest.current = { active, blocked, user, onArchive, onRollback, page, api };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const own = ++generation.current;
    request.current = false;
    setLoading(active);
    setError(null);
    setPage(null);
    if (!active) return;
    void api
      .library(query, status)
      .then((result) => {
        if (own === generation.current) setPage(result);
      })
      .catch((failure: unknown) => {
        if (own === generation.current) setError(failureState(failure));
      })
      .finally(() => {
        if (own === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [api, query, status, refresh, retry, active]);
  async function more() {
    if (!active || !page?.nextCursor || request.current) return;
    request.current = true;
    setLoading(true);
    setError(null);
    const own = generation.current;
    try {
      const next = await api.library(query, status, page.nextCursor);
      if (own !== generation.current) return;
      const ids = new Set(page.items.map((item) => `${item.recipeId}:${item.draftId ?? ''}`));
      if (
        next.nextCursor === page.nextCursor ||
        next.items.some((item) => ids.has(`${item.recipeId}:${item.draftId ?? ''}`))
      )
        throw new Error('Changed page');
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (failure) {
      if (own === generation.current) setError(failureState(failure));
    } finally {
      if (own === generation.current) {
        request.current = false;
        setLoading(false);
      }
    }
  }
  if (!active) return null;
  return (
    <>
      <header className="library-heading">
        <div>
          <p className="eyebrow">THE COOKMATE KITCHEN</p>
          <h1>
            Good recipes,
            <br />
            <em>thoughtfully kept.</em>
          </h1>
          <p>Prepare, refine and review your recipe collection.</p>
        </div>
        <div className="photo-ribbon" aria-hidden="true">
          {page?.items.slice(0, 3).map((item) => (
            <Photo key={item.draftId ?? item.recipeId} url={item.photoUrl} title="" />
          ))}
        </div>
      </header>
      <div className="section-heading">
        <div>
          <h2>Recipe library</h2>
          <p className="muted">Local drafts stay separate from the recipes in the app.</p>
        </div>
        <button className="primary" disabled={blocked} onClick={onCreate}>
          <span aria-hidden="true">＋</span> New recipe
        </button>
      </div>
      <form
        className="library-tools"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(search.trim());
        }}
      >
        <label className="search-field">
          <span className="sr-only">Search recipe library</span>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m15 15 5 5" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            maxLength={200}
            placeholder="Find a dish, category or cuisine"
          />
          <button type="submit">Search</button>
        </label>
        <label className="filter-label">
          Show
          <select
            value={status}
            onChange={(event) => onStatus(event.target.value as LibraryStatus)}
          >
            <option value="all">All recipes</option>
            <option value="bundled">App catalogue</option>
            <option value="draft">Drafts</option>
            <option value="reviewed">Reviewed drafts</option>
            <option value="prepared">Prepared drafts</option>
            <option value="published">Published in signed release</option>
            <option value="archived">Archived in signed release</option>
          </select>
        </label>
      </form>
      {error && (
        <Notice
          title={error.notConfigured ? 'Signed releases not configured' : 'Library needs a refresh'}
          tone="error"
        >
          {error.message}{' '}
          <button
            className="text-button"
            onClick={() =>
              error.notConfigured ? onStatus('draft') : setRetry((value) => value + 1)
            }
          >
            {error.notConfigured ? 'View drafts' : 'Refresh library'}
          </button>
        </Notice>
      )}
      {loading && !page && (
        <p className="loading" role="status">
          Loading your recipe library…
        </p>
      )}
      {page && (
        <>
          <p className="muted">
            {page.publicationStatus.status === 'not_configured'
              ? 'Signed release status is unavailable: release signing is not configured. Draft review and preparation remain separate steps.'
              : 'Published and archived describe the current signed release. They do not confirm that any device has adopted it.'}
          </p>
          <p className="result-count">
            {page.items.length} {page.items.length === 1 ? 'recipe' : 'recipes'} shown
            {query ? ` for “${query}”` : ''}
            {page.nextCursor ? ' · More available' : ''}
          </p>
          <div className="recipe-library">
            {page.items.map((item) => {
              const selection =
                user?.role === 'administrator' && onArchive
                  ? archiveSelection(item, page.publicationStatus)
                  : null;
              const rollback =
                user?.role === 'administrator' && onRollback
                  ? rollbackSelection(item, page.publicationStatus)
                  : null;
              const renderedPage = page,
                sessionGeneration = api.sessionGeneration;
              return (
                <div key={`${item.recipeId}:${item.draftId ?? ''}`}>
                  <button className="library-row" disabled={blocked} onClick={() => onOpen(item)}>
                    <Photo url={item.photoUrl} title={item.title} />
                    <span className="recipe-info">
                      <span className="recipe-category">
                        {item.cuisine || 'Cuisine not set'} · {item.category || 'Category not set'}
                      </span>
                      <strong>{item.title || 'Untitled recipe'}</strong>
                      <span className="recipe-meta">
                        {item.revision ? `Revision ${item.revision} · ` : ''}
                        {formatTime(item.updatedAt)}
                      </span>
                      {item.preparation && (
                        <span className="recipe-meta">
                          Prepared revision {item.preparation.draftRevision} ·{' '}
                          {item.preparation.packageCount}{' '}
                          {item.preparation.packageCount === 1
                            ? 'verified package'
                            : 'verified packages'}
                        </span>
                      )}
                      {item.publication && (
                        <span className="recipe-meta">{publicationLabel(item)}</span>
                      )}
                    </span>
                    <span className="row-end">
                      <Badge status={item.status} />
                      <span className="row-action">
                        {item.draftId ? 'Open latest draft' : 'Create a draft'}{' '}
                        <span aria-hidden="true">↗</span>
                      </span>
                    </span>
                  </button>
                  {selection && (
                    <div className="inline-actions">
                      <button
                        className="text-button"
                        disabled={blocked}
                        aria-label={`Archive published version of ${item.title || 'Untitled recipe'}`}
                        onClick={() => {
                          const current = latest.current;
                          if (
                            mounted.current &&
                            current.active &&
                            !current.blocked &&
                            current.user?.role === 'administrator' &&
                            current.user.userId === user?.userId &&
                            current.api === api &&
                            current.api.sessionGeneration === sessionGeneration &&
                            current.page === renderedPage
                          )
                            current.onArchive?.(selection);
                        }}
                      >
                        Archive published version
                      </button>
                    </div>
                  )}
                  {rollback && (
                    <div className="inline-actions">
                      <button
                        className="text-button"
                        disabled={blocked}
                        aria-label={`Review earlier issued version of ${item.title || 'Untitled recipe'}`}
                        onClick={() => {
                          const current = latest.current;
                          if (
                            mounted.current &&
                            current.active &&
                            !current.blocked &&
                            current.user?.role === 'administrator' &&
                            current.user.userId === user?.userId &&
                            current.api === api &&
                            current.api.sessionGeneration === sessionGeneration &&
                            current.page === renderedPage
                          )
                            current.onRollback?.(rollback);
                        }}
                      >
                        Review earlier issued version
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!page.items.length && (
            <div className="empty-state">
              <h3>No recipes in this view</h3>
              <p>Try another search or start a new recipe draft.</p>
            </div>
          )}
          {page.nextCursor && (
            <button className="secondary load-more" disabled={loading} onClick={() => void more()}>
              {loading ? 'Loading more…' : 'Load more recipes'}
            </button>
          )}
        </>
      )}
    </>
  );
}

function publicationLabel(item: AdminLibraryItem): string {
  const publication = item.publication!;
  if (publication.state === 'withdrawn') return 'Withdrawn from the signed release';
  const state = publication.state === 'current' ? 'Published' : 'Archived';
  if (publication.matchingDraftRevision === null)
    return `${state} catalogue version in signed release`;
  const revision = publication.matchingDraftRevision;
  return revision === item.revision
    ? `${state} revision ${revision} in signed release`
    : `${state} revision ${revision} in signed release; latest draft revision ${item.revision} is not published`;
}
