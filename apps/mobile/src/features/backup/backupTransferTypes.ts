import { PORTABLE_BACKUP_MAX_BYTES, portableBackupByteLength } from '@cookmate/domain';

export type BackupTransferFailure =
  | 'too_large'
  | 'unavailable'
  | 'read_failed'
  | 'export_failed'
  | 'cleanup_failed';
export class BackupTransferError extends Error {
  constructor(public readonly reason: BackupTransferFailure) {
    super(`Backup file transfer: ${reason}`);
    this.name = 'BackupTransferError';
  }
}

export interface BackupTransfer {
  exportFile(serialized: string): Promise<'download_requested' | 'share_sheet_closed'>;
  /** Optional browser fallback. Call only from an explicit copy action. */
  copyText?(serialized: string): Promise<void>;
  pickFile(): Promise<{ kind: 'selected'; serialized: string } | { kind: 'cancelled' }>;
  dispose(): void;
}

export function assertBackupFileSize(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new BackupTransferError('read_failed');
  if (bytes > PORTABLE_BACKUP_MAX_BYTES) throw new BackupTransferError('too_large');
}

export function assertBackupTextSize(serialized: string) {
  if (serialized.length > PORTABLE_BACKUP_MAX_BYTES) throw new BackupTransferError('too_large');
  assertBackupFileSize(portableBackupByteLength(serialized));
}

export type ExportDocumentKind = 'backup' | 'conversation';

/** Fixed descriptors only: filenames and MIME types never come from private message text. */
export function exportDocumentDescriptor(kind: ExportDocumentKind = 'backup') {
  const conversation = kind === 'conversation';
  return {
    filename: `CookMate-${conversation ? 'conversation' : 'backup'}-${new Date().toISOString().replace(/[-:.]/g, '')}.${conversation ? 'txt' : 'json'}`,
    mimeType: conversation ? 'text/plain' : 'application/json',
    uti: conversation ? 'public.utf8-plain-text' : 'public.json',
    title: conversation ? 'Save your CookMate conversation' : 'Save your CookMate backup',
  };
}

export function backupFilename() {
  return exportDocumentDescriptor().filename;
}
