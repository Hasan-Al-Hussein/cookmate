import type {
  AdminAsset,
  AdminDraft,
  AdminDraftInput,
  AdminHistoryEntry,
  AdminLibrary,
  AdminLibraryStatus,
  AdminMutation,
  AdminOperationResolution,
  AdminRightsInput,
  AdminSession,
  AdminPublicationPreview,
  AdminPublicationPreparation,
  AdminPublicationTranslationSelection,
  AdminRetainedPublicationSummary,
  AdminPublicationReleaseState,
  AdminPublicationIssueRequest,
  AdminPublicationIssueReceipt,
  AdminPublicationIssueResolution,
  AdminMetadataInput,
} from '../src/contracts';
import type {
  AdminTranslation,
  AdminTranslationInput,
  AdminTranslationMutation,
  AdminTranslationOriginal,
  AdminTranslationResolution,
  AdminTranslationSummary,
} from '../src/translations/contracts';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get uncertain() {
    return this.status === 0 || this.status >= 500;
  }
}
export const errorMessage = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : 'The request could not be completed. Your local edits are retained.';
export type LibraryStatus = AdminLibraryStatus;

export class AdminApi {
  private csrf: string | null = null;
  private authGeneration = 0;
  private authFlight = false;
  constructor(
    private readonly onUnauthorized: () => void,
    private readonly fetcher: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}
  /** UI review authority expires when authentication is refreshed, replaced or revoked. */
  get sessionGeneration() {
    return this.authGeneration;
  }
  private assertCurrentGeneration(generation: number) {
    if (generation !== this.authGeneration)
      throw new ApiError(
        0,
        'auth_response_stale',
        'This response belongs to an earlier session. Keep unconfirmed change references and check them using the current account.',
      );
  }
  private beginAuthentication(): number {
    if (this.authFlight)
      throw new ApiError(
        409,
        'session_busy',
        'Another session request is in progress. Wait briefly, then try again.',
      );
    this.authFlight = true;
    return ++this.authGeneration;
  }
  private async request<T>(
    path: string,
    options: RequestInit = {},
    generation = this.authGeneration,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const headers = new Headers(options.headers);
      const write = !!options.method && options.method !== 'GET';
      if (write) {
        if (!this.csrf)
          throw new ApiError(403, 'session_required', 'Refresh your session, then try again.');
        headers.set('x-csrf-token', this.csrf);
      }
      if (typeof options.body === 'string') headers.set('content-type', 'application/json');
      const response = await this.fetcher(`/admin/api${path}`, {
        ...options,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      });
      this.assertCurrentGeneration(generation);
      if (!response.ok) {
        let code = 'request_failed';
        let message = `The request was not completed (${response.status}). Your edits are retained.`;
        try {
          const payload: unknown = await response.json();
          if (payload && typeof payload === 'object' && 'error' in payload) {
            const detail = payload.error;
            if (
              detail &&
              typeof detail === 'object' &&
              'message' in detail &&
              typeof detail.message === 'string'
            )
              message = detail.message;
            if (
              detail &&
              typeof detail === 'object' &&
              'code' in detail &&
              typeof detail.code === 'string'
            )
              code = detail.code;
          }
        } catch {
          /* Keep a safe status-based message if the server body is unavailable. */
        }
        this.assertCurrentGeneration(generation);
        if (response.status === 401) {
          this.csrf = null;
          this.authGeneration++;
          this.onUnauthorized();
        }
        throw new ApiError(response.status, code, message);
      }
      const value = response.status === 204 ? undefined : await response.json();
      this.assertCurrentGeneration(generation);
      return value as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        0,
        'connection_unconfirmed',
        'The server response could not be confirmed. Check the operation before starting another change.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private async sessionRequest(path: string, options: RequestInit = {}) {
    const generation = this.beginAuthentication();
    try {
      const value = await this.request<AdminSession>(path, options, generation);
      this.assertCurrentGeneration(generation);
      this.csrf = value.csrfToken;
      return value;
    } finally {
      this.authFlight = false;
    }
  }
  session() {
    return this.sessionRequest('/session');
  }
  login(username: string, password: string) {
    return this.sessionRequest('/session', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
  }
  async logout() {
    const generation = this.beginAuthentication();
    try {
      await this.request<void>('/session', { method: 'DELETE' }, generation);
      this.assertCurrentGeneration(generation);
      this.csrf = null;
    } finally {
      this.authFlight = false;
    }
  }
  reauth(password: string) {
    return this.sessionRequest('/reauth', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }
  library(query: string, status: LibraryStatus, cursor?: string) {
    const params = new URLSearchParams({ query, status });
    if (cursor) params.set('cursor', cursor);
    return this.request<AdminLibrary>(`/library?${params}`);
  }
  draft(id: string) {
    return this.request<AdminDraft>(`/drafts/${encodeURIComponent(id)}`);
  }
  translations(draftId: string) {
    return this.request<{ items: AdminTranslationSummary[] }>(
      `/drafts/${encodeURIComponent(draftId)}/translations`,
    );
  }
  translation(id: string, revision?: number) {
    return this.request<AdminTranslation>(
      `/translations/${encodeURIComponent(id)}${revision === undefined ? '' : `?revision=${revision}`}`,
    );
  }
  translationOriginal(id: string, revision?: number) {
    return this.request<AdminTranslationOriginal>(
      `/translations/${encodeURIComponent(id)}/original${revision === undefined ? '' : `?revision=${revision}`}`,
    );
  }
  translationHistory(id: string) {
    return this.request<{ items: AdminTranslationSummary[]; limit: number }>(
      `/translations/${encodeURIComponent(id)}/history`,
    );
  }
  createTranslation(
    draftId: string,
    request: {
      operationId: string;
      sourceRevision: number;
      originalLanguage: string;
      targetLanguage: string;
      input: AdminTranslationInput;
    },
  ) {
    return this.request<AdminTranslationMutation>(
      `/drafts/${encodeURIComponent(draftId)}/translations`,
      {
        method: 'POST',
        body: JSON.stringify(request),
      },
    );
  }
  saveTranslation(
    id: string,
    operationId: string,
    expectedRevision: number,
    input: AdminTranslationInput,
  ) {
    return this.request<AdminTranslationMutation>(`/translations/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({ operationId, expectedRevision, input }),
    });
  }
  rebaseTranslation(
    id: string,
    operationId: string,
    expectedRevision: number,
    sourceRevision: number,
    input: AdminTranslationInput,
  ) {
    return this.request<AdminTranslationMutation>(
      `/translations/${encodeURIComponent(id)}/rebase`,
      {
        method: 'POST',
        body: JSON.stringify({ operationId, expectedRevision, sourceRevision, input }),
      },
    );
  }
  reviewTranslation(
    id: string,
    operationId: string,
    expectedRevision: number,
    decision: 'approved' | 'changes_requested',
    note: string,
    acknowledgeHumanReview: boolean,
  ) {
    return this.request<AdminTranslationMutation>(
      `/translations/${encodeURIComponent(id)}/reviews`,
      {
        method: 'POST',
        body: JSON.stringify({
          operationId,
          expectedRevision,
          decision,
          note,
          acknowledgeHumanReview,
        }),
      },
    );
  }
  translationOperation(id: string, requestFingerprint: string) {
    return this.request<AdminTranslationMutation>(
      `/translation-operations/${encodeURIComponent(id)}?requestFingerprint=${requestFingerprint}`,
    );
  }
  resolveTranslationOperation(id: string, requestFingerprint: string) {
    return this.request<AdminTranslationResolution>(
      `/translation-operations/${encodeURIComponent(id)}/resolve`,
      {
        method: 'POST',
        body: JSON.stringify({ requestFingerprint }),
      },
    );
  }
  create(operationId: string, fromRecipeId?: string) {
    return this.request<AdminMutation>('/drafts', {
      method: 'POST',
      body: JSON.stringify({ operationId, ...(fromRecipeId ? { fromRecipeId } : {}) }),
    });
  }
  save(draftId: string, operationId: string, expectedRevision: number, input: AdminDraftInput) {
    return this.request<AdminMutation>(`/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PUT',
      body: JSON.stringify({ operationId, expectedRevision, input }),
    });
  }
  history(id: string) {
    return this.request<{ items: AdminHistoryEntry[] }>(
      `/drafts/${encodeURIComponent(id)}/history`,
    );
  }
  revision(id: string, revision: number) {
    return this.request<AdminDraft>(`/drafts/${encodeURIComponent(id)}/revisions/${revision}`);
  }
  restore(id: string, operationId: string, expectedRevision: number, sourceRevision: number) {
    return this.request<AdminMutation>(`/drafts/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ operationId, expectedRevision, sourceRevision }),
    });
  }
  review(
    id: string,
    operationId: string,
    expectedRevision: number,
    decision: 'approved' | 'changes_requested',
    note: string,
  ) {
    return this.request<AdminMutation>(`/drafts/${encodeURIComponent(id)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ operationId, expectedRevision, decision, note }),
    });
  }
  operation(id: string) {
    return this.request<AdminMutation>(`/operations/${encodeURIComponent(id)}`);
  }
  rights(id: string, operationId: string, expectedRevision: number, input: AdminRightsInput) {
    return this.request<AdminMutation>(`/drafts/${encodeURIComponent(id)}/rights`, {
      method: 'POST',
      body: JSON.stringify({ operationId, expectedRevision, ...input }),
    });
  }
  publicationPreview(id: string, expectedRevision: number) {
    return this.request<AdminPublicationPreview>(
      `/drafts/${encodeURIComponent(id)}/publication-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedRevision }),
      },
    );
  }
  metadata(id: string, operationId: string, expectedRevision: number, input: AdminMetadataInput) {
    return this.request<AdminMutation>(`/drafts/${encodeURIComponent(id)}/metadata`, {
      method: 'POST',
      body: JSON.stringify({ operationId, expectedRevision, input }),
    });
  }
  preparePublication(
    id: string,
    expectedRevision: number,
    translations?: AdminPublicationTranslationSelection[],
  ) {
    return this.request<AdminPublicationPreparation>(
      `/drafts/${encodeURIComponent(id)}/publication-preparation`,
      {
        method: 'POST',
        body: JSON.stringify({
          expectedRevision,
          ...(translations?.length ? { translations } : {}),
        }),
      },
    );
  }
  publicationPreparation(
    id: string,
    revision: number,
    translations?: AdminPublicationTranslationSelection[],
  ) {
    if (translations?.length)
      return this.request<AdminPublicationPreparation>(
        `/drafts/${encodeURIComponent(id)}/publication-preparation/recovery`,
        { method: 'POST', body: JSON.stringify({ expectedRevision: revision, translations }) },
      );
    return this.request<AdminPublicationPreparation>(
      `/drafts/${encodeURIComponent(id)}/publication-preparation?revision=${revision}`,
    );
  }
  publicationPreparationByOperation(id: string, operationId: string) {
    return this.request<AdminPublicationPreparation>(
      `/drafts/${encodeURIComponent(id)}/publication-preparation?${new URLSearchParams({ operationId })}`,
    );
  }
  retainedPublicationPreparations(id: string) {
    return this.request<{ items: AdminRetainedPublicationSummary[] }>(
      `/drafts/${encodeURIComponent(id)}/publication-preparation?list=1`,
    );
  }
  publicationReleaseState() {
    return this.request<AdminPublicationReleaseState>('/publication/releases/current');
  }
  /** The selector validates the returned envelope against this exact requested ancestor. */
  issuedPublicationPackage(releaseId: string) {
    return this.request<unknown>(`/publication/releases/${encodeURIComponent(releaseId)}/package`);
  }
  issuePublicationRelease(request: AdminPublicationIssueRequest) {
    return this.request<AdminPublicationIssueReceipt>('/publication/releases', {
      method: 'POST',
      body: JSON.stringify(request),
    });
  }
  publicationReleaseOperation(operationId: string, requestFingerprint: string) {
    const query = new URLSearchParams({ requestFingerprint });
    return this.request<AdminPublicationIssueReceipt>(
      `/publication/releases/operations/${encodeURIComponent(operationId)}?${query}`,
    );
  }
  resolvePublicationRelease(operationId: string, requestFingerprint: string) {
    return this.request<AdminPublicationIssueResolution>(
      `/publication/releases/operations/${encodeURIComponent(operationId)}/resolve`,
      { method: 'POST', body: JSON.stringify({ requestFingerprint }) },
    );
  }
  resolveOperation(id: string) {
    return this.request<AdminOperationResolution>(`/operations/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
      body: '{}',
    });
  }
  upload(id: string, operationId: string, revision: number, file: File) {
    const body = new FormData();
    body.append('file', file);
    return this.request<AdminAsset>(`/drafts/${encodeURIComponent(id)}/media`, {
      method: 'POST',
      headers: { 'x-operation-id': operationId, 'x-draft-revision': String(revision) },
      body,
    });
  }
}

/** Only server-owned catalogue/media paths may be requested by an image element. */
export function safePhotoUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const base = typeof location === 'undefined' ? 'https://admin.invalid' : location.origin;
    const url = new URL(value, base);
    if (url.origin !== base || url.search || url.hash || url.username || url.password)
      return undefined;
    return /^\/admin\/api\/(?:assets\/[0-9a-f]{64}|baseline\/[0-9]{1,20}\/photo)$/.test(
      url.pathname,
    )
      ? url.pathname
      : undefined;
  } catch {
    return undefined;
  }
}
