import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
export function adminStateDirectory(): string {
  const local = process.env.LOCALAPPDATA;
  if (!local || !path.isAbsolute(local))
    throw new Error('A local application-data directory is required.');
  return path.join(local, 'CookMate', 'admin');
}
/** Administrative secrets stay outside the repository and synced project documents. */
export async function protectAdminDirectory(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) throw new Error('Admin state requires an absolute directory.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe admin directory.');
  if (process.platform !== 'win32') {
    await chmod(directory, 0o700);
    return;
  }
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      ['systemroot', 'windir', 'path', 'temp', 'tmp'].includes(name.toLowerCase()),
    ),
  );
  await runFile(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference='Stop'; $p=[Environment]::GetEnvironmentVariable('COOKMATE_ADMIN_DIRECTORY'); $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=Get-Acl -LiteralPath $p; if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid) { throw 'Unexpected admin owner' }; $acl.SetAccessRuleProtection($true,$false); foreach($a in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($a) }; $r=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($r); [System.IO.Directory]::SetAccessControl($p,$acl)",
    ],
    { windowsHide: true, timeout: 10000, env: { ...env, COOKMATE_ADMIN_DIRECTORY: directory } },
  );
}
export async function lockAdminDirectory(directory: string): Promise<() => Promise<void>> {
  const file = path.join(directory, 'operator.lock');
  const handle = await open(file, 'wx', 0o600).catch(() => {
    throw new Error('Admin state is already in use or needs an operator lock check.');
  });
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
    );
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(file);
    throw error;
  }
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    await handle.close();
    await unlink(file);
  };
}
export async function readAdminSecret(directory: string): Promise<string> {
  const file = path.join(directory, 'session.key');
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 64)
    throw new Error('Admin signing configuration is unavailable.');
  const secret = await readFile(file, 'utf8');
  if (!/^[0-9a-f]{64}$/.test(secret)) throw new Error('Admin signing configuration is invalid.');
  return secret;
}
/** Called only by the explicit bootstrap CLI, never normal page load or launch. */
export async function createAdminSecret(directory: string): Promise<void> {
  try {
    await readAdminSecret(directory);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const handle = await open(path.join(directory, 'session.key'), 'wx', 0o600);
  try {
    await handle.writeFile(randomBytes(32).toString('hex'), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function assertRegularAdminFile(file: string): Promise<void> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe admin state file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
