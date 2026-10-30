const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scope = 'https://example.test/quiet-rhythm-mobile/';
const prefix = 'quiet-rhythm-mobile:' + scope + ':';
function worker({ names = [], failInstall = false } = {}) {
  const listeners = {}, removed = [], requests = [], calls = { skip: 0, claim: 0, network: 0 };
  const cache = { addAll: async items => { requests.push(...items); if (failInstall) throw Error('offline'); },
    match: async key => ({ cached: key }) };
  const context = {
    URL, Request, Set,
    caches: { open: async () => cache, keys: async () => names, delete: async name => { removed.push(name); } },
    fetch: async request => { calls.network++; return { network: request.url }; },
    self: { registration: { scope }, addEventListener: (name, listener) => { listeners[name] = listener; },
      skipWaiting: async () => { calls.skip++; }, clients: { claim: async () => { calls.claim++; } } }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'sw.js'), 'utf8'), context);
  return { calls, requests, removed, async fire(name, props = {}) {
    let pending;
    listeners[name]({ ...props, waitUntil: task => { pending = task; }, respondWith: task => { pending = task; } });
    return await pending;
  } };
}

test('new worker downloads complete scoped shell and waits for saved-editor approval', async () => {
  const sw = worker({ names: [prefix + 'release-previous'] });
  await sw.fire('install');
  assert.equal(sw.requests.length, 14);
  assert.ok(sw.requests.every(request => request.url.startsWith(scope) && request.cache === 'reload'));
  assert.equal(sw.calls.skip, 0);
  await sw.fire('message', { data: { type: 'SKIP_WAITING' }, source: { url: scope + '#tab/123' } });
  assert.equal(sw.calls.skip, 1);
});

test('legacy v4 migrates without requiring all old windows to close', async () => {
  const sw = worker({ names: [prefix + 'v4'] });
  await sw.fire('install');
  assert.equal(sw.calls.skip, 1);
});

test('incomplete update never activates, even during legacy migration', async () => {
  const sw = worker({ names: [prefix + 'v4'], failInstall: true });
  await assert.rejects(sw.fire('install'), /offline/);
  assert.equal(sw.calls.skip, 0);
  assert.deepEqual(sw.removed, []);
});

test('activation only removes this app scope caches and claims open clients', async () => {
  const other = 'quiet-rhythm-mobile:https://example.test/another/:v4';
  const sw = worker({ names: [prefix + 'v4', prefix + 'release-previous', prefix + 'dev-v5', other, 'unrelated'] });
  await sw.fire('activate');
  assert.deepEqual(sw.removed, [prefix + 'v4', prefix + 'release-previous']);
  assert.equal(sw.calls.claim, 1);
});

test('unrelated messages and clients cannot request activation', async () => {
  const sw = worker();
  for (const props of [
    { data: { type: 'UNKNOWN' }, source: { url: scope } },
    { data: { type: 'SKIP_WAITING' } },
    { data: { type: 'SKIP_WAITING' }, source: { url: 'https://example.test/another/' } },
    { data: { type: 'SKIP_WAITING' }, source: { url: 'https://other.test/quiet-rhythm-mobile/' } }
  ]) await sw.fire('message', props);
  assert.equal(sw.calls.skip, 0);
});

test('offline navigation and assets use one complete release; foreign URLs are untouched', async () => {
  const sw = worker();
  const request = (url, mode = 'cors', method = 'GET') => ({ url, mode, method });
  assert.equal((await sw.fire('fetch', { request: request(scope + '?launch=1', 'navigate') })).cached, scope + 'index.html');
  assert.equal((await sw.fire('fetch', { request: request(scope + 'core.js?version=1') })).cached, scope + 'core.js');
  for (const value of [request('https://example.test/hang-creator/app.js'), request(scope + 'private.json'), request(scope, 'cors', 'POST')]) {
    assert.equal(await sw.fire('fetch', { request: value }), undefined);
  }
  assert.equal(sw.calls.network, 0);
});

test('build automatically fingerprints assets, stays reproducible, and includes worker changes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quiet-rhythm-build-'));
  try {
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/build.mjs'), path.join(directory, 'scripts/build.mjs'));
    const files = ['index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js', 'playback.js', 'export.js', 'storage.js', 'sw.js', 'manifest.webmanifest', 'app-icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
    for (const name of files) fs.copyFileSync(path.join(root, name), path.join(directory, name));
    function build() {
      execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: directory, stdio: 'pipe' });
      return fs.readFileSync(path.join(directory, 'dist/sw.js'), 'utf8');
    }
    const first = build();
    assert.match(first, /const APP_VERSION = 'release-[a-f0-9]{20}';/);
    assert.equal(build(), first);
    for (const name of files.filter(name => !name.endsWith('.png'))) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
    assert.equal(build(), first, 'Windows line endings keep identical release');
    fs.appendFileSync(path.join(directory, 'app.js'), '\n// next release\n');
    const second = build();
    assert.notEqual(second, first, 'changing app without touching sw still changes its release');
    fs.appendFileSync(path.join(directory, 'sw.js'), '\n// next worker logic\n');
    const third = build();
    assert.notEqual(third, second);
    fs.appendFileSync(path.join(directory, 'icon-192.png'), Buffer.from([1]));
    assert.notEqual(build(), third, 'binary resources also invalidate the cache');
  } finally {
    assert.ok(fs.realpathSync(directory).startsWith(fs.realpathSync(os.tmpdir()) + path.sep + 'quiet-rhythm-build-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
