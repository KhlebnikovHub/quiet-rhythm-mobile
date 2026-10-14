import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { App } from '@capacitor/app';

const ExportFile = registerPlugin('ExportFile');
const FORMATS = { 'image/png': '.png', 'application/json': '.json', 'text/plain': '.txt' };

function blobBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл для экспорта.'));
    reader.onabort = () => reject(new DOMException('Экспорт отменён.', 'AbortError'));
    reader.onload = () => {
      const result = String(reader.result), separator = result.indexOf(';base64,');
      if (separator < 0) reject(new Error('Не удалось подготовить файл для экспорта.'));
      else resolve(result.slice(separator + 8));
    };
    reader.readAsDataURL(blob);
  });
}

function exportItem(input) {
  if (!input || !input.blob || typeof input.blob.arrayBuffer !== 'function') throw new Error('Нет файла для экспорта.');
  const mime = input.blob.type.split(';')[0].toLowerCase(), extension = FORMATS[mime];
  if (!extension) throw new Error('Поддерживаются файлы PNG, JSON и TXT.');
  let name = String(input.name || 'tablature').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, '_').trim().replace(/^[. ]+|[. ]+$/gu, '');
  if (name.toLowerCase().endsWith(extension)) name = name.slice(0, -extension.length);
  let stem = '';
  const encoder = new TextEncoder();
  for (const character of Array.from(name || 'tablature').slice(0, 100)) {
    if (encoder.encode(stem + character).length > 180) break;
    stem += character;
  }
  return { blob: input.blob, name: (stem || 'tablature') + extension, mime };
}

// Inject the platform boundary in tests; actual document rendering stays shared.
export function createNativeAdapter(dependencies = {}) {
  const capacitor = dependencies.capacitor || Capacitor;
  const filesystem = dependencies.filesystem || Filesystem;
  const directory = dependencies.directory || Directory;
  const share = dependencies.share || Share;
  const exporter = dependencies.exporter || ExportFile;
  const readBlob = dependencies.readBlob || blobBase64;
  const makeId = dependencies.makeId || (() => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
  const clock = dependencies.clock || Date.now;
  const isNative = capacitor.isNativePlatform();
  let busy = false;

  async function exclusive(operation) {
    if (!isNative) return false;
    if (busy) throw new Error('Дождитесь завершения текущего экспорта.');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function removePrepared(prepared) {
    for (const path of prepared.paths) {
      try { await filesystem.deleteFile({ directory: directory.Cache, path }); } catch (_) { /* Best-effort cache cleanup. */ }
    }
    try { await filesystem.rmdir({ directory: directory.Cache, path: prepared.folder }); } catch (_) { /* Only an empty folder. */ }
  }
  async function pruneOldExports() {
    // A share recipient may read after the chooser closes. Keep recent exports;
    // remove only this adapter's generated folders after at least seven days.
    try {
      const result = await filesystem.readdir({ directory: directory.Cache, path: 'exports' });
      for (const file of result.files) {
        if (file.type !== 'directory' || !/^\d{13}-[a-zA-Z0-9-]{1,80}$/u.test(file.name)) continue;
        if (clock() - Number(file.name.split('-')[0]) > 7 * 24 * 60 * 60 * 1000) {
          await filesystem.rmdir({ directory: directory.Cache, path: 'exports/' + file.name, recursive: true });
        }
      }
    } catch (_) { /* Missing cache or cleanup failure must not block export. */ }
  }
  async function prepare(items) {
    const id = String(makeId()).replace(/[^a-zA-Z0-9-]/gu, '').slice(0, 80);
    if (!id) throw new Error('Не удалось создать временный файл.');
    const prepared = { folder: 'exports/' + clock() + '-' + id, paths: [], uris: [] }, names = new Set();
    try {
      for (const item of items) {
        let name = item.name, suffix = 1;
        const extension = FORMATS[item.mime], stem = item.name.slice(0, -extension.length);
        while (names.has(name)) name = stem + '-' + (++suffix) + extension;
        names.add(name);
        const path = prepared.folder + '/' + name;
        prepared.paths.push(path);
        // Only one base64 representation is retained at a time.
        const data = await readBlob(item.blob);
        const result = await filesystem.writeFile({ directory: directory.Cache, path, data, recursive: true });
        if (!result || typeof result.uri !== 'string' || !result.uri.startsWith('file://')) throw new Error('Не удалось получить адрес подготовленного файла.');
        prepared.uris.push(result.uri);
      }
      return prepared;
    } catch (error) { await removePrepared(prepared); throw error; }
  }
  async function saveFile(blob, name) {
    return exclusive(async () => {
      const item = exportItem({ blob, name });
      await pruneOldExports();
      const prepared = await prepare([item]);
      try {
        const result = await exporter.save({ source: prepared.uris[0], name: item.name, mime: item.mime });
        if (!result || typeof result.saved !== 'boolean') throw new Error('Не удалось подтвердить сохранение файла.');
        return result.saved;
      } finally {
        // Native save resolves only after the destination is complete or cancelled.
        await removePrepared(prepared);
      }
    });
  }
  async function shareFiles(files, title = '') {
    return exclusive(async () => {
      if (!Array.isArray(files) || files.length < 1 || files.length > 8) throw new Error('За один раз можно отправить от 1 до 8 файлов.');
      const items = files.map(exportItem);
      if (!(await share.canShare()).value) throw new Error('На устройстве недоступно меню «Поделиться».');
      await pruneOldExports();
      const prepared = await prepare(items);
      try {
        await share.share({ files: prepared.uris, title: String(title).slice(0, 300), dialogTitle: 'Поделиться ритмом' });
        return true; // The flow completed; this does not assert the recipient saved it.
      } catch (error) {
        if (error?.name === 'AbortError' || /cancel(?:led|ed)?|dismissed/iu.test(error?.message || '')) return false;
        throw error;
      }
      // Do not delete here: another app may still be reading the files.
    });
  }
  return Object.freeze({ isNative, saveFile, shareFiles });
}

if (typeof window !== 'undefined') {
  window.HangNative = createNativeAdapter();
  if (window.HangNative.isNative) {
    App.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) window.dispatchEvent(new Event('hang-native-pause'));
    }).catch(() => {});
    if (Capacitor.getPlatform() === 'android') {
      App.addListener('backButton', () => {
        const handled = !window.dispatchEvent(new Event('hang-native-back', { cancelable: true }));
        if (!handled) App.minimizeApp().catch(() => {});
      }).catch(() => {});
    }
  }
}
