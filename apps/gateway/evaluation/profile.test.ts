import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { identity } from '../../../packages/catalogue/src';
import { removeFixtureDirectory } from '../../../packages/domain/test/helpers/sqlite';
import { CASE_IDS, loadEvaluationPlan, ORDER, sha256 } from './plan';
import { inputManifest, prepareScreen, writeExclusive } from './prepare';
import { ProfileAdmissionError, selectProfile } from './profiles';
import { runScreen, verifyActivation } from './runner';
import { verifyOfflineRunner } from './verify';

const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const docsRoot = process.env.COOKMATE_EVALUATION_DOCS_ROOT;
assert.ok(docsRoot, 'Set COOKMATE_EVALUATION_DOCS_ROOT to the reviewed CookMate document root.');
const selected = 'source-amendment-v2';

async function temporary(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'cookmate-sqlite-profile-'));
  t.after(() => removeFixtureDirectory(root));
  return root;
}
const rejectsCode = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ProfileAdmissionError);
  assert.equal(error.code, code);
  return true;
};
async function fixtureDocs(t: TestContext) {
  const root = await temporary(t);
  for (const id of ['assistant-evaluation.v1', selected]) {
    const profile = selectProfile(id);
    for (const input of [profile.fixture, ...profile.documents, profile.validationReport!]) {
      const target = join(root, input.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(docsRoot!, input.path), target);
    }
  }
  return root;
}
function activation(profileId: string, path: string, digest: string) {
  return {
    status: 'APPROVED_BY_BRAIN',
    profileId,
    syntheticFixturesOnly: true,
    maxHttpRequests: 80,
    maxJudgedCases: 16,
    maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 40, 'gemini-3.8-flash': 40 },
    quietPeriodMs: 65_000,
    expiresAt: Date.now() + 3_600_000,
    caseIds: CASE_IDS,
    order: ORDER,
    runId: 'cookmate-screen-profile-check',
    inputManifestPath: path,
    inputManifestSha256: digest,
  };
}

test('profile selection is explicit and valid v2 pins preserve the fixed paired screen', async () => {
  assert.throws(() => selectProfile(undefined), rejectsCode('profile_required'));
  assert.throws(() => selectProfile('latest'), rejectsCode('unknown_profile'));
  assert.throws(() => selectProfile('assistant-evaluation.v2'), rejectsCode('unknown_profile'));
  const plan = await loadEvaluationPlan(codeRoot, docsRoot!, selected);
  assert.equal(plan.profile.id, selected);
  assert.deepEqual(plan.profile.catalogue.identity, identity);
  assert.deepEqual(
    plan.cases.map((item) => item.id),
    CASE_IDS,
  );
  assert.deepEqual(
    plan.cases.map((item) => item.stratum),
    [...'ABCDEFGH'],
  );
  assert.equal(ORDER.length, 16);
  assert.ok(plan.profile.validationReport!.path.includes('/runs/build-01/'));
  assert.ok(
    plan.profile.documents.some((input) => input.role === 'historical_authored_not_run_report'),
  );
  plan.profile.fixture.sha256 = 'changed-local-copy';
  assert.notEqual(selectProfile(selected).fixture.sha256, 'changed-local-copy');
});

test('fixture corruption and active document changes reject before setup', async (t) => {
  const localDocs = await fixtureDocs(t);
  const profile = selectProfile(selected);
  const fixturePath = join(localDocs, profile.fixture.path);
  const original = await readFile(fixturePath);
  await writeFile(fixturePath, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(
    loadEvaluationPlan(codeRoot, localDocs, selected),
    rejectsCode('document_changed:fixture'),
  );
  await writeFile(fixturePath, original);
  for (const role of ['rules', 'control_identity_input', 'control_harness']) {
    const input = profile.documents.find((item) => item.role === role)!;
    const path = join(localDocs, input.path);
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from('\n')]));
    await assert.rejects(
      loadEvaluationPlan(codeRoot, localDocs, selected),
      rejectsCode(`document_changed:${role}`),
    );
    await writeFile(path, bytes);
  }
});

test('catalogue and imported provenance bytes are bound separately', async (t) => {
  const localCode = await temporary(t);
  const root = join(localCode, 'packages/catalogue/generated');
  await mkdir(root, { recursive: true });
  for (const name of ['catalogue.json', 'provenance.json'])
    await copyFile(join(codeRoot, 'packages/catalogue/generated', name), join(root, name));
  for (const [name, code] of [
    ['catalogue.json', 'catalogue_source_changed'],
    ['provenance.json', 'provenance_source_changed'],
  ] as const) {
    const path = join(root, name);
    const bytes = await readFile(path);
    await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
    await assert.rejects(loadEvaluationPlan(localCode, docsRoot!, selected), rejectsCode(code));
    await writeFile(path, bytes);
  }
});

