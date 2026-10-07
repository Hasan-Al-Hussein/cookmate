import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isUtcInstant } from '@cookmate/contracts';
import { gatewayError } from './errors';
import { LIMITS } from './limits';

const runFile = promisify(execFile);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const permissionEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      ['systemroot', 'windir', 'path', 'temp', 'tmp'].includes(name.toLowerCase()),
    ),
  );

interface Credential {
  clientId: string;
  tokenHash: string;
  expiresAt: string;
  revoked: boolean;
}
interface Registry {
  version: 1;
  credentials: Credential[];
}
export interface RegistryStorage {
  read(): Promise<unknown | null>;
  write(value: unknown): Promise<void>;
}

function validRegistry(value: unknown): value is Registry {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'credentials,version' ||
    record.version !== 1 ||
    !Array.isArray(record.credentials)
  )
    return false;
  if (record.credentials.length > LIMITS.registryEntries) return false;
  const clients = new Set<string>();
  const hashes = new Set<string>();
  for (const item of record.credentials) {
    if (
      !item ||
      typeof item !== 'object' ||
      Object.keys(item).sort().join(',') !== 'clientId,expiresAt,revoked,tokenHash'
    )
      return false;
    if (
      typeof item.clientId !== 'string' ||
      !ID_PATTERN.test(item.clientId) ||
      clients.has(item.clientId)
    )
      return false;
    if (
      typeof item.tokenHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(item.tokenHash) ||
      hashes.has(item.tokenHash)
    )
      return false;
    if (
      typeof item.expiresAt !== 'string' ||
      !isUtcInstant(item.expiresAt) ||
      typeof item.revoked !== 'boolean'
    )
      return false;
    clients.add(item.clientId);
    hashes.add(item.tokenHash);
  }
  return true;
}

export async function protectPrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw gatewayError('storage_failure', 503, 'never');
  if (process.platform !== 'win32') {
    const { chmod } = await import('node:fs/promises');
    await chmod(directory, 0o700);
    return;
  }
  // The path is data in an environment variable, never interpolated PowerShell source.
  await runFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $p=[Environment]::GetEnvironmentVariable('COOKMATE_REGISTRY_DIRECTORY'); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Unexpected registry owner' }; $acl.SetAccessRuleProtection($true,$false); foreach($access in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($access) }; $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [System.IO.Directory]::SetAccessControl($p,$acl)",
    ],
    {
      windowsHide: true,
      timeout: 10_000,
      env: { ...permissionEnvironment(), COOKMATE_REGISTRY_DIRECTORY: directory },
    },
  ).catch(() => {
    throw gatewayError('storage_failure', 503, 'never');
  });
}

