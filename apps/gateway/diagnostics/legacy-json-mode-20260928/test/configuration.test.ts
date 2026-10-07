import assert from 'node:assert/strict';
import { test } from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { readGatewayConfiguration } from '../src/configuration';
import { createCredentialRegistry, createFileRegistryStorage } from '../src/registry';
import { GatewayError } from '../src/errors';

test('launcher configuration requires explicit approved model, private local state and TLS paths', () => {
  const local = path.resolve(os.tmpdir(), 'cookmate-config-fiction');
  const input = {
    GEMINI_API_KEY: 'fictional',
    GOOGLE_API_KEY: 'ignored',
    COOKMATE_MODEL: 'gemini-3.5-flash-lite',
    COOKMATE_TLS_CERT: path.join(local, 'certificate.pem'),
    COOKMATE_TLS_KEY: path.join(local, 'private.pem'),
    LOCALAPPDATA: local,
  };
  const parsed = readGatewayConfiguration(input);
  assert.equal(parsed.apiKey, 'fictional');
  assert.equal(parsed.host, '127.0.0.1');
  assert.equal(parsed.port, 3443);
  assert.equal(parsed.registryDirectory, path.join(local, 'CookMate', 'registry'));
  for (const override of [
    { GEMINI_API_KEY: '' },
    { COOKMATE_MODEL: 'auto' },
    { COOKMATE_TLS_KEY: '' },
    { COOKMATE_TLS_CERT: 'relative.pem' },
    { COOKMATE_PORT: '80' },
    { COOKMATE_BIND_HOST: 'https://example.invalid' },
  ])
    assert.throws(() => readGatewayConfiguration({ ...input, ...override }), GatewayError);
});

test('actual temporary file registry locks one writer, persists only hashes and reopens revoked state', async () => {
  const base = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'cookmate-gateway-fixture-'));
  let storage: Awaited<ReturnType<typeof createFileRegistryStorage>> | undefined;
  try {
    storage = await createFileRegistryStorage(directory);
    const registry = await createCredentialRegistry(storage);
    const client = await registry.issue();
    const disk = await readFile(path.join(directory, 'credentials.json'), 'utf8');
    assert.equal(disk.includes(client.token), false);
    await assert.rejects(
      createFileRegistryStorage(directory),
      (error: unknown) => error instanceof GatewayError && error.detail.code === 'storage_failure',
    );
    await registry.revoke(client.clientId);
    await storage.close();
    storage = await createFileRegistryStorage(directory);
    const restored = await createCredentialRegistry(storage);
    assert.throws(
      () => restored.authenticate(client.token),
      (error: unknown) => error instanceof GatewayError && error.detail.code === 'pairing_revoked',
    );
  } finally {
    await storage?.close();
    // Verify the exact disposable target before Windows recursive cleanup.
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('cookmate-gateway-fixture-'));
    await rm(resolved, { recursive: true, force: true });
  }
});

test('abrupt owned child exit leaves a lock; verified-dead-owner recovery preserves registry bytes and revocation', async () => {
  const base = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(base, 'cookmate-gateway-fixture-'));
  let reopened: Awaited<ReturnType<typeof createFileRegistryStorage>> | undefined;
  try {
    const script = `import {createFileRegistryStorage,createCredentialRegistry} from './apps/gateway/src/registry.ts'; const store=await createFileRegistryStorage(process.env.COOKMATE_FIXTURE_DIRECTORY); const registry=await createCredentialRegistry(store); const client=await registry.issue(); await registry.revoke(client.clientId); process.stdout.write(JSON.stringify(client)); process.exit(0);`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        windowsHide: true,
        env: {
          ...Object.fromEntries(
            Object.entries(process.env).filter(([key]) =>
              ['path', 'systemroot', 'windir', 'temp', 'tmp'].includes(key.toLowerCase()),
            ),
          ),
          COOKMATE_FIXTURE_DIRECTORY: directory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.resume();
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exitCode, 0);
    const client = JSON.parse(output) as { token: string };
    const lock = JSON.parse(await readFile(path.join(directory, 'credentials.lock'), 'utf8')) as {
      pid: number;
      instanceId: string;
    };
    assert.equal(lock.pid, child.pid);
    const before = await readFile(path.join(directory, 'credentials.json'), 'utf8');
    await assert.rejects(createFileRegistryStorage(directory), GatewayError);
    // Read-only process-existence probe; never terminates any process.
    assert.throws(
      () => process.kill(lock.pid, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
    );
    await unlink(path.join(directory, 'credentials.lock'));
    reopened = await createFileRegistryStorage(directory);
    const registry = await createCredentialRegistry(reopened);
    assert.equal(await readFile(path.join(directory, 'credentials.json'), 'utf8'), before);
    assert.throws(
      () => registry.authenticate(client.token),
      (error: unknown) => error instanceof GatewayError && error.detail.code === 'pairing_revoked',
    );
  } finally {
    await reopened?.close();
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), base);
    assert.ok(path.basename(resolved).startsWith('cookmate-gateway-fixture-'));
    await rm(resolved, { recursive: true, force: true });
  }
});
