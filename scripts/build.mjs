import { mkdir, readFile, realpath, rename, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const destination = path.join(root, 'dist');
const files = [
  'index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js',
  'playback.js', 'export.js', 'storage.js', 'sw.js', 'manifest.webmanifest',
  'app-icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'
];

// Read and validate every source before changing the output directory.
const sources = await Promise.all(files.map(async name => {
  const source = await realpath(path.join(root, name));
  if (!source.startsWith(root + path.sep) || !(await stat(source)).isFile()) throw new Error('Некорректный исходный файл: ' + name);
  return { name, content: await readFile(source) };
}));
// Identical contents produce the same release, and any changed asset produces
// a new worker/cache. Normalize text so Windows and GitHub builds agree.
const fingerprint = createHash('sha256');
for (const source of sources) {
  if (!source.name.endsWith('.png')) source.content = Buffer.from(source.content.toString('utf8').replace(/\r\n/g, '\n'));
  fingerprint.update(source.name + '\0').update(source.content).update('\0');
}
const version = 'release-' + fingerprint.digest('hex').slice(0, 20);
const worker = sources.find(source => source.name === 'sw.js');
const marker = "const APP_VERSION = 'dev-v5';";
if (!worker.content.toString('utf8').includes(marker)) throw new Error('Не найден маркер версии Service Worker.');
worker.content = Buffer.from(worker.content.toString('utf8').replace(marker, `const APP_VERSION = '${version}';`));
await mkdir(destination, { recursive: true });
if (await realpath(destination) !== destination) throw new Error('Папка dist не должна быть ссылкой на другой каталог.');

// Replace only these known files; never recursively delete a user's directory.
// Temporary files and rename avoid following links or leaving half-written files.
for (const { name, content } of sources) {
  const temporary = path.join(destination, '.' + name + '.' + randomUUID() + '.tmp');
  let created = false;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    created = true;
    await rename(temporary, path.join(destination, name));
  } finally {
    if (created) {
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
console.log(`Готово: ${files.length} файлов в ${destination}`);
console.log('Версия приложения: ' + version);
console.log('Публикуйте содержимое dist на статическом HTTPS-хостинге. Личная библиотека в сборку не входит.');
