import { mkdir, readFile, realpath, rename, stat, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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
console.log('Публикуйте содержимое dist на статическом HTTPS-хостинге. Личная библиотека в сборку не входит.');
