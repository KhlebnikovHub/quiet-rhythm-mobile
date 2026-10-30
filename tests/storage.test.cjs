const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Real IndexedDB transactions, including rollback; no mock implementation and
// no package installation. Set BROWSER_BIN to Chromium/Chrome/Edge if needed.
async function browserChecks() {
  const results = [];
  const equal = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(message + ': ' + JSON.stringify(actual));
  };
  const rejects = async (operation, code) => {
    try { await operation(); } catch (error) {
      if (code && error.code !== code) throw error;
      return;
    }
    throw new Error('Expected rejection');
  };
  const check = async (name, run) => {
    try { await run(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.stack || error.message }); }
  };
  const newStore = () => {
    const databaseName = 'mobile-test-' + crypto.randomUUID();
    return { databaseName, store: MobileStore.create({ databaseName }) };
  };
  const raw = (name, operation) => new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['tabs', 'meta'], 'readwrite');
      let value;
      operation(tx, result => { value = result; });
      tx.oncomplete = () => { db.close(); resolve(value); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
  await check('seed once, preserve edits, and keep intentionally emptied libraries empty', async () => {
    const { store } = newStore();
    const first = HangCore.createTab({ title: 'First' });
    equal((await store.initialize([first])).tabs.length, 1, 'initial seed');
    first.title = 'Edited';
    await store.saveTab(first);
    equal((await store.initialize([HangCore.createTab()])).tabs[0].title, 'Edited', 'existing title');
    await store.deleteTab(first.id);
    equal(await store.initialize([first]), { tabs: [], currentId: null }, 'empty library');
  });
  await check('capture snapshots at call time and serialize rapid writes and reads', async () => {
    const { store } = newStore();
    const tab = HangCore.createTab({ title: 'Before' });
    const first = store.saveTab(tab);
    tab.title = 'Second';
    const second = store.saveTab(tab);
    tab.title = 'Not saved';
    const read = store.load();
    equal((await first).title, 'Before', 'first snapshot');
    equal((await second).title, 'Second', 'second snapshot');
    equal((await read).tabs[0].title, 'Second', 'ordered read');
  });
  await check('validate the whole import before writing and continue after rejection', async () => {
    const { store } = newStore();
    const original = HangCore.createTab({ title: 'Original' });
    await store.initialize([original]);
    const replacement = { ...original, title: 'Changed' };
    await rejects(() => store.saveTabs([replacement, { format: 'invalid' }]));
    equal((await store.load()).tabs[0].title, 'Original', 'unmodified import');
    await store.saveTab(replacement);
    equal((await store.load()).tabs[0].title, 'Changed', 'queue recovers');
  });
  await check('abort the entire batch when a write fails after an earlier put', async () => {
    const { store } = newStore();
    const original = HangCore.createTab({ title: 'Original' });
    await store.initialize([original]);
    const put = IDBObjectStore.prototype.put;
    let writes = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'tabs' && ++writes === 2) throw new DOMException('Simulated quota exhaustion', 'QuotaExceededError');
      return put.apply(this, args);
    };
    try {
      await rejects(() => store.saveTabs([{ ...original, title: 'Changed' }, HangCore.createTab()]));
    } finally { IDBObjectStore.prototype.put = put; }
    const loaded = await store.load();
    equal(loaded.tabs.length, 1, 'no partial insertion');
    equal(loaded.tabs[0].title, 'Original', 'rollback previous put');
  });
  await check('do not replace corrupted records with examples', async () => {
    const { store, databaseName } = newStore();
    await store.initialize([]);
    const damaged = { id: 'damaged', format: 'unexpected', notes: 'preserve these bytes' };
    await raw(databaseName, tx => tx.objectStore('tabs').put(damaged));
    await rejects(() => store.initialize([HangCore.createTab()]), 'STORAGE_CORRUPT');
    const records = await raw(databaseName, (tx, done) => {
      const request = tx.objectStore('tabs').getAll();
      request.onsuccess = () => done(request.result);
    });
    equal(records, [damaged], 'raw record retained');
  });
  await check('independent windows save different documents without dropping either', async () => {
    const { store, databaseName } = newStore();
    const second = MobileStore.create({ databaseName });
    const a = HangCore.createTab(), b = HangCore.createTab();
    await Promise.all([store.saveTab(a), second.saveTab(b)]);
    equal((await store.load()).tabs.map(tab => tab.id).sort(), [a.id, b.id].sort(), 'both saved');
  });
  await check('concurrent first launches seed only one library', async () => {
    const { store, databaseName } = newStore();
    const second = MobileStore.create({ databaseName });
    const a = HangCore.createTab(), b = HangCore.createTab();
    await Promise.all([store.initialize([a]), second.initialize([b])]);
    equal((await store.load()).tabs.length, 1, 'single seed');
  });
  await check('persist and validate selection; deletion clears a selected tab', async () => {
    const { store } = newStore();
    const a = HangCore.createTab(), b = HangCore.createTab();
    await store.initialize([a, b]);
    await store.setCurrent(b.id);
    await rejects(() => store.setCurrent('missing'), 'TAB_NOT_FOUND');
    equal((await store.load()).currentId, b.id, 'selection retained');
    await store.deleteTab(b.id);
    equal((await store.load()).currentId, a.id, 'selection fallback');
  });
  await check('missing IndexedDB is an explicit failure, never an in-memory save', async () => {
    const store = MobileStore.create({ host: {} });
    await rejects(() => store.initialize([HangCore.createTab()]), 'STORAGE_UNAVAILABLE');
    await rejects(() => store.saveTab(HangCore.createTab()), 'STORAGE_UNAVAILABLE');
  });
  await check('persistence denial remains truthful and does not fail editing', async () => {
    const store = MobileStore.create({ host: { navigator: { storage: { persist: async () => false } } } });
    equal(await store.requestPersistence(), { supported: true, persisted: false }, 'denial');
    equal(await MobileStore.create({ host: {} }).requestPersistence(), { supported: false, persisted: false }, 'unsupported');
  });
  await fetch('/results', { method: 'POST', body: JSON.stringify(results) });
}