test('Q27: actual pinned v1 fixture reaches v2 identity rejection in every entry before setup/dispatch', async (t) => {
  const root = await temporary(t);
  const old = selectProfile('assistant-evaluation.v1');
  assert.equal(sha256(await readFile(join(docsRoot!, old.fixture.path))), old.fixture.sha256);
  assert.equal(identity.version, 'cookmate-2026-09-28.v2');
  let transportEntries = 0;
  let keyReads = 0;
  const path = join(root, 'activation.json');
  await writeExclusive(
    path,
    activation(old.id, join(root, 'not-read-inputs.json'), '0'.repeat(64)),
  );
  const directOptions = {
    profileId: old.id,
    docsRoot: docsRoot!,
    outputDirectory: join(root, 'direct'),
    get apiKey() {
      keyReads++;
      return 'FICTIONAL_EVALUATION_MARKER';
    },
    transport: (async () => {
      transportEntries++;
      throw new Error('unexpected_transport');
    }) as typeof fetch,
    transportKind: 'injected_synthetic' as const,
    // Deliberately no usable manifest: identity must reject before this later boundary is read.
    activation: {
      profileId: old.id,
      runId: 'cookmate-screen-q27-control',
      manifest: null,
      manifestSha256: '0'.repeat(64),
    } as unknown as Awaited<ReturnType<typeof verifyActivation>>,
  };
  for (const operation of [
    () => prepareScreen(docsRoot!, join(root, 'prepare'), old.id),
    () => verifyActivation(path, docsRoot!, codeRoot),
    () => runScreen(directOptions),
    () => verifyOfflineRunner(docsRoot!, join(root, 'offline'), old.id),
  ])
    await assert.rejects(operation(), rejectsCode('catalogue_identity_mismatch'));
  assert.deepEqual(await readdir(root), ['activation.json']);
  assert.equal(transportEntries, 0);
  assert.equal(keyReads, 0);
  t.diagnostic(
    JSON.stringify({
      control: 27,
      rejection: 'catalogue_identity_mismatch',
      runtimeIdentity: identity,
      validFixtureSha256: old.fixture.sha256,
      entryPaths: 4,
      createdSetupOrOutputDirectories: 0,
      transportEntries,
      keyReads,
      consumedMarkers: 0,
    }),
  );
});

test('active manifest binds executable dependencies, and activation rejects profile/input drift', async (t) => {
  const root = await temporary(t);
  const manifest = await inputManifest(codeRoot, docsRoot!, selected);
  const manifestPath = join(root, 'inputs.json');
  const activationPath = join(root, 'activation.json');
  const required = [
    'node_modules/tsx/dist/loader.mjs',
    'node_modules/tsx/dist/cjs/index.cjs',
    'node_modules/esbuild/lib/main.js',
    'node_modules/@esbuild/win32-x64/esbuild.exe',
    'node_modules/fast-deep-equal/index.js',
    'packages/catalogue/generated/provenance.json',
  ];
  for (const path of required)
    assert.ok(
      manifest.files.some((file) => file.base === 'codeRoot' && file.path === path),
      path,
    );
  const writeActivation = async (value: typeof manifest, profileId = selected) => {
    const bytes = JSON.stringify(value, null, 2) + '\n';
    await writeFile(manifestPath, bytes);
    await writeFile(
      activationPath,
      JSON.stringify(activation(profileId, manifestPath, sha256(bytes))),
    );
  };
  await writeActivation(manifest);
  assert.equal((await verifyActivation(activationPath, docsRoot!, codeRoot)).profileId, selected);
  const small = {
    ...activation(selected, manifestPath, sha256(await readFile(manifestPath))),
    maxJudgedCases: 4,
    maxHttpRequests: 20,
    maxHttpRequestsPerModel: { 'gemini-3.5-flash-lite': 10, 'gemini-3.8-flash': 10 },
  };
  await writeFile(activationPath, JSON.stringify(small));
  assert.equal(
    (await verifyActivation(activationPath, docsRoot!, codeRoot)).allowance.maxJudgedCases,
    4,
  );
  for (const path of [
    'node_modules/fast-deep-equal/index.js',
    'node_modules/tsx/dist/loader.mjs',
    'implementation/quality/source-amendment-v2.rules.mjs',
  ]) {
    const changed = structuredClone(manifest);
    changed.files.find((file) => file.path === path)!.sha256 = '0'.repeat(64);
    await writeActivation(changed);
    await assert.rejects(
      verifyActivation(activationPath, docsRoot!, codeRoot),
      /frozen_source_changed/,
    );
  }
  const other = structuredClone(manifest);
  other.profile = selectProfile('assistant-evaluation.v1');
  await writeActivation(other);
  await assert.rejects(
    verifyActivation(activationPath, docsRoot!, codeRoot),
    /activation_profile_mismatch/,
  );
  await writeActivation(manifest);
  const oldActivation = activation(selected, manifestPath, sha256(await readFile(manifestPath)));
  await writeFile(activationPath, JSON.stringify({ ...oldActivation, profileId: undefined }));
  await assert.rejects(
    verifyActivation(activationPath, docsRoot!, codeRoot),
    rejectsCode('profile_required'),
  );
  assert.deepEqual((await readdir(root)).sort(), ['activation.json', 'inputs.json']);
});
