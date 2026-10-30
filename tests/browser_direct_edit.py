"""Exercise direct rhythm editing in a real browser using a temporary library."""
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
from browser_cdp import CDP, wait_debugger

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'artifacts'
BROWSER = Path(os.environ.get('BROWSER_BIN', str(Path(os.environ['LOCALAPPDATA']) / 'ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-win64/chrome-headless-shell.exe')))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    checks = []
    server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='hang-direct-edit-') as profile:
        with (ARTIFACTS / 'direct-edit-browser.log').open('w') as log:
            process = subprocess.Popen([str(BROWSER), '--headless', '--disable-gpu', '--in-process-gpu', *(['--no-sandbox'] if os.environ.get('BROWSER_NO_SANDBOX') == '1' else []), '--no-first-run', '--no-default-browser-check', '--remote-allow-origins=*', f'--remote-debugging-port={port}', f'--user-data-dir={profile}', 'about:blank'], stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            client = None
            try:
                client = CDP(wait_debugger(port, process))
                client.call('Page.enable')
                client.call('Runtime.enable')
                client.call('Emulation.setDeviceMetricsOverride', {'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
                url = f'http://127.0.0.1:{server.server_port}/'
                client.call('Page.navigate', {'url':url})
                client.wait('window.HangMobile && HangMobile.getLibrary().length === 3', 'library')

                def check(expression, name):
                    if not client.evaluate(expression):
                        raise AssertionError(name)
                    checks.append(name)
                    print('PASS ' + name, flush=True)

                fixture = client.evaluate('''(async()=>{let t=HangCore.createTab({title:'Свободный ритм',division:2,hands:'split'});t.measures=t.measures.slice(0,2);t.measures[0].rows.R[0]=['D'];t.measures[0].rows.L[0]=['3'];t.measures[0].rows.R[4]=['8'];await MobileStore.saveTab(t);return t.id;})()''')
                client.call('Page.navigate', {'url':url+'?fixture=direct#tab/'+fixture})
                client.wait('HangMobile.getCurrent()?.title === "Свободный ритм"', 'fixture')
                client.click('#auto-advance')
                check('document.querySelectorAll(".note-cell").length === 8 && document.querySelectorAll(".note-cell .cell-hand").length === 16', 'both hands share eight physical time cells')
                check('getComputedStyle(document.querySelector("#editor-screen .hand-R")).color !== getComputedStyle(document.querySelector("#editor-screen .hand-L")).color', 'right and left have distinct colors')
                client.click('[data-action=input-hand][data-hand=L]')
                client.click('.note-cell[data-slot="1"]')
                client.click('#note-pad [data-token="5"]')
                check('HangMobile.getCurrent().measures[0].rows.L[1][0] === "5" && !HangMobile.getCurrent().measures[0].rows.R[1].length', 'hand picker writes only selected hand')
                client.click('#hand-colors')
                check('HangMobile.getCurrent().handColors===false && getComputedStyle(document.querySelector("#editor-screen .hand-R")).color === getComputedStyle(document.querySelector("#editor-screen .hand-L")).color', 'monochrome retains hand identities')
                client.click('#hand-colors')
                client.click('.note-cell[data-slot="3"]')
                client.click('[data-action=split-cell][data-parts="2"]')
                check('(()=>{const t=HangMobile.getCurrent(),s=HangCore.slots(t,0);return s.length===9&&s[2].duration===.5&&s[3].duration===.25&&s[4].duration===.25&&s[5].offset===2&&t.measures[0].rows.R[5][0]==="8"&&s.reduce((n,x)=>n+x.duration,0)===4&&HangCore.slots(t,1).length===8;})()', 'split only the second offbeat into sixteenths, preserve meter and later onsets')
                check('document.getElementById("cell-duration").textContent.includes("1/16")', 'selected cell shows exact duration')
                check('document.querySelector(`.note-cell[data-slot="2"]`).getBoundingClientRect().width > document.querySelector(`.note-cell[data-slot="3"]`).getBoundingClientRect().width * 1.8', 'unequal durations have proportional widths')
                client.click('[data-action=merge-cell]')
                check('HangCore.slots(HangMobile.getCurrent(),0).length===8 && HangMobile.getCurrent().measures[0].rows.R[4][0]==="8"', 'merge restores original offbeat and note alignment')
                client.click('#undo')
                check('HangCore.slots(HangMobile.getCurrent(),0).length===9', 'undo restores subdivision')
                client.click('.note-cell[data-slot="4"]')
                client.click('#note-pad [data-token="2"]')
                client.click('.note-cell[data-slot="3"]')
                client.evaluate('window.confirm=()=>false')
                client.click('[data-action=merge-cell]')
                check('HangCore.slots(HangMobile.getCurrent(),0).length===9 && HangMobile.getCurrent().measures[0].rows.L[4][0]==="2"', 'declining destructive merge preserves filled child cell')
                client.evaluate('window.confirm=()=>true')
                client.click('[data-action=merge-cell]')
                check('HangCore.slots(HangMobile.getCurrent(),0).length===8', 'confirmed merge joins occupied subdivision')
                client.click('#undo')
                check('HangMobile.getCurrent().measures[0].rows.L[4][0]==="2"', 'undo destructive merge restores child notes')
                client.click('[data-action=split-cell][data-parts="3"]')
                check('HangCore.slots(HangMobile.getCurrent(),0)[3].durationFraction==="1/48"', 'nested triplet split has exact rational duration')
                client.click('#undo')
                client.click('[data-action=notation][data-notation=konnakol]')
                check('HangMobile.getCurrent().notation==="konnakol" && document.querySelector("[data-notation=konnakol]").getAttribute("aria-pressed")==="true"', 'notation changes from visible toolbar')
                client.click('[data-action=cell-syllable]')
                client.fill('#cell-syllable-form [name=syllable]', 'Da')
                client.click('#cell-syllable-form [type=submit]')
                check('HangCore.slots(HangMobile.getCurrent(),0)[3].displayLabel==="Da" && HangCore.slots(HangMobile.getCurrent(),1)[3].displayLabel!=="Da"', 'cell syllable override affects only the selected cell')
                client.click('[data-action=syllable-pattern]')
                client.fill('#syllable-pattern-form [name=syllable-0]', 'Pa')
                check('document.getElementById("pattern-preview").textContent==="PaKaDiMi TaKaJoNu"', 'pattern editor previews joined words live')
                client.click('#syllable-pattern-form [type=submit]')
                check('HangCore.slots(HangMobile.getCurrent(),0)[0].syllable==="Pa" && HangCore.slots(HangMobile.getCurrent(),0)[3].syllable==="Da"', 'global pattern updates inherited syllables and preserves explicit override')
                client.click('[data-action=notation][data-notation=hybrid]')
                check('document.querySelectorAll(".grid-count small").length>0 && HangCore.slots(HangMobile.getCurrent(),0)[3].displayLabel==="Da"', 'hybrid retains beat numbers and custom syllables')
                client.click('#marker-mode')
                client.click('#note-pad [data-token="7"]')
                check('document.querySelector(`#note-pad [data-token="7"]`).classList.contains("marker-token")', 'marker palette selects a reusable note')
                client.click('.note-cell[data-slot="6"]')
                client.click('.note-cell[data-slot="7"]')
                check('HangMobile.getCurrent().measures[0].rows.L[6][0]==="7" && HangMobile.getCurrent().measures[0].rows.L[7][0]==="7"', 'marker stamps the selected hand without auto advance')
                client.click('#note-pad [data-token="—"]')
                client.click('.note-cell[data-slot="6"]')
                check('!HangMobile.getCurrent().measures[0].rows.L[6].length', 'marker eraser clears the selected hand')
                client.click('#undo')
                check('HangMobile.getCurrent().measures[0].rows.L[6][0]==="7"', 'undo restores erased marker stroke')
                client.click('#marker-mode')
                for width,height in [(320,568),(390,844),(844,390),(1100,800)]:
                    client.call('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':width<1000})
                    time.sleep(.15)
                    check('document.documentElement.scrollWidth<=innerWidth', f'no overflow at {width}x{height}')
                    check('document.querySelectorAll("#notation-control button").length===3 && getComputedStyle(document.getElementById("notation-control")).display!=="none"', f'notation picker available at {width}px')
                client.call('Emulation.setDeviceMetricsOverride', {'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
                client.click('.note-cell[data-slot="3"]')
                client.wait('document.getElementById("save-status").textContent==="Сохранено на устройстве"', 'autosave')
                expected=client.evaluate('HangMobile.getCurrent()')
                client.wait('document.getElementById("toast").hidden', 'toast clears')
                time.sleep(.2)
                screenshot=client.call('Page.captureScreenshot', {'format':'png','captureBeyondViewport':False})
                (ARTIFACTS/'mobile-direct-edit.png').write_bytes(base64.b64decode(screenshot['data']))
                client.call('Page.reload')
                client.wait('HangMobile.getCurrent()?.title === "Свободный ритм"', 'reload')
                check('JSON.stringify(HangMobile.getCurrent()) === '+json.dumps(json.dumps(expected,ensure_ascii=False,separators=(',',':'))), 'nested rhythm, pattern, cell override and hand colors survive reload')
                check('(()=>{const t=HangMobile.getCurrent();return JSON.stringify(HangCore.validateTab(JSON.parse(JSON.stringify(t))))===JSON.stringify(t);})()', 'editable JSON roundtrip preserves every new setting')
                client.click('.note-cell[data-slot="2"]')
                check('document.getElementById("merge-cell").disabled', 'parent with finer subdivisions does not offer invalid merge')
                client.click('[data-action=rhythm]')
                client.click('[data-action=division][data-beat="3"][data-value="1"]')
                client.click('[data-action=apply-rhythm]')
                client.click('.note-cell[data-slot="7"]')
                client.click('[data-action=cell-syllable]')
                client.fill('#cell-syllable-form [name=syllable]', 'Dum')
                client.click('#cell-syllable-form [type=submit]')
                check('document.querySelector(`.grid-count[data-slot="7"] small`).textContent==="4" && document.querySelector(`.grid-count[data-slot="7"] span`).textContent==="Dum"', 'hybrid keeps whole beat number above its custom syllable')
                mixed = client.evaluate('''(async()=>{const t=HangCore.createTab({title:'Mixed hands',division:2});t.measures=t.measures.slice(0,2);t.measures[0].rows.main[0]=['D'];t.measures[0].rows.main[1]=['5'];t.measures[0].rows.main[2]=['8'];await MobileStore.saveTab(t);return t.id;})()''')
                client.call('Page.navigate', {'url':url+'?fixture=mixed#tab/'+mixed})
                client.wait('HangMobile.getCurrent()?.title==="Mixed hands"', 'mixed fixture')
                client.click('#auto-advance')
                client.click('.note-cell[data-slot="1"]')
                client.click('#cell-hands')
                check('(()=>{const t=HangMobile.getCurrent();return t.hands==="single"&&HangCore.cellHands(t,0,1)==="split"&&HangCore.cellHands(t,0,0)==="single"&&HangCore.cellHands(t,0,2)==="single"&&t.measures[0].rows.main[0][0]==="D"&&t.measures[0].rows.main[2][0]==="8"&&t.measures[0].rows.R[1][0]==="5";})()', 'adding hands changes only selected cell and moves its existing note to right hand')
                check('document.querySelectorAll(".combined-hands").length===1 && document.querySelectorAll(`.note-cell[data-slot="0"] .cell-hand`).length===1 && document.getElementById("hand-picker").hidden===false', 'plain cells stay visually plain beside one combined hand cell')
                client.click('[data-action=input-hand][data-hand=L]')
                client.click('#note-pad [data-token="9"]')
                check('HangMobile.getCurrent().measures[0].rows.R[1][0]==="5" && HangMobile.getCurrent().measures[0].rows.L[1][0]==="9"', 'simultaneous local right and left notes stay independent')
                client.click('#cell-hands')
                check('HangCore.cellHands(HangMobile.getCurrent(),0,1)==="single" && HangMobile.getCurrent().measures[0].rows.main[1].join("/")==="5/9" && document.getElementById("hand-picker").hidden', 'local hands merge back into a plain chord without losing notes')
                client.click('#undo')
                check('HangCore.cellHands(HangMobile.getCurrent(),0,1)==="split" && HangMobile.getCurrent().measures[0].rows.L[1][0]==="9"', 'undo restores local hand assignment and both notes')
                client.click('[data-action=split-cell][data-parts="2"]')
                check('(()=>{const t=HangMobile.getCurrent();return HangCore.cellHands(t,0,1)==="split"&&HangCore.cellHands(t,0,2)==="split"&&HangCore.cellHands(t,0,3)==="single"&&t.measures[0].rows.main[3][0]==="8"&&t.measures[0].rows.L[1][0]==="9";})()', 'split children inherit local hand mode and later plain note keeps its time')
                client.click('[data-action=merge-cell]')
                check('HangCore.slots(HangMobile.getCurrent(),0).length===8 && HangCore.cellHands(HangMobile.getCurrent(),0,1)==="split"', 'merging children restores the local hand cell')
                client.click('[data-action=input-hand][data-hand=L]')
                client.click('#auto-advance')
                client.click('#note-pad [data-token="7"]')
                check('document.getElementById("hand-picker").hidden && document.querySelector(`.note-cell[data-slot="2"]`).classList.contains("selected")', 'auto advance from local left hand selects next plain cell')
                client.click('#note-pad [data-token="6"]')
                check('HangMobile.getCurrent().measures[0].rows.main[2][0]==="6" && !HangMobile.getCurrent().measures[0].rows.L[2].length', 'entry after auto advance uses the plain row')
                client.click('#auto-advance')
                client.click('.note-cell[data-slot="1"]')
                client.click('[data-action=input-hand][data-hand=L]')
                client.click('#marker-mode')
                client.click('#note-pad [data-token="4"]')
                client.click('.note-cell[data-slot="3"]')
                check('HangCore.cellHands(HangMobile.getCurrent(),0,3)==="single" && HangMobile.getCurrent().measures[0].rows.main[3][0]==="4" && !HangMobile.getCurrent().measures[0].rows.L[3].length', 'marker entering a plain cell does not create or hide hand notes')
                client.click('#marker-mode')
                client.click('.note-cell[data-slot="1"]')
                client.key('ArrowDown')
                check('document.querySelector(`[data-action="input-hand"][data-hand="L"]`).getAttribute("aria-pressed")==="true"', 'keyboard hand navigation uses local hand mode')
                client.click('[data-action=chord]')
                client.fill('#chord-input', '7/9', 'change')
                client.click('[data-action=apply-chord]')
                check('HangMobile.getCurrent().measures[0].rows.L[1].join("/")==="7/9" && HangMobile.getCurrent().measures[0].rows.R[1][0]==="5"', 'local chord editor affects only selected hand')
                client.click('#meter-chip')
                client.fill('#settings-form [name=tempo]', '105', 'change')
                client.click('#settings-form [type=submit]')
                check('HangCore.cellHands(HangMobile.getCurrent(),0,1)==="split" && HangMobile.getCurrent().measures[0].rows.L[1].join("/")==="7/9"', 'saving unrelated settings preserves local hand overrides')
                client.click('.note-cell[data-slot="1"]')
                for width,height in [(320,568),(390,844)]:
                    client.call('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,'deviceScaleFactor':1,'mobile':True})
                    time.sleep(.15)
                    check('document.documentElement.scrollWidth<=innerWidth && document.getElementById("cell-hands").textContent==="Без рук"', f'mixed-hand toolbar fits at {width}px')
                client.wait('document.getElementById("save-status").textContent==="Сохранено на устройстве"', 'mixed autosave')
                client.wait('document.getElementById("toast").hidden', 'mixed toast clears')
                expected_mixed=client.evaluate('HangMobile.getCurrent()')
                screenshot=client.call('Page.captureScreenshot', {'format':'png','captureBeyondViewport':False})
                (ARTIFACTS/'mobile-mixed-hands.png').write_bytes(base64.b64decode(screenshot['data']))
                client.call('Page.reload')
                client.wait('HangMobile.getCurrent()?.title==="Mixed hands"', 'mixed reload')
                check('JSON.stringify(HangMobile.getCurrent()) === '+json.dumps(json.dumps(expected_mixed,separators=(',',':'))), 'mixed hand modes and chord contents survive save and reload')
                client.click('[data-action=library]')
                check('document.querySelector(`[data-id="'+mixed+'"] .mini-score`).textContent.includes("L:7·9") && document.querySelector(`[data-id="'+mixed+'"] .mini-score`).textContent.includes("R:5")', 'library preview includes both hands in mixed documents')
                client.click('[data-action=open-tab][data-id="'+mixed+'"]')
                client.click('#meter-chip')
                client.fill('#settings-form [name=hands]', 'split', 'change')
                client.click('#settings-form [type=submit]')
                check('HangMobile.getCurrent().measures[0].rows.L[1].join("/")==="7/9" && HangMobile.getCurrent().measures[0].rows.R[0][0]==="D"', 'global split preserves existing local hands and converts plain cells')
                client.click('.note-cell[data-slot="1"]')
                client.click('#cell-hands')
                check('HangMobile.getCurrent().hands==="split" && HangCore.cellHands(HangMobile.getCurrent(),0,1)==="single" && document.querySelectorAll(".combined-hands").length===7', 'global split document also supports one plain local cell')
                errors=[event for event in client.events if event.get('method')=='Runtime.exceptionThrown']
                if errors:
                    raise AssertionError(errors)
                checks.append('no uncaught browser exceptions')
                (ARTIFACTS/'direct-edit-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
            finally:
                if client:
                    try:
                        client.call('Browser.close')
                    except (OSError, ConnectionError):
                        pass
                    client.close()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(timeout=5)
                server.shutdown()
                server.server_close()


if __name__ == '__main__':
    main()