test('mobile library in real Chromium IndexedDB', { timeout: 60000 }, async t => {
  const cachedRoot = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ms-playwright');
  const cachedBrowsers = fs.existsSync(cachedRoot) ? fs.readdirSync(cachedRoot).filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse().map(name => path.join(cachedRoot, name, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')) : [];
  const candidates = [process.env.BROWSER_BIN, ...cachedBrowsers, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean);
  const browser = candidates.find(file => fs.existsSync(file));
  if (!browser) { t.skip('Set BROWSER_BIN to an installed Chromium browser'); return; }
  const directory = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hang-mobile-storage-test-'));
  let report;
  const reported = new Promise(resolve => { report = resolve; });
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/results') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { report(JSON.parse(body)); response.end('ok'); });
    } else if (request.url === '/core.js' || request.url === '/storage.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(fs.readFileSync(path.join(directory, request.url.slice(1))));
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><meta charset="utf-8"><script src="/core.js"></script><script src="/storage.js"></script><script>(' + browserChecks.toString() + ')();</script>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn(browser, ['--headless=new', '--disable-gpu', '--in-process-gpu', ...(process.env.BROWSER_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-4000); });
  let timeout;
  try {
    const results = await Promise.race([
      reported,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Browser did not report IndexedDB test results. ' + diagnostics)), 45000);
        child.once('error', reject);
        child.once('exit', code => reject(new Error('Browser exited before reporting: ' + code + '. ' + diagnostics)));
      })
    ]);
    for (const result of results) await t.test(result.name, () => assert.equal(result.passed, true, result.error));
  } finally {
    clearTimeout(timeout);
    child.kill();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Delete only the freshly generated test profile inside the system temp root.
    const absolute = path.resolve(profile);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (absolute.startsWith(tempRoot) && path.basename(absolute).startsWith('hang-mobile-storage-test-')) {
      try { fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (_) { /* Browser may still hold a temp lock. */ }
    }
  }
});
