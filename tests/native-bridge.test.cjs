const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Evaluate the actual adapter with only native imports replaced by test doubles.
const source = fs.readFileSync(path.join(__dirname, '../native/bridge.js'), 'utf8')
  .replace(/^import .+;\r?$/gm, '').replace('export function createNativeAdapter', 'function createNativeAdapter');
class Reader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(bytes => {
      this.result = 'data:' + blob.type + ';base64,' + Buffer.from(bytes).toString('base64');
      this.onload();
    }, error => { this.error = error; this.onerror(); });
  }
}
function fixture(overrides = {}, window) {
  const events = [], listeners = {};
  let id = 0;
  const dependencies = {
    capacitor: { isNativePlatform: () => true, getPlatform: () => 'android' },
    filesystem: {
      readdir: async () => ({ files: [] }),
      writeFile: async options => { events.push(['write', options]); return { uri: 'file:///cache/' + options.path }; },
      deleteFile: async options => { events.push(['delete', options]); },
      rmdir: async options => { events.push(['rmdir', options]); }
    },
    directory: { Cache: 'CACHE' },
    exporter: { save: async options => { events.push(['save', options]); return { saved: true }; } },
    share: { canShare: async () => ({ value: true }), share: async options => { events.push(['share', options]); return {}; } },
    makeId: () => 'test-' + (++id), clock: () => 1700000000000,
    ...overrides
  };
  const context = vm.createContext({
    Capacitor: dependencies.capacitor, Filesystem: dependencies.filesystem, Directory: dependencies.directory,
    Share: dependencies.share, registerPlugin: () => dependencies.exporter,
    App: { addListener: (name, fn) => { listeners[name] = fn; return Promise.resolve({ remove() {} }); }, minimizeApp: async () => { events.push(['minimize']); } },
    Blob, FileReader: Reader, DOMException, TextEncoder, Event, ...(window ? { window } : {})
  });
  vm.runInContext(source, context, { filename: 'native/bridge.js' });
  return { adapter: context.createNativeAdapter(dependencies), events, listeners, dependencies, context };
}
const png = () => new Blob([Uint8Array.from([137, 80, 78, 71, 0, 255, 17])], { type: 'image/png' });

test('web adapter is inert and leaves browser exports to the app', async () => {
  const { adapter, events } = fixture({ capacitor: { isNativePlatform: () => false } });
  assert.equal(adapter.isNative, false);
  assert.equal(await adapter.saveFile(png(), 'a.png'), false);
  assert.equal(await adapter.shareFiles([{ blob: png(), name: 'a.png' }]), false);
  assert.equal(events.length, 0);
});

test('save preserves UTF-8 bytes, sanitizes filenames, and cleans only after native completion', async () => {
  const { adapter, events } = fixture();
  const content = JSON.stringify({ title: 'Тихий ритм 🎶', notes: 'Правой / левой' });
  assert.equal(await adapter.saveFile(new Blob([content], { type: 'application/json' }), '../Ритм/вечер.json'), true);
  assert.deepEqual(events.map(event => event[0]), ['write', 'save', 'delete', 'rmdir']);
  const written = events[0][1], saved = events[1][1];
  assert.equal(written.directory, 'CACHE');
  assert.equal(Buffer.from(written.data, 'base64').toString('utf8'), content);
  assert.match(written.path, /^exports\/1700000000000-test-1\/[^/]+\.json$/u);
  assert.equal(saved.source, 'file:///cache/' + written.path);
  assert.equal(saved.name, written.path.split('/').at(-1));
  assert.equal(saved.mime, 'application/json');
  assert.equal(events[3][1].recursive, undefined);
});

test('cancelled save returns false and a following save can succeed', async () => {
  let calls = 0;
  const { adapter, events } = fixture({ exporter: { save: async () => ({ saved: ++calls > 1 }) } });
  assert.equal(await adapter.saveFile(png(), 'a.png'), false);
  assert.equal(await adapter.saveFile(png(), 'a.png'), true);
  assert.equal(events.filter(event => event[0] === 'delete').length, 2);
});

test('overlapping system export dialogs are rejected until the first finishes', async () => {
  let finish, started;
  const opened = new Promise(resolve => { started = resolve; });
  const { adapter } = fixture({ exporter: { save: async () => { started(); return new Promise(resolve => { finish = resolve; }); } } });
  const first = adapter.saveFile(png(), 'a.png');
  await opened;
  await assert.rejects(adapter.saveFile(png(), 'b.png'), /Дождитесь/u);
  finish({ saved: true });
  assert.equal(await first, true);
});

