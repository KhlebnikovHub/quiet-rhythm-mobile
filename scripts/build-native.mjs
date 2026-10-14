import { mkdir, readFile, realpath, writeFile, rename, unlink, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

// Native apps carry their entire UI in the package. No live URL or web server.
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const output = path.join(root, 'native-dist');
await mkdir(output, { recursive: true });
if (await realpath(output) !== output) throw new Error('native-dist must not be a link.');
const files = ['index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js',
  'playback.js', 'export.js', 'storage.js', 'app-icon.svg',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
const config = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
if (config.server?.url || config.server?.allowNavigation?.length) throw new Error('Native app must use bundled files only.');

for (const name of files) {
  let data = await readFile(path.join(root, name));
  if (name === 'index.html') {
    data = data.toString('utf8').replace(/^[ \t]*<link rel="manifest" href="manifest.webmanifest">\r?\n/m, '')
      .replace('  <script defer src="app.js"></script>', '  <script defer src="native.js"></script>\n  <script defer src="app.js"></script>');
  }
  const temporary = path.join(output, '.' + name + '.' + randomUUID() + '.tmp');
  try { await writeFile(temporary, data, { flag: 'wx' }); await rename(temporary, path.join(output, name)); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
await build({ entryPoints: [path.join(root, 'native/bridge.js')], bundle: true,
  format: 'iife', platform: 'browser', target: ['chrome100', 'safari15'],
  outfile: path.join(output, 'native.js'), minify: true, legalComments: 'none' });
console.log('Native UI is bundled in mobile/native-dist; internet is not required to launch.');
// Keep the small export plugins identical to their reviewed source templates.
for (const [source, destination] of [
  ['native/android/ExportFilePlugin.java', 'android/app/src/main/java/com/hangcreator/mobile/ExportFilePlugin.java'],
  ['native/ios/ExportFilePlugin.swift', 'ios/App/App/ExportFilePlugin.swift']
]) {
  try { await access(path.dirname(path.join(root, destination))); }
  catch { continue; } // cap add can be run after the first bundle.
  await copyFile(path.join(root, source), path.join(root, destination));
}
