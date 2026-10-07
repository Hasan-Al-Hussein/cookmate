import { useEffect, useRef, useState } from 'react';
import type { AdminAsset, AdminDraft } from '../src/contracts';
import { AdminApi, ApiError, errorMessage } from './api';
import { Dialog, Notice, Photo } from './components';
import {
  forgetUploadReference,
  readUploadReference,
  rememberUploadReference,
} from './uploadRecovery';

export function PhotoEditor({
  api,
  draft,
  asset,
  blocked,
  onAsset,
  onBusy,
  userId,
}: {
  api: AdminApi;
  draft: AdminDraft;
  asset: AdminAsset | null;
  blocked: boolean;
  onAsset: (asset: AdminAsset) => void;
  onBusy: (busy: boolean) => void;
  userId: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const operation = useRef<{ id: string; file: File | null; revision: number } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      const reference = readUploadReference(sessionStorage, draft.draftId);
      if (reference && reference.userId !== userId)
        throw new Error('Another actor owns this reference');
      // Account changes can temporarily hide an editor. A fresh valid read releases
      // the previous actor/storage gate without replacing the retained operation.
      setStorageBlocked(false);
      setError(null);
      if (!reference) return;
      operation.current = {
        id: reference.operationId,
        file: operation.current?.id === reference.operationId ? operation.current.file : null,
        revision: reference.expectedRevision,
      };
      setUncertain(true);
    } catch {
      setStorageBlocked(true);
      setError(
        'Upload recovery storage is unreadable or belongs to another account. It was not changed. New uploads are blocked.',
      );
    }
  }, [draft.draftId, userId]);
  useEffect(() => {
    onBusy(busy || uncertain);
    return () => onBusy(false);
  }, [busy, uncertain, onBusy]);
  async function upload() {
    if (!file || busy || blocked || storageBlocked) return;
    const attempt = operation.current ?? {
      id: crypto.randomUUID(),
      file,
      revision: draft.revision,
    };
    operation.current = attempt;
    attempt.file ??= file;
    const reference = {
      operationId: attempt.id,
      userId,
      draftId: draft.draftId,
      expectedRevision: attempt.revision,
    };
    try {
      rememberUploadReference(sessionStorage, reference);
    } catch {
      setStorageBlocked(true);
      setError('The upload recovery reference could not be saved. Nothing was uploaded.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.upload(draft.draftId, attempt.id, attempt.revision, attempt.file);
      if (!active.current) return;
      onAsset(result);
      try {
        forgetUploadReference(sessionStorage, reference);
      } catch {
        setStorageBlocked(true);
        setError(
          'The upload is confirmed, but its recovery reference could not be removed. No new upload will start.',
        );
      }
      setUncertain(false);
      setFile(null);
      operation.current = null;
    } catch (failure) {
      if (!active.current) return;
      setError(errorMessage(failure));
      const unknown = !(failure instanceof ApiError) || failure.uncertain || uncertain;
      setUncertain(unknown);
      if (!unknown) {
        try {
          forgetUploadReference(sessionStorage, reference);
          operation.current = null;
        } catch {
          setStorageBlocked(true);
        }
      }
    } finally {
      if (active.current) {
        setBusy(false);
      }
    }
  }
  return (
    <section className="photo-editor">
      <Photo url={asset?.photoUrl ?? draft.photoUrl} title={draft.input.title || 'Recipe photo'} />
      <div className="photo-editor-copy">
        <p className="eyebrow">RECIPE PHOTOGRAPH</p>
        <h3>A real photo, matched to this recipe.</h3>
        <p className="muted">
          Choose one JPEG, PNG or WebP, up to 10 MiB. Uploading prepares the photo; Save draft
          attaches it.
        </p>
        <label className="file-picker">
          Choose a photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={blocked || busy || storageBlocked}
            onChange={(event) => {
              const selected = event.target.files?.[0];
              event.target.value = '';
              setError(null);
              if (!selected) return;
              if (
                selected.size > 10 * 1024 * 1024 ||
                !['image/jpeg', 'image/png', 'image/webp'].includes(selected.type)
              ) {
                setError('Choose a JPEG, PNG or WebP no larger than 10 MiB.');
                return;
              }
              setFile(selected);
              if (!uncertain) operation.current = null;
              else if (operation.current) operation.current.file = selected;
            }}
          />
        </label>
        {file && (
          <p className="small">
            {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MiB
          </p>
        )}
        {file && (
          <button
            className="secondary"
            disabled={blocked || busy || storageBlocked}
            onClick={() => void upload()}
          >
            {busy ? 'Uploading…' : uncertain ? 'Retry this exact upload' : 'Upload photo'}
          </button>
        )}
        {asset && (
          <p className="upload-result">
            Uploaded · {asset.width} × {asset.height} · Rights {asset.rightsStatus}. Save the draft
            to attach this asset.
          </p>
        )}
        {uncertain && (
          <Notice title="Upload outcome unconfirmed">
            The recipe photo has not been attached. Retry the same file and operation to recover its
            upload result. After a reload, select that exact file again; the server checks its bytes
            against any stored operation. Draft receipt lookup does not recover uploads.
            <code>{operation.current?.id}</code>
            <button className="text-button" disabled={busy} onClick={() => setAbandon(true)}>
              Leave this upload unattached
            </button>
          </Notice>
        )}
        {error && <Notice tone="error">{error}</Notice>}
        {abandon && (
          <Dialog title="Leave the upload unattached?" onClose={() => setAbandon(false)}>
            <p>
              The server may have stored a photo, but it has not been attached to this recipe.
              Leaving this attempt will not replace the recipe photo or remove a stored asset. The
              selected file and retry reference will be forgotten in this tab.
            </p>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setAbandon(false)}>
                Keep upload for retry
              </button>
              <button
                className="primary"
                onClick={() => {
                  try {
                    if (operation.current)
                      forgetUploadReference(sessionStorage, {
                        operationId: operation.current.id,
                        userId,
                        draftId: draft.draftId,
                        expectedRevision: operation.current.revision,
                      });
                    operation.current = null;
                    setFile(null);
                    setError(null);
                    setUncertain(false);
                    setAbandon(false);
                  } catch {
                    setStorageBlocked(true);
                    setError('The upload reference could not be removed. It is retained.');
                    setAbandon(false);
                  }
                }}
              >
                Leave unattached
              </button>
            </div>
          </Dialog>
        )}
      </div>
    </section>
  );
}