test('multi-file share writes sequentially, disambiguates names, and retains recipient files', async () => {
  const { adapter, events, dependencies } = fixture();
  let active = 0, maximum = 0;
  const write = dependencies.filesystem.writeFile;
  dependencies.filesystem.writeFile = async options => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setImmediate(resolve));
    const result = await write(options);
    active--; return result;
  };
  assert.equal(await adapter.shareFiles(Array.from({ length: 8 }, () => ({ blob: png(), name: 'same.png' })), 'Ритм'), true);
  assert.equal(maximum, 1);
  assert.deepEqual(events.map(event => event[0]), [...Array(8).fill('write'), 'share']);
  const uris = events.at(-1)[1].files;
  assert.equal(new Set(uris).size, 8);
  assert.ok(uris.every(uri => uri.startsWith('file:///cache/exports/')));
  assert.deepEqual(Buffer.from(events[0][1].data, 'base64'), Buffer.from(await png().arrayBuffer()));
});

test('invalid and oversized batches do not write files', async () => {
  const { adapter, events } = fixture();
  await assert.rejects(adapter.shareFiles([]), /1 до 8/u);
  await assert.rejects(adapter.shareFiles(Array.from({ length: 9 }, () => ({ blob: png(), name: 'a.png' }))), /1 до 8/u);
  await assert.rejects(adapter.saveFile(new Blob(['x'], { type: 'text/html' }), 'x.html'), /PNG, JSON/u);
  assert.equal(events.length, 0);
});

test('a failed staging write cleans its partial batch and never invokes Share', async () => {
  const { adapter, events, dependencies } = fixture();
  const write = dependencies.filesystem.writeFile;
  let count = 0;
  dependencies.filesystem.writeFile = async options => {
    if (++count === 2) throw new Error('Disk full');
    return write(options);
  };
  await assert.rejects(adapter.shareFiles([{ blob: png(), name: 'a.png' }, { blob: png(), name: 'b.png' }]), /Disk full/u);
  assert.equal(events.filter(event => event[0] === 'share').length, 0);
  assert.equal(events.filter(event => event[0] === 'delete').length, 2);
});

test('share cancellation is quiet; genuine native errors and missing save confirmation propagate', async () => {
  const { adapter, dependencies } = fixture();
  dependencies.share.share = async () => { throw new Error('Share canceled'); };
  assert.equal(await adapter.shareFiles([{ blob: png(), name: 'a.png' }]), false);
  dependencies.share.share = async () => { throw new Error('FileProvider failed'); };
  await assert.rejects(adapter.shareFiles([{ blob: png(), name: 'a.png' }]), /FileProvider/u);
  dependencies.exporter.save = async () => ({});
  await assert.rejects(adapter.saveFile(png(), 'a.png'), /подтвердить/u);
});

test('cache pruning ignores recent and unrecognized folders; Unicode names stay within byte limit', async () => {
  const { adapter, events, dependencies } = fixture();
  dependencies.filesystem.readdir = async () => ({ files: [
    { name: '1600000000000-old-id', type: 'directory' },
    { name: '1700000000000-recent-id', type: 'directory' },
    { name: '../outside', type: 'directory' }, { name: 'personal', type: 'directory' }
  ] });
  await adapter.shareFiles([{ blob: png(), name: '🎵'.repeat(100) + '.png' }]);
  const removed = events.filter(event => event[0] === 'rmdir');
  assert.equal(removed.length, 1);
  assert.equal(removed[0][1].path, 'exports/1600000000000-old-id');
  const name = events.find(event => event[0] === 'write')[1].path.split('/').at(-1);
  assert.ok(Buffer.byteLength(name, 'utf8') <= 184);
  assert.ok(!name.includes('\ufffd'));
});

test('native pause and cancelable Android back events integrate without forced navigation', async () => {
  const window = new EventTarget();
  const { listeners, events } = fixture({}, window);
  let paused = 0;
  window.addEventListener('hang-native-pause', () => { paused++; });
  listeners.appStateChange({ isActive: true });
  listeners.appStateChange({ isActive: false });
  assert.equal(paused, 1);
  const handle = event => event.preventDefault();
  window.addEventListener('hang-native-back', handle);
  listeners.backButton();
  assert.equal(events.length, 0);
  window.removeEventListener('hang-native-back', handle);
  listeners.backButton();
  assert.deepEqual(events, [['minimize']]);
});
