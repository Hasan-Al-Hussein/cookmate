import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';
import {
  assertBackupFileSize,
  assertBackupTextSize,
  exportDocumentDescriptor,
  BackupTransferError,
  type BackupTransfer,
  type ExportDocumentKind,
} from './backupTransferTypes';

function removeOwnedCacheFile(file: File): boolean {
  const cachePrefix = `${Paths.cache.uri.replace(/\/$/, '')}/`;
  if (!file.uri.startsWith(cachePrefix)) return true;
  try {
    if (file.exists) file.delete();
    return true;
  } catch {
    return false;
  }
}

export function createBackupTransfer(documentKind: ExportDocumentKind = 'backup'): BackupTransfer {
  let disposed = false;
  return {
    async exportFile(serialized) {
      assertBackupTextSize(serialized);
      if (disposed || !(await Sharing.isAvailableAsync()))
        throw new BackupTransferError('unavailable');
      if (disposed) throw new BackupTransferError('unavailable');
      const descriptor = exportDocumentDescriptor(documentKind);
      const file = new File(Paths.cache, descriptor.filename);
      let owned = false;
      try {
        file.create({ overwrite: false });
        owned = true;
        file.write(serialized, { encoding: 'utf8' });
        await Sharing.shareAsync(file.uri, {
          mimeType: descriptor.mimeType,
          UTI: descriptor.uti,
          dialogTitle: descriptor.title,
        });
        // The API does not distinguish saving, sharing or dismissing the sheet.
        return 'share_sheet_closed';
      } catch {
        throw new BackupTransferError('export_failed');
      } finally {
        if (owned && !removeOwnedCacheFile(file)) throw new BackupTransferError('cleanup_failed');
      }
    },
    async pickFile() {
      if (disposed) return { kind: 'cancelled' };
      const selected = await DocumentPicker.getDocumentAsync({
        type: ['application/json', 'text/plain'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (selected.canceled) return { kind: 'cancelled' };
      const asset = selected.assets[0];
      if (!asset || selected.assets.length !== 1) throw new BackupTransferError('read_failed');
      const file = new File(asset.uri);
      try {
        if (disposed) return { kind: 'cancelled' };
        assertBackupFileSize(asset.size ?? file.size);
        assertBackupFileSize(file.size);
        const serialized = await file.text();
        if (disposed) return { kind: 'cancelled' };
        assertBackupTextSize(serialized);
        return { kind: 'selected', serialized };
      } catch (error) {
        throw error instanceof BackupTransferError ? error : new BackupTransferError('read_failed');
      } finally {
        // copyToCacheDirectory creates a temporary copy; the user's original is never removed.
        if (!removeOwnedCacheFile(file)) throw new BackupTransferError('cleanup_failed');
      }
    },
    dispose() {
      // Native picker/share UI cannot be forcibly dismissed; its owned copy is removed on return.
      disposed = true;
    },
  };
}
