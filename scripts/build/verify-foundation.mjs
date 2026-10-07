import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const evidenceRoot = fileURLToPath(new URL('./evidence/', import.meta.url));
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this through npm run verify:foundation.');
const commands = ['contracts:check', 'typecheck', 'test', 'mobile:check', 'format:check'];
if (process.argv.includes('--include-bundle')) commands.push('mobile:bundle');
mkdirSync(evidenceRoot, { recursive: true });
const recordedAt = new Date().toISOString();
// Every run owns a new directory; later checks must not overwrite earlier proof.
const evidenceDirectory = mkdtempSync(
  join(evidenceRoot, `run-${recordedAt.replaceAll(':', '-')}-`),
);
console.log(JSON.stringify({ evidenceDirectory }));
const report = {
  recordedAt,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  lockfileSha256: createHash('sha256')
    .update(readFileSync(new URL('../../package-lock.json', import.meta.url)))
    .digest('hex'),
  checks: [],
};
for (const command of commands) {
  const start = Date.now();
  const result = spawnSync(process.execPath, [npmCli, 'run', command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CI: '1',
      EXPO_NO_TELEMETRY: '1',
      NODE_OPTIONS: '--max-old-space-size=1536',
    },
  });
  const log = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const logName = `${command.replaceAll(':', '-')}.log`;
  writeFileSync(join(evidenceDirectory, logName), log, { flag: 'wx' });
  const record = {
    command: `npm run ${command}`,
    exitCode: result.status,
    signal: result.signal,
    milliseconds: Date.now() - start,
    log: logName,
  };
  report.checks.push(record);
  console.log(JSON.stringify(record));
  writeFileSync(
    join(evidenceDirectory, 'foundation-verification.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  if (result.status !== 0) {
    console.error(log.slice(-6000));
    process.exitCode = 1;
    break;
  }
}
