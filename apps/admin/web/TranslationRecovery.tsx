import { useState } from 'react';
import { Dialog, Notice } from './components';
import type { TranslationOperations } from './useTranslationOperations';

export function TranslationRecovery({
  operations,
  onReauthenticate,
}: {
  operations: TranslationOperations;
  onReauthenticate(): void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  return (
    <>
      {operations.error && (
        <Notice title="Translation needs attention" tone="error">
          {operations.error}
          {operations.errorCode === 'reauth_required' && (
            <button className="secondary" onClick={onReauthenticate}>
              Confirm identity for translation review
            </button>
          )}
        </Notice>
      )}
      {operations.storageError && (
        <Notice title="Translation recovery is blocked" tone="error">
          {operations.storageError}
        </Notice>
      )}
      {operations.notice && <Notice>{operations.notice}</Notice>}
      {operations.pending && (
        <Notice
          title={
            operations.busy ? 'Confirming translation change…' : 'Translation change is unconfirmed'
          }
        >
          <p>
            This tab retains the exact operation reference across reloads, without translated text
            or credentials. An absent receipt does not establish failure.
          </p>
          <code>{operations.pending.operationId}</code>
          {!operations.canRecover ? (
            <p>Sign in as the account that started this translation change to recover it.</p>
          ) : (
            <div className="inline-actions">
              <button
                className="secondary"
                disabled={operations.busy}
                onClick={() => void operations.check()}
              >
                Check translation receipt
              </button>
              {operations.canRetry && (
                <button
                  className="text-button"
                  disabled={operations.busy}
                  onClick={() => void operations.retry()}
                >
                  Retry exact translation request
                </button>
              )}
              <button
                className="text-button"
                disabled={operations.busy}
                onClick={() => setConfirm(operations.pending!.operationId)}
              >
                Resolve translation operation
              </button>
            </div>
          )}
        </Notice>
      )}
      {confirm && operations.pending?.operationId === confirm && operations.canRecover && (
        <Dialog
          title="Resolve this translation operation?"
          onClose={() => {
            if (!operations.busy) setConfirm(null);
          }}
        >
          <p>
            The server will return its committed receipt or durably cancel this exact operation.
            This does not delete a saved translation.
          </p>
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={operations.busy}
              onClick={() => setConfirm(null)}
            >
              Keep recovery reference
            </button>
            <button
              className="primary"
              disabled={operations.busy}
              onClick={() => {
                void operations.resolve().then(() => setConfirm(null));
              }}
            >
              Resolve exact translation operation
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
