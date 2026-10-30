"""Upgrade an installed cache-first v4 worker without closing its open windows.

Uses a minimal legacy page with the real IndexedDB store, a real v4 worker that
has no update-message handler, and a temporary build of the current app. No
historical checkout, private library, or third-party Python package is needed.
"""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
from urllib.request import urlopen

from browser_cdp import CDP, wait_debugger


ROOT = Path(__file__).resolve().parents[1]
BROWSER = Path(os.environ.get('BROWSER_BIN', str(Path(os.environ.get('LOCALAPPDATA', '')) / 'ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe')))
FILES = ['index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js', 'playback.js', 'export.js', 'storage.js', 'sw.js', 'manifest.webmanifest', 'app-icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']

LEGACY_HTML = '''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Legacy v4 migration fixture</title><h1 id="legacy-version">Installed v4</h1>
<label>Unsubmitted edit <input id="legacy-draft"></label>
<script src="core.js"></script><script src="storage.js"></script><script src="legacy.js"></script></html>'''
LEGACY_SCRIPT = '''window.__legacyVersion='v4';window.__legacyControllerChanges=0;
navigator.serviceWorker.addEventListener('controllerchange',()=>window.__legacyControllerChanges++);
window.__legacyReady=(async()=>{
  await MobileStore.initialize([]);
  await navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'});
  await navigator.serviceWorker.ready;
  window.__legacyInitialized=true;
})();'''
LEGACY_WORKER = ''''use strict';
const CACHE_NAME='quiet-rhythm-mobile:'+self.registration.scope+':v4';
const FILES=['./','./index.html','./legacy.js','./core.js','./storage.js'];
self.addEventListener('install',event=>event.waitUntil((async()=>{
  const cache=await caches.open(CACHE_NAME);await cache.addAll(FILES);await self.skipWaiting();
})()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||!event.request.url.startsWith(self.registration.scope))return;
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE_NAME);return await cache.match(event.request)||fetch(event.request);
  })());
});'''


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    if not BROWSER.is_file():
        raise SystemExit('Set BROWSER_BIN to an installed Chromium browser.')
    checks = []

    def check(value, message):
        if not value:
            raise AssertionError(message)
        checks.append(message)
        print('PASS ' + message, flush=True)

    with tempfile.TemporaryDirectory(prefix='quiet-rhythm-legacy-', ignore_cleanup_errors=True) as folder:
        temp = Path(folder)
        source, site = temp / 'source', temp / 'site'
        (source / 'scripts').mkdir(parents=True)
        app = site / 'app'
        app.mkdir(parents=True)
        (app / 'index.html').write_text(LEGACY_HTML, encoding='utf-8')
        (app / 'legacy.js').write_text(LEGACY_SCRIPT, encoding='utf-8')
        (app / 'sw.js').write_text(LEGACY_WORKER, encoding='utf-8')
        for name in ('core.js', 'storage.js'):
            shutil.copyfile(ROOT / name, app / name)
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(site)))
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        server_closed = False
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            debug_port = sock.getsockname()[1]
        clients = []
        process = None
        with (temp / 'browser.log').open('w', encoding='utf-8') as log:
            try:
                process = subprocess.Popen([
                    str(BROWSER), '--headless', '--disable-gpu', '--in-process-gpu',
                    *(['--no-sandbox'] if os.environ.get('BROWSER_NO_SANDBOX') == '1' else []),
                    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
                    '--remote-allow-origins=*', f'--remote-debugging-port={debug_port}',
                    f'--user-data-dir={temp / "profile"}', 'about:blank',
                ], stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                client = CDP(wait_debugger(debug_port, process))
                clients.append(client)
                for method in ('Page.enable', 'Runtime.enable', 'Network.enable'):
                    client.call(method)
                client.call('Emulation.setDeviceMetricsOverride', {'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
                url = f'http://127.0.0.1:{server.server_port}/app/'
                client.call('Page.navigate', {'url':url})
                client.wait('window.__legacyInitialized && !!navigator.serviceWorker.controller', 'legacy worker installs and controls its page')
                check(client.evaluate('(async()=>{const keys=await caches.keys();return keys.includes("quiet-rhythm-mobile:"+location.href+":v4");})()'), 'the real legacy v4 cache is installed')
                seeded = client.evaluate('''(async()=>{
                  let first=HangCore.createTab({title:'Saved before worker migration',division:2});
                  first.subtitle='Do not replace this existing library';first.tempo=117;first.notes='Legacy saved notes';
                  first=HangCore.setCellHands(first,0,1,'split');
                  first.measures[0].rows.main[0]=['D','4'];first.measures[0].rows.R[1]=['2'];first.measures[0].rows.L[1]=['8'];
                  first=HangCore.splitSlot(first,0,1,2).tab;
                  first=HangCore.setSlotSyllable(first,0,1,'Da');first.notation='hybrid';
                  let second=HangCore.createTab({title:'Another saved composition',meter:{numerator:7,denominator:8}});
                  second.measures[0].rows.main[3]=['S'];second.notes='Independent document';
                  await MobileStore.saveTabs([first,second]);await MobileStore.setCurrent(first.id);
                  const cache=await caches.open('unrelated-app:keep');await cache.put('/unrelated-sentinel',new Response('keep'));
                  location.hash='tab/'+first.id;
                  return {tabs:(await MobileStore.load()).tabs,current:first};
                })()''')
                client.fill('#legacy-draft', 'Unsubmitted first-window draft')
                old_epoch = client.evaluate('performance.timeOrigin')
                old_changes = client.evaluate('__legacyControllerChanges')
                target = client.call('Target.createTarget', {'url':url+'#tab/'+seeded['current']['id']})['targetId']
                with urlopen(f'http://127.0.0.1:{debug_port}/json/list', timeout=5) as response:
                    targets = json.load(response)
                other = CDP(next(item['webSocketDebuggerUrl'] for item in targets if item['id']==target))
                clients.append(other)
                for method in ('Page.enable','Runtime.enable','Network.enable'):
                    other.call(method)
                other.wait('window.__legacyInitialized && !!navigator.serviceWorker.controller', 'second legacy window remains open')
                other.fill('#legacy-draft', 'Unsubmitted second-window draft')
                other_epoch = other.evaluate('performance.timeOrigin')
                check(other.evaluate('(async()=>(await MobileStore.load()).tabs)()')==seeded['tabs'], 'both legacy windows see the exact saved library')

                # Build the real current sources in isolation, then replace only
                # served files. The legacy windows and their controller stay open.
                shutil.copyfile(ROOT / 'scripts/build.mjs', source / 'scripts/build.mjs')
                for name in FILES:
                    shutil.copyfile(ROOT / name, source / name)
                with (source / 'app.js').open('a', encoding='utf-8') as output:
                    output.write("\nwindow.__legacyUpgradeRelease='current-built-app';\n")
                subprocess.run(['node','scripts/build.mjs'], cwd=source, check=True, capture_output=True, timeout=30)
                worker_source = (source / 'dist/sw.js').read_text(encoding='utf-8')
                release = re.search(r"const APP_VERSION = '(release-[a-f0-9]+)';", worker_source).group(1)
                for name in FILES:
                    shutil.copyfile(source / 'dist' / name, app / name)
                client.evaluate('(async()=>{await(await navigator.serviceWorker.getRegistration()).update();})()')
                ready = '(async()=>{const r=await navigator.serviceWorker.getRegistration();return r.active?.state==="activated"&&!r.waiting&&!r.installing&&(await caches.keys()).some(name=>name.endsWith(":'+release+'"))&&window.__legacyControllerChanges>'+str(old_changes)+';})()'
                client.wait(ready, 'current worker automatically activates over v4 with both windows open', timeout=25)
                check(client.evaluate('window.__legacyVersion==="v4" && performance.timeOrigin==='+json.dumps(old_epoch)+' && document.getElementById("legacy-draft").value==="Unsubmitted first-window draft"'), 'legacy migration activates without reloading or erasing the first window draft')
                check(other.evaluate('window.__legacyVersion==="v4" && performance.timeOrigin==='+json.dumps(other_epoch)+' && document.getElementById("legacy-draft").value==="Unsubmitted second-window draft"'), 'the second legacy window and its unsubmitted draft stay open')
                check(client.evaluate('(async()=>(await MobileStore.load()).tabs)()')==seeded['tabs'], 'activation alone leaves every stored tab unchanged')
                check(client.evaluate('(async()=>{const names=await caches.keys();return !names.some(name=>name.endsWith(":v4"))&&names.includes("unrelated-app:keep");})()'), 'migration removes the old app cache and retains unrelated caches')

                client.call('Page.reload')
                client.wait('performance.timeOrigin!=='+json.dumps(old_epoch)+' && window.__legacyUpgradeRelease==="current-built-app" && window.HangMobile && HangMobile.getCurrent()', 'normal refresh loads current UI', timeout=25)
                check(client.evaluate('HangMobile.getCurrent()')==seeded['current'], 'normal refresh restores the complete selected composition')
                check(client.evaluate('HangMobile.getLibrary()')==seeded['tabs'], 'normal refresh preserves the library without adding samples or duplicates')
                check(client.evaluate('!!document.querySelector("#cell-hands") && !!document.querySelector("#cell-tools [data-action=split-cell][data-parts=\\"4\\"]") && !!document.querySelector("#app-update")'), 'the current editing and update controls replace the legacy UI')
                check(other.evaluate('window.__legacyVersion==="v4" && document.getElementById("legacy-draft").value==="Unsubmitted second-window draft"'), 'refreshing one window does not replace another legacy draft')

                # Stop the server as well as emulating offline mode: succeeding
                # now proves that the complete built app came from worker cache.
                for window in clients:
                    window.call('Network.emulateNetworkConditions', {'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
                server.shutdown(); server.server_close(); worker.join(timeout=5)
                server_closed = True
                for index, window in enumerate(clients):
                    epoch = window.evaluate('performance.timeOrigin')
                    window.call('Page.reload')
                    window.wait('performance.timeOrigin!=='+json.dumps(epoch)+' && window.__legacyUpgradeRelease==="current-built-app" && window.HangMobile && HangMobile.getCurrent()', f'window {index+1} opens current app offline', timeout=25)
                    check(window.evaluate('HangMobile.getLibrary()')==seeded['tabs'] and window.evaluate('HangMobile.getCurrent()')==seeded['current'], f'window {index+1} restores exact tabs and selection offline after v4 migration')
                    check(window.evaluate('navigator.onLine===false && !!navigator.serviceWorker.controller && document.getElementById("storage-error").hidden'), f'window {index+1} is controlled and has working storage offline')
                print(json.dumps({'passed':len(checks),'scenario':'legacy v4 cache-first worker to current release with two live windows and full offline reload','version':release},ensure_ascii=False),flush=True)
            finally:
                for client in clients:
                    client.close()
                if process:
                    process.terminate()
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        process.kill(); process.wait(timeout=5)
                if not server_closed:
                    server.shutdown(); server.server_close(); worker.join(timeout=5)


if __name__ == '__main__':
    main()
