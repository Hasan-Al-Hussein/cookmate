import { useEffect, useState } from 'react';
import type {
  AdminDraft,
  AdminRightsInput,
  AdminRightsRecord,
  AdminRightsScope,
  AdminUser,
} from '../src/contracts';
import { AdminApi } from './api';
import { Field, Notice, formatTime } from './components';
import type { useOperations } from './useOperations';

const scopes: Record<AdminRightsScope, string> = {
  recipe_text: 'Recipe text',
  photo: 'Selected photo',
  video_embed: 'Video embedding',
};
const statuses = {
  permitted: 'Permission recorded',
  restricted: 'Restricted',
  unreviewed: 'Unreviewed',
} as const;

export function RightsRecords({
  rights,
  revision,
}: {
  rights: readonly AdminRightsRecord[] | undefined;
  revision: number;
}) {
  if (!rights?.length)
    return (
      <p className="small muted">No permission evidence recorded for saved revision {revision}.</p>
    );
  return (
    <div className="rights-records">
      <p className="small muted">Permission records for saved revision {revision}</p>
      {rights.map((record) => (
        <details className="rights-record" key={record.scope}>
          <summary>
            <span>{scopes[record.scope]}</span>
            <strong className={`rights-status ${record.status}`}>{statuses[record.status]}</strong>
          </summary>
          <p className="original-text">{record.statement}</p>
          {record.sourceUrl && <p className="url-text">Evidence source: {record.sourceUrl}</p>}
          <p className="small muted">
            Recorded by {record.reviewerId} · {formatTime(record.reviewedAt)} · Reviewed revision{' '}
            {record.inputRevision}
          </p>
        </details>
      ))}
    </div>
  );
}

export function RightsPanel({
  api,
  draft,
  user,
  operations,
  blocked,
  recipeDirty,
  onDirty,
  onReauthenticate,
}: {
  api: AdminApi;
  draft: AdminDraft;
  user: AdminUser;
  operations: ReturnType<typeof useOperations>;
  blocked: boolean;
  recipeDirty: boolean;
  onDirty: (dirty: boolean) => void;
  onReauthenticate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [scope, setScope] = useState<AdminRightsScope>('recipe_text');
  const [status, setStatus] = useState<AdminRightsInput['status']>('unreviewed');
  const [statement, setStatement] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const canReview = user.role === 'reviewer' || user.role === 'administrator';
  const available: AdminRightsScope[] = [
    'recipe_text',
    ...(draft.photoUrl ? ['photo' as const] : []),
    ...(draft.input.videoUrl?.trim() ? ['video_embed' as const] : []),
  ];
  const fieldsBlocked = blocked || recipeDirty || !canReview;
  function reset() {
    setEditing(false);
    setScope('recipe_text');
    setStatus('unreviewed');
    setStatement('');
    setSourceUrl('');
  }
  useEffect(reset, [draft]);
  useEffect(() => {
    onDirty(editing);
    return () => onDirty(false);
  }, [editing, onDirty]);
  return (
    <section
      className="edit-section rights-panel"
      id="recipe-rights"
      aria-label="Rights and permissions"
    >
      <div className="section-intro">
        <span className="section-number">05</span>
        <div>
          <h2>Rights & permissions</h2>
          <p>Review the evidence for this saved recipe.</p>
        </div>
      </div>
      <p className="small muted">
        Record evidence for this draft’s exact content. Recording a decision does not itself grant
        legal permission, publish a recipe, or authorize other uses of a photo.
      </p>
      <RightsRecords rights={draft.rights} revision={draft.revision} />
      <p className="small muted">
        Changing reviewed content requires a new review for that scope. Restoring a revision clears
        its current permissions and approval; history keeps earlier records.
      </p>
      {!editing && canReview && (
        <button
          className="secondary"
          disabled={blocked || recipeDirty}
          onClick={() => setEditing(true)}
        >
          Record permission evidence
        </button>
      )}
      {recipeDirty && (
        <p className="small">Save recipe edits before recording permission evidence.</p>
      )}
      {!canReview && (
        <p className="small muted">A reviewer or administrator must record permission evidence.</p>
      )}
      {editing && (
        <form
          aria-label="Permission evidence form"
          onSubmit={(event) => {
            event.preventDefault();
            if (fieldsBlocked || !statement.trim() || !available.includes(scope)) return;
            const input: AdminRightsInput = {
              scope,
              status,
              statement,
              sourceUrl: sourceUrl.trim() || null,
            };
            void operations.run('rights', draft.draftId, (id) =>
              api.rights(draft.draftId, id, draft.revision, input),
            );
          }}
        >
          <fieldset disabled={fieldsBlocked}>
            <Field label="Content scope">
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as AdminRightsScope)}
              >
                {available.map((value) => (
                  <option key={value} value={value}>
                    {scopes[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Permission decision">
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as AdminRightsInput['status'])}
              >
                <option value="unreviewed">Unreviewed</option>
                <option value="permitted">Permitted</option>
                <option value="restricted">Restricted</option>
              </select>
            </Field>
            <Field
              label="Evidence statement"
              hint="Describe the permission, restriction, licence or remaining uncertainty. Do not include passwords or private credentials."
            >
              <textarea
                required
                maxLength={2000}
                rows={4}
                value={statement}
                onChange={(event) => setStatement(event.target.value)}
              />
            </Field>
            <Field label="Evidence source URL · optional">
              <input
                type="url"
                maxLength={2048}
                value={sourceUrl}
                onChange={(event) => setSourceUrl(event.target.value)}
              />
            </Field>
          </fieldset>
          <p className="small">
            Applies to saved revision {draft.revision}. This creates a new draft revision and
            records your identity and review time. Identity confirmation within the last 15 minutes
            is required.
          </p>
          {operations.error && <Notice tone="error">{operations.error}</Notice>}
          {operations.errorCode === 'reauth_required' && (
            <button type="button" className="secondary" onClick={onReauthenticate}>
              Confirm identity to continue
            </button>
          )}
          <div className="inline-actions">
            <button className="primary" type="submit" disabled={fieldsBlocked || !statement.trim()}>
              {operations.busy ? 'Recording…' : 'Record permission review'}
            </button>
            <button
              className="text-button"
              type="button"
              disabled={operations.busy || !!operations.pending}
              onClick={reset}
            >
              Discard permission form
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
