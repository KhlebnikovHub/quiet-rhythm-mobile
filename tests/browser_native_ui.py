"""Real browser UI checks with a mocked native picker; does not simulate iOS/Android."""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import json
import os
import socket
import subprocess
import tempfile
import threading
from browser_cdp import CDP, wait_debugger

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
BROWSER = Path(os.environ.get('BROWSER_BIN', str(Path(os.environ['LOCALAPPDATA']) / 'ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe')))

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args): pass

def main():
    checks = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='hang-native-ui-') as profile:
        with (ARTIFACTS / 'native-ui-browser.log').open('w') as log:
            process = subprocess.Popen([str(BROWSER), '--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--remote-allow-origins=*', f'--remote-debugging-port={port}', f'--user-data-dir={profile}', 'about:blank'], stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            client = None
            try:
                client = CDP(wait_debugger(port, process))
                client.call('Page.enable'); client.call('Runtime.enable')
                client.call('Emulation.setDeviceMetricsOverride', {'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
                client.call('Page.addScriptToEvaluateOnNewDocument', {'source': '''
                  window.savedFiles=[];window.sharedFiles=[];window.saveResult=true;window.saveError=false;
                  window.HangNative={isNative:true,
                    async saveFile(blob,name){if(window.saveError)throw Error('Picker failed');window.savedFiles.push({name,type:blob.type,size:blob.size,text:blob.type==='application/json'?await blob.text():null});return window.saveResult;},
                    async shareFiles(files,title){window.sharedFiles.push({title,count:files.length});return true;}};
                '''})
                client.call('Page.navigate', {'url':f'http://127.0.0.1:{server.server_port}/'})
                client.wait('window.HangMobile && HangMobile.getLibrary().length===3', 'library')
                def check(expression, name):
                    if not client.evaluate(expression): raise AssertionError(name)
                    checks.append(name); print('PASS '+name, flush=True)
                check('document.getElementById("install-tip").hidden && document.getElementById("offline-status").textContent.includes("Полностью офлайн")', 'native UI hides web installation and shows local mode')
                check('(async()=>!(await navigator.serviceWorker.getRegistrations()).length)()', 'native UI does not register a service worker')
                client.click('[data-action=help]')
                check('document.getElementById("sheet-body").textContent.includes("даже при первом запуске") && !document.getElementById("sheet-body").textContent.includes("Safari")', 'native help describes bundled app')
                client.evaluate('window.dispatchEvent(new Event("hang-native-back",{cancelable:true}))')
                check('!document.getElementById("sheet").open', 'Android back closes open sheet')
                client.click('[data-action=backup]')
                client.wait('savedFiles.length===1', 'backup export')
                check('JSON.parse(savedFiles[0].text).tabs.length===3 && savedFiles[0].name.endsWith(".json")', 'native backup receives complete editable JSON')
                client.click('[data-action=new]')
                client.fill('#new-form [name=title]', 'Native export')
                client.click('#new-form [type=submit]')
                client.wait('HangMobile.getCurrent()?.title==="Native export"', 'new doc')
                client.click('#note-pad [data-token=D]')
                client.click('[data-action=export]'); client.click('[data-action=generate-png]')
                client.wait('!!document.querySelector("[data-action=save-png]")', 'native PNG')
                check('document.querySelectorAll(".export-pages a[download]").length===0', 'native exports use save buttons instead of blob downloads')
                client.click('[data-action=save-png]')
                client.wait('savedFiles.length===2', 'PNG passed to picker')
                check('savedFiles[1].type==="image/png" && savedFiles[1].size>1000', 'real PNG is passed to native save adapter')
                client.click('[data-action=share-png]')
                client.wait('sharedFiles.length===1', 'PNG sharing')
                check('sharedFiles[0].count===1 && sharedFiles[0].title==="Native export"', 'sharing uses native adapter')
                client.evaluate('window.saveResult=false;document.querySelector(".export-status")?.remove()')
                client.click('[data-action=save-png]')
                client.wait('savedFiles.length===3 && !document.querySelector("[data-action=save-png]").disabled', 'cancel save')
                check('!document.querySelector(".export-status")', 'cancelled save does not claim success')
                client.evaluate('window.saveError=true')
                client.click('[data-action=save-png]')
                client.wait('!!document.querySelector(".sheet-error")', 'save error')
                check('document.querySelector(".sheet-error").textContent==="Picker failed" && !document.querySelector("[data-action=save-png]").disabled', 'picker error remains visible and retry stays available')
                client.click('[data-action=close-sheet]')
                client.click('#play-button')
                client.wait('document.getElementById("play-title").textContent.includes("Играет")', 'audio')
                client.evaluate('window.dispatchEvent(new Event("hang-native-pause"))')
                check('document.getElementById("play-title").textContent==="Слушать ритм"', 'native background event stops playback')
                client.evaluate('window.dispatchEvent(new Event("hang-native-back",{cancelable:true}))')
                check('document.getElementById("editor-screen").hidden', 'Android back returns to library')
                check('!document.documentElement.scrollWidth || document.documentElement.scrollWidth<=innerWidth', 'native UI fits phone viewport')
                (ARTIFACTS / 'native-ui-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks},indent=2),encoding='utf8')
            except Exception:
                if client:
                    print(client.evaluate('JSON.stringify({current:HangMobile.getCurrent()?.title,sheet:document.getElementById("sheet-body").innerHTML})'), flush=True)
                    print([event for event in client.events if event.get('method')=='Runtime.exceptionThrown'], flush=True)
                raise
            finally:
                if client:
                    try: client.call('Browser.close')
                    except (ConnectionError, OSError): pass
                    client.close()
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired: process.terminate(); process.wait(timeout=5)
                server.shutdown(); server.server_close()

if __name__ == '__main__': main()
