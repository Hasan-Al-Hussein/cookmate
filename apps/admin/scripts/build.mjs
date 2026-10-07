import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(app, 'dist');
await mkdir(output, { recursive: true });
await build({
  entryPoints: [path.join(app, 'web/main.tsx')],
  outdir: output,
  entryNames: 'app',
  bundle: true,
  tsconfig: path.join(app, 'tsconfig.json'),
  external: ['/admin/Newsreader-Regular.ttf', '/admin/Newsreader-Italic.ttf'],
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  minify: true,
  sourcemap: false,
  define: { 'process.env.NODE_ENV': '"production"' },
});
for (const [source, target] of [
  ['app-icon.png', 'brand.png'],
  ['Newsreader16pt-Regular.ttf', 'Newsreader-Regular.ttf'],
  ['Newsreader16pt-Italic.ttf', 'Newsreader-Italic.ttf'],
]) {
  await copyFile(path.join(app, '../mobile/assets/brand', source), path.join(output, target));
}
await writeFile(
  path.join(output, 'index.html'),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CookMate · Recipe studio</title><link rel="icon" href="/admin/brand.png"><link rel="stylesheet" href="/admin/app.css"></head><body><div id="root"></div><script type="module" src="/admin/app.js"></script></body></html>',
);
console.log('Built private admin web assets. No server started.');
