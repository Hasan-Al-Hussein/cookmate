import {
  assertBackupFileSize,
  assertBackupTextSize,
  exportDocumentDescriptor,
  BackupTransferError,
  type BackupTransfer,
  type ExportDocumentKind,
} from './backupTransferTypes';

export function createBackupTransfer(documentKind: ExportDocumentKind = 'backup'): BackupTransfer {
  let disposed = false;
  let cancelPicker: (() => void) | null = null;
  const downloads = new Map<string, ReturnType<typeof setTimeout>>();
  const releaseDownload = (url: string) => {
    clearTimeout(downloads.get(url));
    downloads.delete(url);
    URL.revokeObjectURL(url);
  };
  return {
    async copyText(serialized) {
      assertBackupTextSize(serialized);
      if (
        disposed ||
        typeof navigator === 'undefined' ||
        typeof navigator.clipboard?.writeText !== 'function'
      ) {
        throw new BackupTransferError('unavailable');
      }
      // No execCommand fallback or clipboard read: a fulfilled browser write is the only success.
      await navigator.clipboard.writeText(serialized);
    },
    async exportFile(serialized) {
      assertBackupTextSize(serialized);
      if (disposed || typeof document === 'undefined') throw new BackupTransferError('unavailable');
      const descriptor = exportDocumentDescriptor(documentKind);
      const blob = new Blob([serialized], { type: `${descriptor.mimeType};charset=utf-8` });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      try {
        anchor.href = url;
        anchor.download = descriptor.filename;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        downloads.set(
          url,
          setTimeout(() => releaseDownload(url), 1000),
        );
        return 'download_requested';
      } catch {
        releaseDownload(url);
        throw new BackupTransferError('export_failed');
      } finally {
        anchor.remove();
      }
    },
    pickFile() {
      if (disposed || typeof document === 'undefined')
        return Promise.resolve({ kind: 'cancelled' });
      cancelPicker?.();
      return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';
        input.multiple = false;
        input.style.display = 'none';
        let settled = false;
        let reading = false;
        let focusTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(focusTimer);
          input.removeEventListener('change', change);
          input.removeEventListener('cancel', cancel);
          window.removeEventListener('focus', focus);
          input.remove();
          if (cancelPicker === cancel) cancelPicker = null;
        };
        const cancel = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ kind: 'cancelled' });
        };
        const focus = () => {
          // Older browsers may emit focus instead of cancel; allow their change event to arrive.
          focusTimer = setTimeout(() => {
            if (!reading && !input.files?.length) cancel();
          }, 350);
        };
        const change = async () => {
          if (settled || reading) return;
          const file = input.files?.[0];
          if (!file) return cancel();
          reading = true;
          try {
            if (input.files?.length !== 1) throw new BackupTransferError('read_failed');
            assertBackupFileSize(file.size);
            const serialized = await file.text();
            if (settled) return;
            if (disposed) return cancel();
            assertBackupTextSize(serialized);
            settled = true;
            cleanup();
            resolve({ kind: 'selected', serialized });
          } catch (error) {
            if (settled) return;
            settled = true;
            cleanup();
            reject(
              error instanceof BackupTransferError ? error : new BackupTransferError('read_failed'),
            );
          }
        };
        cancelPicker = cancel;
        input.addEventListener('change', change);
        input.addEventListener('cancel', cancel);
        window.addEventListener('focus', focus);
        document.body.appendChild(input);
        try {
          input.click();
        } catch {
          settled = true;
          cleanup();
          reject(new BackupTransferError('unavailable'));
        }
      });
    },
    dispose() {
      disposed = true;
      cancelPicker?.();
      for (const url of downloads.keys()) releaseDownload(url);
    },
  };
}
