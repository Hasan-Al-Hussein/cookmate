import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  assertRegularAdminFile,
  createAdminSecret,
  lockAdminDirectory,
  readAdminSecret,
} from '../src/privateState';
import { registerAdminAssets } from '../src/staticAssets';

async function withDirectory(run: (directory: string) => Promise<void>) {
  const temp = path.resolve(os.tmpdir());
  const directory = await mkdtemp(path.join(temp, 'cookmate-admin-state-test-'));
  try {
    await run(directory);
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), temp);
    assert.ok(path.basename(resolved).startsWith('cookmate-admin-state-test-'));
    await rm(resolved, { recursive: true, force: true });
  }
}
test('operator lock prevents duplicate ownership and clean release permits reopen', async () =>
  withDirectory(async (dir) => {
    const release = await lockAdminDirectory(dir);
    await assert.rejects(() => lockAdminDirectory(dir));
    await release();
    await release();
    await (
      await lockAdminDirectory(dir)
    )();
  }));
test('explicit bootstrap secret is preserved and malformed material is never overwritten', async () =>
  withDirectory(async (dir) => {
    await createAdminSecret(dir);
    const first = await readAdminSecret(dir);
    assert.match(first, /^[0-9a-f]{64}$/);
    await createAdminSecret(dir);
    assert.equal(await readAdminSecret(dir), first);
    await writeFile(path.join(dir, 'session.key'), 'invalid');
    await assert.rejects(() => createAdminSecret(dir));
    assert.equal(await readFile(path.join(dir, 'session.key'), 'utf8'), 'invalid');
  }));
test('a directory masquerading as a state file is refused', async () =>
  withDirectory(async (dir) => {
    const file = path.join(dir, 'admin.sqlite');
    await mkdir(file);
    await assert.rejects(() => assertRegularAdminFile(file));
  }));
test('admin shell has strict CSP and cannot expose arbitrary files', async () =>
  withDirectory(async (dir) => {
    await writeFile(path.join(dir, 'index.html'), '<div id="root"></div>');
    await writeFile(path.join(dir, 'private.txt'), 'synthetic private value');
    const app = Fastify();
    registerAdminAssets(app, dir);
    try {
      const response = await app.inject('/admin/');
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.doesNotMatch(
        String(response.headers['content-security-policy']),
        /unsafe-inline|unsafe-eval/,
      );
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.equal((await app.inject('/admin/private.txt')).statusCode, 404);
      const missing = await app.inject('/admin/app.js');
      assert.equal(missing.statusCode, 503);
      assert.ok(!missing.body.includes(dir));
    } finally {
      await app.close();
    }
  }));
