(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./core.js') : root.HangCore;
  const api = factory(root, core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MobileStore = api;
})(typeof window === 'undefined' ? globalThis : window, function (host, Core) {
  'use strict';

  // Each change commits as one IndexedDB transaction. The queue also keeps reads
  // behind pending writes; the transaction itself coordinates separate windows.
  function create(options = {}) {
    const environment = options.host || host;
    const databaseName = options.databaseName || 'quiet-rhythm-mobile';
    let databasePromise = null;
    let queue = Promise.resolve();

    function enqueue(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    }
    function failure(message, code, cause) {
      const error = new Error(message);
      error.code = code;
      if (cause) error.cause = cause;
      return error;
    }
    function open() {
      if (databasePromise) return databasePromise;
      if (!environment.indexedDB) return Promise.reject(failure('Хранилище недоступно. Откройте приложение в обычном режиме браузера.', 'STORAGE_UNAVAILABLE'));
      const pending = new Promise((resolve, reject) => {
        let rejected = false;
        const request = environment.indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('tabs')) db.createObjectStore('tabs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        request.onerror = () => { rejected = true; reject(request.error); };
        request.onblocked = () => {
          rejected = true;
          reject(failure('Закройте другие окна приложения и попробуйте снова открыть библиотеку.', 'STORAGE_BLOCKED'));
        };
        request.onsuccess = () => {
          const db = request.result;
          if (rejected) { db.close(); return; }
          db.onversionchange = () => { db.close(); databasePromise = null; };
          resolve(db);
        };
      });
      databasePromise = pending;
      pending.catch(() => { if (databasePromise === pending) databasePromise = null; });
      return pending;
    }
    async function transaction(mode, body) {
      const db = await open();
      return new Promise((resolve, reject) => {
        // Request strict durability where available, retaining older Safari support.
        let tx;
        try { tx = db.transaction(['tabs', 'meta'], mode, { durability: mode === 'readwrite' ? 'strict' : 'default' }); }
        catch (_) { tx = db.transaction(['tabs', 'meta'], mode); }
        let result;
        let explicitError;
        const abort = error => {
          explicitError = error;
          try { tx.abort(); } catch (_) { reject(error); }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(explicitError || tx.error || failure('Изменения не сохранены. Повторите сохранение или скачайте резервную копию.', 'STORAGE_ABORTED'));
        tx.onerror = () => {}; // onabort is the authoritative failure for an atomic write.
        try {
          body(tx.objectStore('tabs'), tx.objectStore('meta'), value => { result = value; }, abort);
        } catch (error) { abort(error); }
      });
    }
    function validateList(values) {
      if (!Array.isArray(values)) throw new Error('Ожидается список табулатур.');
      const seen = new Set();
      return values.map(value => {
        const tab = Core.validateTab(value);
        if (seen.has(tab.id)) throw new Error('В библиотеке повторяется ID табулатуры.');
        seen.add(tab.id);
        return tab;
      });
    }
    function readState(value) {
      if (value === undefined) return { key: 'state', initialized: false, currentId: null };
      if (!value || value.initialized !== true || !(value.currentId == null || typeof value.currentId === 'string')) {
        throw failure('Не удалось прочитать настройки библиотеки. Существующие данные сохранены без изменений.', 'STORAGE_CORRUPT');
      }
      return value;
    }
    function readTabs(values) {
      try {
        if (values.some(value => !value || typeof value.id !== 'string')) throw new Error('Missing document ID');
        return validateList(values);
      } catch (error) {
        throw failure('Не удалось прочитать библиотеку. Существующие данные сохранены без изменений.', 'STORAGE_CORRUPT', error);
      }
    }
    function snapshot(tabs, state) {
      return { tabs, currentId: tabs.some(tab => tab.id === state.currentId) ? state.currentId : (tabs[0]?.id || null) };
    }
    function readLibrary(mode, defaults) {
      return transaction(mode, (tabsStore, meta, done, abort) => {
        const records = tabsStore.getAll();
        const metadata = meta.get('state');
        let remaining = 2;
        const finish = () => {
          if (--remaining) return;
          try {
            let tabs = readTabs(records.result);
            const state = readState(metadata.result);
            if (defaults && !state.initialized) {
              // Existing records always win, including a library predating metadata.
              if (tabs.length === 0) {
                tabs = defaults;
                tabs.forEach(tab => tabsStore.add(tab));
              }
              state.initialized = true;
              state.currentId = tabs[0]?.id || null;
              meta.put(state);
            }
            done(snapshot(tabs, state));
          } catch (error) { abort(error); }
        };
        records.onsuccess = finish;
        metadata.onsuccess = finish;
      });
    }
    function initialize(defaultTabs = []) {
      let defaults;
      try { defaults = validateList(defaultTabs); } catch (error) { return Promise.reject(error); }
      return enqueue(() => readLibrary('readwrite', defaults));
    }
    function load() { return enqueue(() => readLibrary('readonly')); }
    function saveTabs(values) {
      // Capture now, before queued work: later editing cannot change this save.
      let tabs;
      try { tabs = validateList(values); } catch (error) { return Promise.reject(error); }
      return enqueue(() => transaction('readwrite', (store, meta, done, abort) => {
        const request = meta.get('state');
        request.onsuccess = () => {
          try {
            const state = readState(request.result);
            tabs.forEach(tab => store.put(tab));
            state.initialized = true;
            if (!state.currentId && tabs.length) state.currentId = tabs[0].id;
            meta.put(state);
            done(tabs);
          } catch (error) { abort(error); }
        };
      }));
    }
    function saveTab(tab) { return saveTabs([tab]).then(tabs => tabs[0]); }
    function deleteTab(id) {
      return enqueue(() => transaction('readwrite', (store, meta, done, abort) => {
        const request = meta.get('state');
        request.onsuccess = () => {
          try {
            const state = readState(request.result);
            store.delete(id);
            state.initialized = true;
            if (state.currentId === id) state.currentId = null;
            meta.put(state);
          } catch (error) { abort(error); }
        };
      }));
    }
    function setCurrent(id) {
      return enqueue(() => transaction('readwrite', (store, meta, done, abort) => {
        const request = meta.get('state');
        request.onsuccess = () => {
          try {
            const state = readState(request.result);
            const update = () => {
              state.currentId = id;
              state.initialized = true;
              meta.put(state);
            };
            if (id === null) { update(); return; }
            const tab = store.get(id);
            tab.onsuccess = () => {
              if (!tab.result) abort(failure('Табулатура не найдена в библиотеке.', 'TAB_NOT_FOUND'));
              else update();
            };
          } catch (error) { abort(error); }
        };
      }));
    }
    async function requestPersistence() {
      const storage = environment.navigator?.storage;
      if (!storage?.persist) return { supported: false, persisted: false };
      try {
        const persisted = storage.persisted ? await storage.persisted() : false;
        return { supported: true, persisted: persisted || await storage.persist() };
      } catch (_) { return { supported: true, persisted: false }; }
    }
    return { initialize, load, saveTab, saveTabs, deleteTab, setCurrent, requestPersistence };
  }
  return Object.assign(create(), { create });
});