/** Parent directory is operator-owned private state, never the repository or a synced folder. */
export async function createFileRegistryStorage(
  directory: string,
): Promise<RegistryStorage & { close(): Promise<void> }> {
  if (!path.isAbsolute(directory)) throw gatewayError('storage_failure', 503, 'never');
  await protectPrivateDirectory(directory);
  const file = path.join(directory, 'credentials.json');
  const lockPath = path.join(directory, 'credentials.lock');
  // Exclusive process ownership avoids last-writer-wins credential resurrection.
  const lock = await open(lockPath, 'wx', 0o600).catch(() => {
    throw gatewayError('storage_failure', 503, 'never');
  });
  try {
    await lock.writeFile(
      JSON.stringify({
        version: 1,
        pid: process.pid,
        instanceId: randomUUID(),
        createdAt: new Date().toISOString(),
      }),
      'utf8',
    );
    await lock.sync();
  } catch {
    await lock.close();
    await unlink(lockPath);
    throw gatewayError('storage_failure', 503, 'never');
  }
  let closed = false;
  return {
    async read() {
      try {
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LIMITS.registryBytes)
          throw new Error();
        if (process.platform === 'win32') {
          await runFile('icacls.exe', [file, '/reset'], {
            windowsHide: true,
            timeout: 10_000,
            env: permissionEnvironment(),
          });
        } else {
          const { chmod } = await import('node:fs/promises');
          await chmod(file, 0o600);
        }
        return JSON.parse(await readFile(file, 'utf8')) as unknown;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw gatewayError('storage_failure', 503, 'never');
      }
    },
    async write(value) {
      const temporary = path.join(directory, `credentials-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(JSON.stringify(value), 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, file);
      } catch {
        await unlink(temporary).catch(() => undefined);
        throw gatewayError('storage_failure', 503, 'never');
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await lock.close();
      await unlink(lockPath);
    },
  };
}

export async function createCredentialRegistry(storage: RegistryStorage, now = Date.now) {
  let state: Registry;
  let failed = false;
  const loaded = await storage.read();
  if (loaded !== null && !validRegistry(loaded))
    throw gatewayError('storage_failure', 503, 'never');
  state = loaded === null ? { version: 1, credentials: [] } : structuredClone(loaded);
  if (loaded === null) await storage.write(state);
  let pending: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(clientId: string) => void>();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const operation = pending.then(work);
    pending = operation.catch(() => undefined);
    return operation;
  }
  async function commit(next: Registry) {
    try {
      await storage.write(next);
      state = next;
    } catch {
      failed = true;
      for (const credential of state.credentials)
        for (const listener of listeners) listener(credential.clientId);
      throw gatewayError('storage_failure', 503, 'never');
    }
  }
  function authenticate(token: string) {
    if (failed) throw gatewayError('storage_failure', 503, 'never');
    if (!/^[A-Za-z0-9_-]{43}$/.test(token))
      throw gatewayError('unauthenticated', 401, 'after_reconnect');
    const digest = createHash('sha256').update(token).digest();
    const entry = state.credentials.find((item) =>
      timingSafeEqual(Buffer.from(item.tokenHash, 'hex'), digest),
    );
    if (!entry) throw gatewayError('unauthenticated', 401, 'after_reconnect');
    if (entry.revoked) throw gatewayError('pairing_revoked', 401, 'after_reconnect');
    if (Date.parse(entry.expiresAt) <= now())
      throw gatewayError('pairing_expired', 401, 'after_reconnect');
    return { clientId: entry.clientId, expiresAt: entry.expiresAt };
  }
  return {
    authenticate,
    listClients() {
      return state.credentials.map(({ clientId, expiresAt, revoked }) => ({
        clientId,
        expiresAt,
        revoked,
      }));
    },
    issue: () =>
      serialize(async () => {
        if (failed) throw gatewayError('storage_failure', 503, 'never');
        const entries = state.credentials.filter((item) => Date.parse(item.expiresAt) > now());
        if (entries.length >= LIMITS.registryEntries)
          throw gatewayError('busy', 503, 'after_delay');
        const token = randomBytes(32).toString('base64url');
        const entry: Credential = {
          clientId: randomUUID(),
          tokenHash: createHash('sha256').update(token).digest('hex'),
          expiresAt: new Date(now() + LIMITS.tokenLifetimeMs).toISOString(),
          revoked: false,
        };
        await commit({ version: 1, credentials: [...entries, entry] });
        return { clientId: entry.clientId, token, expiresAt: entry.expiresAt };
      }),
    revoke: (clientId: string) =>
      serialize(async () => {
        if (failed) throw gatewayError('storage_failure', 503, 'never');
        if (!state.credentials.some((item) => item.clientId === clientId)) return false;
        await commit({
          version: 1,
          credentials: state.credentials.map((item) =>
            item.clientId === clientId ? { ...item, revoked: true } : item,
          ),
        });
        for (const listener of listeners) listener(clientId);
        return true;
      }),
    onRevoked(listener: (clientId: string) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
export type CredentialRegistry = Awaited<ReturnType<typeof createCredentialRegistry>>;
