import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
for (const [entry, name] of [
  ['index.ts', 'cookmate-account'],
  ['deletionStatusEntry.ts', 'cookmate-account-deletion-status'],
]) {
  await build({
    entryPoints: [path.join(root, 'apps/account-service/src', entry)],
    outfile: path.join(root, 'supabase/functions', name, 'handler.js'),
    bundle: true,
    platform: 'browser',
    external: ['node:crypto'],
    target: 'es2022',
    format: 'esm',
    minify: false,
    sourcemap: false,
  });
}
console.log('Built server-only account and deletion-status handlers. Nothing deployed.');
