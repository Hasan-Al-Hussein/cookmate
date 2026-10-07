import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const base = new URL('./', import.meta.url);
const [npmCli, cache] = process.argv.slice(2);
assert.ok(npmCli && cache && path.isAbsolute(npmCli) && path.isAbsolute(cache), 'Pass absolute paths to the verified npm 11.20.0 npm-cli.js and an isolated cache.');
const version = execFileSync(process.execPath, [npmCli, '--version'], { encoding: 'utf8', windowsHide: true }).trim();
assert.equal(version, '11.20.0');
const provenance = JSON.parse(await readFile(new URL('provenance.json', base)));
for (const [file, expected] of Object.entries(provenance.sourceSha256)) {
  const bytes = await readFile(new URL(`upstream/${file}`, base));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
}
const original = await readFile(new URL('upstream/index.js', base), 'utf8');
const marker = 'export default function decodeUriComponent(encodedURI) {';
assert.equal(original.split(marker).length, 2);
await writeFile(new URL('upstream.cjs', base), "'use strict';\n" + original.replace(marker, 'module.exports = function decodeUriComponent(encodedURI) {'));
await writeFile(new URL('index.js', base), `'use strict';
const decode = require('./upstream.cjs');

// Preserve query-string 7's decoder contract, including fragments and repeated decoding.
module.exports = function decodeUriComponentCompat(input) {
  return decode(typeof input === 'string' ? input.replace(/\\+/g, ' ') : input);
};
`);
await writeFile(new URL('index.d.ts', base), 'declare function decodeUriComponentCompat(encodedURI: string): string;\nexport = decodeUriComponentCompat;\n');
await copyFile(new URL('upstream/index.d.ts', base), new URL('upstream.d.ts', base));
await copyFile(new URL('upstream/license', base), new URL('license', base));
const packed = JSON.parse(execFileSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--json', '--pack-destination', '..', '--cache', cache, '--offline'], { cwd: fileURLToPath(base), encoding: 'utf8', timeout: 30000, windowsHide: true }));
assert.equal(packed.length, 1);
assert.equal(packed[0].integrity, provenance.expectedArtifactIntegrity, 'Rebuilt package differs from the reviewed bytes');
console.log(JSON.stringify(packed, null, 2));
