/** Expo's failed OPFS pool cannot be repaired by reopening a SQL connection. */
export function requiresWebStorageReload(error: unknown): boolean {
  for (let depth = 0; depth < 4 && error instanceof Error; depth++) {
    if (
      error instanceof WebStorageRestartError ||
      /createSyncAccessHandle|Invalid VFS state|Access Handles cannot be created/i.test(
        error.message,
      )
    )
      return true;
    error = error.cause;
  }
  return false;
}

export class WebStorageRestartError extends Error {
  constructor() {
    super('Browser storage requires a document reload');
  }
}
