"""Real browser integration checks. No third-party Python packages required."""
from pathlib import Path
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import base64
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from browser_cdp import CDP, wait_debugger, render_png

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
ARTIFACTS.mkdir(exist_ok=True)
BROWSER = Path(os.environ.get('BROWSER_BIN', str(Path(os.environ['LOCALAPPDATA']) / 'ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe')))

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

def main():
    checks = []
    def check(value, message):
        if not value:
            raise AssertionError(message)
        checks.append(message)
        print('PASS ' + message, flush=True)
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='hang-mobile-') as profile:
        log = (ARTIFACTS / 'browser.log').open('w', encoding='utf-8')
        process = subprocess.Popen([str(BROWSER), '--headless', '--disable-gpu', '--in-process-gpu', *(['--no-sandbox'] if os.environ.get('BROWSER_NO_SANDBOX') == '1' else []), '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*', f'--remote-debugging-port={port}', f'--user-data-dir={profile}', 'about:blank'], stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        client = None
        try:
            client = CDP(wait_debugger(port, process))
            client.call('Page.enable')
            client.call('Runtime.enable')
            client.call('Network.enable')
            client.call('Emulation.setDeviceMetricsOverride', {'width':390, 'height':844, 'deviceScaleFactor':1, 'mobile':True})
            url = f'http://127.0.0.1:{server.server_port}/'
            client.call('Page.navigate', {'url':url})
            client.wait('window.HangMobile && HangMobile.getLibrary().length === 3', 'sample library')
            check(client.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'library fits phone width')
            def shot(name):
                result=client.call('Page.captureScreenshot', {'format':'png','captureBeyondViewport':False})
                (ARTIFACTS/name).write_bytes(base64.b64decode(result['data']))
            shot('mobile-library.png')
            client.click('[data-action="new"]')
            client.fill('#new-form [name=title]', 'Вечерний ритм')
            client.click('#new-form [type=submit]')
            client.wait('HangMobile.getCurrent()?.title === "Вечерний ритм"', 'new document')
            check(client.evaluate('HangMobile.getCurrent().measures.length === 1'), 'create document with one measure')
            client.click('#note-pad [data-token=D]')
            client.click('#note-pad [data-token="1"]')
            client.click('#note-pad [data-token="3"]')
            client.click('#note-pad [data-token="5"]')
            check(client.evaluate('JSON.stringify(HangMobile.getCurrent().measures[0].rows.main) === JSON.stringify([["D"],["1"],["3"],["5"]])'), 'pad entry and auto advance')
            client.click('#auto-advance')
            client.click('.note-cell[data-slot="2"]')
            client.click('[data-action=chord]')
            client.fill('#chord-input', 'D/4', 'change')
            client.click('[data-action=apply-chord]')
            check(client.evaluate('HangMobile.getCurrent().measures[0].rows.main[2].join("/") === "D/4"'), 'chord touch input')
            client.click('#undo')
            check(client.evaluate('HangMobile.getCurrent().measures[0].rows.main[2][0] === "3"'), 'undo chord')
            client.click('#redo')
            check(client.evaluate('HangMobile.getCurrent().measures[0].rows.main[2].length === 2'), 'redo chord')
            client.click('.measure-navigation [data-action=duplicate-measure]')
            client.click('[data-action=rhythm]')
            client.click('[data-action=division][data-beat="0"][data-value="2"]')
            client.click('[data-action=apply-rhythm]')
            check(client.evaluate('HangCore.slots(HangMobile.getCurrent(),0).length===4 && HangCore.slots(HangMobile.getCurrent(),1).length===5'), 'rhythm changed only in selected measure')
            client.click('#meter-chip')
            client.fill('#settings-form [name=hands]', 'split', 'change')
            client.fill('#settings-form [name=notation]', 'hybrid', 'change')
            client.fill('#settings-form [name=tempo]', '96', 'change')
            client.click('#settings-form [type=submit]')
            client.click('[data-action=input-hand][data-hand=L]')
            client.click('.note-cell[data-slot="0"]')
            client.click('#note-pad [data-token="8"]')
            check(client.evaluate('HangMobile.getCurrent().measures[1].rows.L[0][0] === "8" && HangMobile.getCurrent().measures[1].rows.R[0][0] === "D"'), 'independent hands preserve previous notes')
            client.wait('document.getElementById("save-status").textContent === "Сохранено на устройстве"', 'autosave')
            client.evaluate('window.scrollTo(0,0)')
            client.wait('document.getElementById("toast").hidden', 'toast disappears')
            shot('mobile-editor.png')
            check(client.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'editor fits phone width')
            check(client.evaluate('document.querySelector(".note-cell").getBoundingClientRect().width >= 47'), 'touch cells remain large')
            expected = client.evaluate('HangMobile.getCurrent()')
            client.call('Page.reload')
            client.wait('window.HangMobile && HangMobile.getCurrent()?.title === "Вечерний ритм"', 'reload saved document')
            check(client.evaluate('HangMobile.getCurrent()') == expected, 'document survives reload with all settings')
            client.click('#play-button')
            client.wait('document.getElementById("play-title").textContent === "Играет ваш ритм"', 'audio running')
            client.click('#play-button')
            check(client.evaluate('document.getElementById("play-title").textContent === "Слушать ритм"'), 'playback starts and stops')
            client.click('#play-button')
            client.click('[data-action=chord]')
            check(client.evaluate('document.getElementById("play-title").textContent === "Слушать ритм"'), 'edit sheet freezes playback selection')
            client.fill('#chord-input', '1/2/3/4/5/6/7/8/9', 'input')
            client.click('[data-action=apply-chord]')
            check(client.evaluate('document.querySelector("#sheet[open] .sheet-error[role=alert]") !== null'), 'validation error appears inside modal')
            client.click('[data-action=close-sheet]')
            client.click('[data-action=export]')
            client.click('[data-action=generate-png]')
            client.wait('document.querySelector(".export-preview img")?.complete && !document.getElementById("generate-png").disabled', 'PNG preview')
            shot('mobile-export.png')
            png, image = render_png(client, 'HangMobile.getCurrent()')
            (ARTIFACTS/'tablature.png').write_bytes(image)
            check(png['width']==1400 and png['height']<=2400 and png['size']>1000, 'real Canvas PNG decodes within mobile size limit')
            client.click('[data-action=close-sheet]')
            for width,height in [(320,568),(844,390),(1100,800)]:
                client.call('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':width<1000})
                time.sleep(.15)
                check(client.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'no page overflow at {width}x{height}')
                if width==844: shot('mobile-landscape.png')
            client.call('Emulation.setDeviceMetricsOverride', {'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
            client.wait('navigator.serviceWorker.controller !== null', 'service worker controls page')
            client.call('Network.emulateNetworkConditions', {'offline':True,'latency':0,'downloadThroughput':0,'uploadThroughput':0})
            client.call('Page.reload')
            client.wait('window.HangMobile && HangMobile.getCurrent()?.title === "Вечерний ритм"', 'offline reload')
            check(client.evaluate('HangMobile.getCurrent()')==expected, 'offline app reload keeps complete document')
            client.click('.note-cell[data-row=R][data-slot="0"]')
            client.click('#note-pad [data-token="12"]')
            client.wait('document.getElementById("save-status").textContent === "Сохранено на устройстве"', 'offline save')
            check(client.evaluate('HangMobile.getCurrent().measures[0].rows.R[0][0] === "12"'), 'editing and saving offline')
            client.call('Network.emulateNetworkConditions', {'offline':False,'latency':0,'downloadThroughput':-1,'uploadThroughput':-1})
            client.click('[data-action=library]')
            doc = {'format':'hang-library','version':1,'tabs':[expected]}
            doc['tabs'][0]['title']='Импорт с компьютера'
            import_path=Path(profile)/'import.json'
            import_path.write_text(json.dumps(doc,ensure_ascii=False),encoding='utf-8')
            root=client.call('DOM.getDocument')
            node=client.call('DOM.querySelector',{'nodeId':root['root']['nodeId'],'selector':'#import-file'})
            client.call('DOM.setFileInputFiles',{'nodeId':node['nodeId'],'files':[str(import_path)]})
            client.wait('HangMobile.getLibrary().some(t=>t.title === "Импорт с компьютера")', 'library import')
            check(client.evaluate('HangMobile.getLibrary().length === 5'), 'backup import merges conflicting ID without overwriting original')
            # Unequal beat units and labels must survive an all-measure division edit.
            fixture = client.evaluate('''(async()=>{let t=HangCore.createTab({title:'Rhythm regression'});t.measures=t.measures.slice(0,2);const a=[{units:1,division:1,label:'1',syllables:[]},{units:1,division:1,label:'2',syllables:[]},{units:2,division:1,label:'3',syllables:[]}];t=HangCore.setRhythm(t,t.meter,a).tab;const b=[{units:1,division:1,label:'A',syllables:[]},{units:2,division:1,label:'B',syllables:[]},{units:1,division:3,label:'C',syllables:['Ta','Ki','Ta']}];t=HangCore.setMeasureRhythm(t,1,b).tab;await MobileStore.saveTab(t);return t.id;})()''')
            client.call('Page.navigate', {'url':url+'?fixture=rhythm#tab/'+fixture})
            client.wait('window.HangMobile && HangMobile.getCurrent()?.title === "Rhythm regression"', 'rhythm fixture')
            client.click('[data-action=rhythm]')
            client.fill('#rhythm-scope', 'all', 'change')
            client.click('[data-action=division][data-beat="0"][data-value="2"]')
            client.click('[data-action=apply-rhythm]')
            check(client.evaluate('''(()=>{const b=HangCore.measureBeats(HangMobile.getCurrent(),1);return b[0].label==='A'&&b[0].division===2&&b[1].units===2&&b[2].division===3&&b[2].syllables.join(' ')==='Ta Ki Ta';})()'''), 'all-measure edits preserve independent labels, units and other beat rhythms')
            # Generate enough output to exercise bounded batches of PNGs.
            long_id = client.evaluate('''(async()=>{const t=HangCore.createTab({title:'Long export'});t.measures=Array.from({length:120},()=>HangCore.emptyMeasure(t));await MobileStore.saveTab(t);return t.id;})()''')
            client.call('Page.navigate', {'url':url+'?fixture=long#tab/'+long_id})
            client.wait('window.HangMobile && HangMobile.getCurrent()?.title === "Long export"', 'long export fixture')
            client.click('[data-action=export]')
            client.click('[data-action=generate-png]')
            client.wait('document.querySelector("[data-action=next-export]") && !document.getElementById("generate-png").disabled', 'first image batch')
            check(client.evaluate('document.querySelectorAll(".export-pages a").length===8'), 'large export keeps only eight PNGs at once')
            client.click('[data-action=next-export]')
            client.wait('document.querySelector(".export-pages a")?.textContent.includes("9") && !document.getElementById("generate-png").disabled', 'next image batch')
            check(client.evaluate('document.querySelectorAll(".export-pages a").length<=8'), 'next image batch continues without retaining prior PNGs')
            errors=[e for e in client.events if e.get('method')=='Runtime.exceptionThrown']
            check(not errors, 'no uncaught browser exceptions')
            (ARTIFACTS/'browser-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks,'png':png},ensure_ascii=False,indent=2),encoding='utf-8')
        except Exception:
            if client:
                print(client.evaluate('JSON.stringify({url:location.href,title:document.title,current:window.HangMobile?.getCurrent()?.title,tabs:window.HangMobile?.getLibrary().map(t=>[t.id,t.title]),error:document.getElementById("storage-error")?.textContent})'),flush=True)
            raise
        finally:
            if client:
                client.close()
            process.terminate()
            try: process.wait(timeout=8)
            except subprocess.TimeoutExpired: process.kill(); process.wait()
            log.close()
            server.shutdown()

if __name__ == '__main__':
    main()
