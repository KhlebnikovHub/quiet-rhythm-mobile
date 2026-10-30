"""Real service-worker upgrades, including failed saves and multiple open tabs."""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from urllib.request import urlopen
from browser_cdp import CDP, wait_debugger

ROOT = Path(__file__).resolve().parents[1]
BROWSER = Path(os.environ.get('BROWSER_BIN', str(Path(os.environ['LOCALAPPDATA']) / 'ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe')))
FILES = ['index.html', 'styles.css', 'app.js', 'core.js', 'sample-tabs.js', 'playback.js', 'export.js', 'storage.js', 'sw.js', 'manifest.webmanifest', 'app-icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']


class Handler(SimpleHTTPRequestHandler):
    def handle(self):
        try:
            super().handle()
        except ConnectionError:
            pass  # Expected when simulating offline or stopping the browser.

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    checks = []

    def check(value, message):
        if not value:
            raise AssertionError(message)
        checks.append(message)
        print('PASS ' + message, flush=True)

    with tempfile.TemporaryDirectory(prefix='quiet-rhythm-updates-') as folder:
        temp = Path(folder)
        source, site = temp / 'source', temp / 'site'
        (source / 'scripts').mkdir(parents=True)
        (site / 'app').mkdir(parents=True)
        shutil.copyfile(ROOT / 'scripts/build.mjs', source / 'scripts/build.mjs')

        def release(version):
            for name in FILES:
                shutil.copyfile(ROOT / name, source / name)
            with (source / 'app.js').open('a', encoding='utf8') as output:
                output.write('\nwindow.__pwaTestVersion = ' + str(version) + ';\n')
            subprocess.run(['node', 'scripts/build.mjs'], cwd=source, check=True, capture_output=True)
            for name in FILES:
                shutil.copyfile(source / 'dist' / name, site / 'app' / name)

        release(1)
        server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(site)))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        log = (temp / 'browser.log').open('w', encoding='utf8')
        process = subprocess.Popen([str(BROWSER), '--headless', '--disable-gpu', '--in-process-gpu', *(['--no-sandbox'] if os.environ.get('BROWSER_NO_SANDBOX') == '1' else []), '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*', f'--remote-debugging-port={port}', f'--user-data-dir={temp / "profile"}', 'about:blank'], stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        clients = []
        try:
            client = CDP(wait_debugger(port, process)); clients.append(client)
            for method in ['Page.enable', 'Runtime.enable', 'Network.enable']:
                client.call(method)
            client.call('Emulation.setDeviceMetricsOverride', {'width':390, 'height':844, 'deviceScaleFactor':1, 'mobile':True})
            url = f'http://127.0.0.1:{server.server_port}/app/'
            client.call('Page.navigate', {'url':url})
            try:
                client.wait('window.HangMobile && HangMobile.getLibrary().length === 3 && !!navigator.serviceWorker.controller', 'initial install')
            except Exception:
                print(json.dumps({'state': client.evaluate('({app:!!window.HangMobile, library:window.HangMobile?.getLibrary().length, body:document.body.innerText.slice(-1200)})'), 'errors': [event for event in client.events if event.get('method') == 'Runtime.exceptionThrown']}, ensure_ascii=False), flush=True)
                raise
            check(client.evaluate('!document.getElementById("install-tip").hidden'), 'installation entry visible on mobile browser')
            client.click('[data-action=new]')
            client.fill('#new-form [name=title]', 'Upgrade must preserve this rhythm')
            client.click('#new-form [type=submit]')
            client.wait('HangMobile.getCurrent()?.title === "Upgrade must preserve this rhythm"', 'new document')
            client.click('#auto-advance')
            client.click('[data-action=cell-hands]')
            client.click('#note-pad [data-token=D]')
            client.click('[data-action=input-hand][data-hand=L]')
            client.click('#note-pad [data-token="6"]')
            client.click('[data-action=split-cell][data-parts="4"]')
            client.wait('document.getElementById("save-status").textContent === "Сохранено на устройстве"', 'saved local hands and quarters')
            current_url = client.evaluate('location.href')
            target = client.call('Target.createTarget', {'url': current_url})['targetId']
            with urlopen(f'http://127.0.0.1:{port}/json/list') as response:
                targets = json.load(response)
            other = CDP(next(item['webSocketDebuggerUrl'] for item in targets if item['id'] == target)); clients.append(other)
            other.call('Page.enable'); other.call('Runtime.enable')
            other.wait('window.HangMobile && HangMobile.getCurrent()?.title === "Upgrade must preserve this rhythm"', 'second editor')
            other.click('[data-action=settings]')
            other.fill('#settings-form [name=title]', 'Draft in second window')

            client.evaluate('window.originalSave = MobileStore.saveTab; MobileStore.saveTab = () => Promise.reject(new Error("Simulated full storage"))')
            client.click('#note-pad [data-token="8"]')
            client.wait('document.getElementById("save-status").textContent.includes("Не сохранено")', 'simulated failed save')
            expected = client.evaluate('HangMobile.getCurrent()')
            release(2)
            client.evaluate('(async()=>{const reg=await navigator.serviceWorker.getRegistration();await reg.update();})()')
            client.wait('!document.getElementById("app-update").hidden && !document.getElementById("apply-update").disabled', 'waiting update banner')
            check(client.evaluate('window.__pwaTestVersion === 1'), 'downloading update does not interrupt editing')
            check(client.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'update banner fits phone')
            client.click('#apply-update')
            client.wait('document.getElementById("update-status").textContent.includes("не применено")', 'update waits for successful save')
            check(client.evaluate('window.__pwaTestVersion === 1 && !document.getElementById("app").inert'), 'failed save blocks update and returns editable UI')
            check(client.evaluate('(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting)()'), 'failed save leaves complete update waiting')
            check(client.evaluate('HangMobile.getCurrent()') == expected, 'failed update keeps unsaved in-memory notes')
            client.evaluate('MobileStore.saveTab = window.originalSave')
            client.click('#apply-update')
            client.wait('window.__pwaTestVersion === 2 && window.HangMobile && HangMobile.getCurrent()?.title === "Upgrade must preserve this rhythm"', 'apply and reload new release')
            check(client.evaluate('HangMobile.getCurrent()') == expected, 'update preserves full document including R/L and subdivisions')
            check(client.evaluate('document.getElementById("auto-advance").checked === false'), 'update preserves entry preferences')
            other.wait('!document.getElementById("app-update").hidden', 'other window knows about activation')
            check(other.evaluate('window.__pwaTestVersion === 1 && document.getElementById("sheet").open && document.querySelector("#settings-form [name=title]").value === "Draft in second window"'), 'external activation preserves another window and its unsaved dialog')
            other.click('[data-action=close-sheet]')
            other.click('#apply-update')
            other.wait('window.__pwaTestVersion === 2 && window.HangMobile && HangMobile.getCurrent()', 'second window refreshes safely')
            check(other.evaluate('HangMobile.getCurrent()') == expected, 'stale window never overwrites latest saved document during update')

            # A failed install (missing resource) must leave the previous complete
            # cache usable offline and must not advertise a partial release.
            release(3)
            (site / 'app/core.js').unlink()
            client.evaluate('(async()=>{try{await(await navigator.serviceWorker.getRegistration()).update();}catch{}})()')
            client.wait('(async()=>{const r=await navigator.serviceWorker.getRegistration();return !r.installing&&!r.waiting;})()', 'incomplete release rejected')
            check(client.evaluate('window.__pwaTestVersion === 2'), 'partial download cannot replace working app')
            client.call('Network.emulateNetworkConditions', {'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
            client.call('Page.reload')
            client.wait('window.__pwaTestVersion === 2 && window.HangMobile && HangMobile.getCurrent()', 'offline after update')
            check(client.evaluate('HangMobile.getCurrent()') == expected, 'successful version and library reopen fully offline')
            check(client.evaluate('navigator.serviceWorker.controller !== null'), 'updated app remains installable and controlled')
            print(json.dumps({'passed':len(checks),'scenario':'PWA actual worker update, failed save, two windows and offline'}, ensure_ascii=False))
        finally:
            for client in clients:
                client.close()
            process.terminate()
            try: process.wait(timeout=10)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            log.close(); server.shutdown(); server.server_close()


if __name__ == '__main__':
    main()
