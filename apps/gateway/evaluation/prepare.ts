import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materialize } from './materialize';
import { loadEvaluationPlan, ORDER, readPinnedDocument, sha256 } from './plan';
import { DEPENDENCY_INVENTORY } from './profiles';

export async function writeExclusive(path: string, value: unknown) {
  const file = await open(path, 'wx');
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + '\n');
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function inputManifest(codeRoot: string, docsRoot: string, profileId: unknown) {
  codeRoot = resolve(codeRoot);
  docsRoot = resolve(docsRoot);
  const { profile } = await loadEvaluationPlan(codeRoot, docsRoot, profileId);
  // These overrides can select executable/config files outside the reviewed installed inventory.
  for (const name of ['NODE_OPTIONS', 'ESBUILD_BINARY_PATH', 'TSX_TSCONFIG_PATH'])
    assert.ok(!process.env[name], `unsupported_runtime_override:${name}`);
  const paths = new Set<string>();
  async function tree(path: string, everyFile = false) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const next = join(path, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'manifest_symlink_requires_review');
      if (entry.isDirectory()) await tree(next, everyFile);
      else if (everyFile || /\.(?:ts|js|mjs|cjs|json|md)$/.test(entry.name)) paths.add(next);
    }
  }
  for (const path of [
    'apps/gateway/src',
    'apps/gateway/evaluation',
    'apps/mobile/src/assistant-core',
    'apps/mobile/src/connection',
    'apps/mobile/src/data',
    'apps/mobile/src/domain',
    'packages/contracts/src',
    'packages/contracts/schema',
    'packages/catalogue/src',
    'packages/domain/src',
  ])
    await tree(join(codeRoot, path));
  for (const path of [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'tsconfig.tools.json',
    'apps/gateway/tsconfig.json',
    'apps/mobile/tsconfig.json',
    'apps/mobile/tsconfig.node-tests.json',
    'packages/catalogue/tsconfig.json',
    'packages/contracts/tsconfig.json',
    'packages/domain/tsconfig.json',
    'apps/gateway/package.json',
    'apps/mobile/package.json',
    'packages/catalogue/package.json',
    'packages/contracts/package.json',
    'packages/domain/package.json',
    'packages/domain/test/helpers/sqlite.ts',
    'packages/catalogue/generated/catalogue.json',
    'packages/catalogue/generated/provenance.json',
    'packages/catalogue/reviewed-annotations.json',
  ])
    paths.add(join(codeRoot, path));
  for (const path of [
    'implementation/ai-gateway/EVALUATION_SCREEN_RUNNER_DESIGN.md',
    'implementation/ai-gateway/PRODUCTION_JSON_CANDIDATE_01_MANIFEST.json',
    'implementation/ai-gateway/PRODUCTION_JSON_CANDIDATE_01_IMPORT_AMENDMENT.json',
    'implementation/data/evaluation-materialization-map.md',
  ])
    paths.add(join(docsRoot, path));
  for (const input of [
    profile.fixture,
    ...profile.documents,
    profile.validationReport!,
    DEPENDENCY_INVENTORY,
  ])
    paths.add(join(docsRoot, input.path));
  const inventory = JSON.parse(
    (await readPinnedDocument(docsRoot, DEPENDENCY_INVENTORY)).toString('utf8'),
  ) as {
    runtimePackages: { path: string; name: string; version: string }[];
  };
  assert.equal(inventory.runtimePackages.length, 97, 'dependency_inventory_changed');
  // Reuse the reviewed package roots, but bind current bytes and all files, including .cjs/.exe.
  // Nothing in the historical preservation manifest is regenerated or relabelled.
  for (const dependency of inventory.runtimePackages) {
    const path = dependency.path.replaceAll('\\', '/');
    assert.ok(
      path.startsWith('node_modules/') && !isAbsolute(path) && !path.split('/').includes('..'),
      'dependency_inventory_path',
    );
    const root = resolve(codeRoot, path);
    assert.ok(root.startsWith(resolve(codeRoot) + sep), 'dependency_outside_code_root');
    const installed = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(installed.name, dependency.name, 'dependency_name_changed');
    assert.equal(installed.version, dependency.version, 'dependency_version_requires_review');
    await tree(root, true);
  }
  const files = [];
  for (const path of [...paths].sort()) {
    const bytes = await readFile(path);
    const base = path.startsWith(resolve(codeRoot) + sep) ? 'codeRoot' : 'docsRoot';
    files.push({
      base,
      path: relative(base === 'codeRoot' ? codeRoot : docsRoot, path).replaceAll('\\', '/'),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  const executable = await readFile(process.execPath);
  return {
    kind: 'cookmate-evaluation-input-manifest',
    node: process.version,
    order: ORDER,
    profile,
    runtime: {
      executable: process.execPath,
      sha256: sha256(executable),
      bytes: executable.length,
      platform: process.platform,
      arch: process.arch,
      dependencyInventorySha256: DEPENDENCY_INVENTORY.sha256,
    },
    files,
  };
}

export async function prepareScreen(docsRoot: string, outputDirectory: string, profileId: unknown) {
  const codeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const { cases, profile } = await loadEvaluationPlan(codeRoot, docsRoot, profileId);
  const manifest = await inputManifest(codeRoot, docsRoot, profileId);
  await mkdir(outputDirectory, { recursive: false });
  await writeExclusive(join(outputDirectory, 'inputs.json'), manifest);
  const results = [];
  for (const [index, pair] of ORDER.entries()) {
    const item = cases.find((candidate) => candidate.id === pair.caseId)!;
    const name = `${String(index + 1).padStart(2, '0')}-${pair.caseId}-${pair.model}`;
    let fixture: Awaited<ReturnType<typeof materialize>> | undefined;
    try {
      fixture = await materialize(join(outputDirectory, name), item);
      await writeExclusive(join(outputDirectory, `${name}.json`), { ...pair, ...fixture.artifact });
      results.push({
        ...pair,
        status: 'OFFLINE_SETUP_VERIFIED',
        artifact: `${name}.json`,
        liveCredit: false,
      });
    } catch (error) {
      // Only assertion labels from the local synthetic setup are retained; no provider is present.
      results.push({
        ...pair,
        status: 'BLOCKED_SETUP',
        reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown_setup_failure',
        liveCredit: false,
      });
    } finally {
      await fixture?.close();
    }
  }
  const report = {
    kind: 'cookmate-offline-screen-preparation',
    profile,
    network: 'DENIED',
    physicalHttpRequests: 0,
    judgedCasesRun: 0,
    allPrepared: results.every((result) => result.status === 'OFFLINE_SETUP_VERIFIED'),
    results,
  };
  assert.deepEqual(
    await inputManifest(codeRoot, docsRoot, profile.id),
    manifest,
    'run_inputs_changed',
  );
  await writeExclusive(join(outputDirectory, 'report.json'), report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, profileId, docsRoot, output] = process.argv.slice(2);
  if (mode !== '--offline' || !profileId || !docsRoot || !output || process.argv.length !== 6)
    throw new Error('usage: prepare.ts --offline <profile-id> <docs-root> <new-output-directory>');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('offline_network_denied');
  };
  try {
    const report = await prepareScreen(resolve(docsRoot), resolve(output), profileId);
    process.stdout.write(
      JSON.stringify({
        allPrepared: report.allPrepared,
        cases: report.results.length,
        providerCalls: 0,
      }) + '\n',
    );
    if (!report.allPrepared) process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
