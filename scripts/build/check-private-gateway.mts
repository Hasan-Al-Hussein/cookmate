import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';

// A finite local integration check. No real provider credential or user registry is loaded.
const [certificateDirectory, privateParent, host, resultPath] = process.argv.slice(2);
assert.ok(certificateDirectory && path.isAbsolute(certificateDirectory));
assert.ok(privateParent && path.isAbsolute(privateParent));
assert.ok(host && /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host));
assert.ok(resultPath && path.isAbsolute(resultPath));

const startedAt = new Date().toISOString();
const steps: string[] = [];
let currentStep = 'setup';
let providerFetchAttempts = 0;
let stopped = false;
let outcome = 'FAILED';
let gateway:
  | Awaited<ReturnType<typeof import('../../apps/gateway/src/launcher.ts').launchGateway>>
  | undefined;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  providerFetchAttempts++;
  throw new Error('External provider transport disabled for local integration');
};

const watchdog = setTimeout(() => process.exit(2), 60_000);
try {
  const { launchGateway } = await import('../../apps/gateway/src/launcher.ts');
  const { catalogue } = await import('@cookmate/catalogue');
  const { request: validRequest } = await import('../../apps/gateway/test/helpers.ts');
  const registryDirectory = await mkdtemp(path.join(privateParent, 'https-fixture-'));
  const ca = await readFile(path.join(certificateDirectory, 'ca.cert.pem'));
  const configuration = {
    apiKey: 'fictional-key-local-https-check',
    model: 'gemini-3.8-flash' as const,
    host,
    port: 3443,
    certificatePath: path.join(certificateDirectory, 'server.cert.pem'),
    privateKeyPath: path.join(certificateDirectory, 'server.key.pem'),
    registryDirectory,
  };

  async function send(method: string, route: string, body?: unknown, token?: string) {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise<{ status: number; body: any; noStore: boolean }>((resolve, reject) => {
      const req = https.request(
        {
          host,
          port: configuration.port,
          method,
          path: route,
          ca,
          rejectUnauthorized: true,
          agent: false,
          headers: {
            ...(payload === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(payload),
                }),
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('error', reject);
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 16_384) {
              response.destroy(new Error('Bounded response exceeded'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf8');
              resolve({
                status: response.statusCode ?? 0,
                body: text ? JSON.parse(text) : null,
                noStore: response.headers['cache-control'] === 'no-store',
              });
            } catch {
              reject(new Error('Invalid bounded JSON response'));
            }
          });
        },
      );
      const deadline = setTimeout(() => req.destroy(new Error('Local request deadline')), 5_000);
      req.on('close', () => clearTimeout(deadline));
      req.on('error', reject);
      req.end(payload);
    });
  }
  async function check(name: string, action: () => Promise<void>) {
    currentStep = name;
    await action();
    steps.push(name);
  }
  let token = '';
  await check('production_launcher_https_start', async () => {
    gateway = await launchGateway(configuration);
  });
  await check('trusted_https_health_and_no_store', async () => {
    const result = await send('GET', '/health');
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { status: 'ready', apiVersion: '2' });
    assert.equal(result.noStore, true);
  });
  await check('unauthenticated_denied', async () => {
    const result = await send('POST', '/v2/assistant/turn', {});
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'unauthenticated');
  });
  await check('one_use_pairing_over_https', async () => {
    const { code } = gateway!.pairing.openWindow();
    const result = await send('POST', '/v2/pair', { apiVersion: '2', code });
    assert.equal(result.status, 200);
    assert.equal(result.body.apiVersion, '2');
    assert.deepEqual(result.body.catalogue, catalogue.identity);
    assert.equal(
      typeof result.body.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(result.body.token),
      true,
    );
    token = result.body.token;
    const reused = await send('POST', '/v2/pair', { apiVersion: '2', code });
    assert.equal(reused.status, 401);
    assert.equal(reused.body.error.code, 'pairing_expired');
  });
  await check('authenticated_schema_validation', async () => {
    const result = await send('POST', '/v2/assistant/turn', {}, token);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, 'invalid_input');
  });
  await check('catalogue_drift_denied_before_provider', async () => {
    const result = await send(
      'POST',
      '/v2/assistant/turn',
      { ...validRequest(), catalogue: { ...catalogue.identity, fingerprint: 'a'.repeat(64) } },
      token,
    );
    assert.equal(result.status, 409);
    assert.equal(result.body.error.code, 'incompatible_version');
  });
  await check('self_revocation_over_https', async () => {
    assert.equal((await send('DELETE', '/v2/pairing', undefined, token)).status, 204);
    const result = await send('POST', '/v2/assistant/turn', {}, token);
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'pairing_revoked');
  });
  await check('launcher_restart_retains_revocation', async () => {
    await gateway!.close();
    gateway = undefined;
    const disk = await readFile(path.join(registryDirectory, 'credentials.json'), 'utf8');
    assert.equal(disk.includes(token), false);
    gateway = await launchGateway(configuration);
    const result = await send('POST', '/v2/assistant/turn', {}, token);
    assert.equal(result.status, 401);
    assert.equal(result.body.error.code, 'pairing_revoked');
  });
  await check('clean_close_releases_registry_lock', async () => {
    await gateway!.close();
    gateway = undefined;
    await assert.rejects(
      access(path.join(registryDirectory, 'credentials.lock')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
    stopped = true;
  });
  await check('zero_provider_transport_attempts', async () => {
    assert.equal(providerFetchAttempts, 0);
  });
  token = '';
  outcome = 'PASS';
} catch {
  // Keep any assertion operands, credentials and response bodies out of output/evidence.
  outcome = 'FAILED';
} finally {
  try {
    await gateway?.close();
    stopped = true;
  } catch {
    stopped = false;
    outcome = 'FAILED';
  }
  globalThis.fetch = originalFetch;
  clearTimeout(watchdog);
  await writeFile(
    resultPath,
    JSON.stringify(
      {
        startedAt,
        endedAt: new Date().toISOString(),
        outcome,
        passedSteps: steps,
        failedStep: outcome === 'PASS' ? null : currentStep,
        providerFetchAttempts,
        gatewayStopped: stopped,
        scope:
          'actual production launcher and real HTTPS; launcher recreation within one process; no iPhone, live Gemini or abrupt process-death proof',
      },
      null,
      2,
    ) + '\n',
    { flag: 'wx' },
  );
  process.stdout.write(
    JSON.stringify({
      outcome,
      passedChecks: steps.length,
      providerFetchAttempts,
      gatewayStopped: stopped,
    }) + '\n',
  );
  if (outcome !== 'PASS') process.exitCode = 1;
}
