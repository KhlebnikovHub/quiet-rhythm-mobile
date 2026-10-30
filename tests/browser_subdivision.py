"""Browser coverage for arbitrary cell divisions and PWA installation affordances."""
import base64
import json
import os
import socket
import subprocess
import tempfile
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from browser_cdp import CDP, wait_debugger
from browser_direct_edit import ARTIFACTS, BROWSER, Handler, ROOT


def run_checks(client, url, check):
    client.click('[data-action=library]')
    check('!document.getElementById("install-tip").hidden && document.querySelector("#install-tip [data-action=install]").textContent.includes("Установить")', 'web library always exposes installation including browsers without install prompt')
    client.evaluate('window.installPromptCalls=0;const installEvent=new Event("beforeinstallprompt",{cancelable:true});installEvent.prompt=async()=>{window.installPromptCalls++;};installEvent.userChoice=Promise.resolve({outcome:"dismissed"});window.dispatchEvent(installEvent)')
    client.click('#install-tip [data-action=install]')
    check('window.installPromptCalls===1', 'install button uses retained native beforeinstallprompt event')
    client.click('#install-tip [data-action=install]')
    check('document.getElementById("sheet-body").textContent.includes("Safari") && document.getElementById("sheet-body").textContent.includes("Домой") && document.getElementById("sheet-body").textContent.includes("Android")', 'installation without browser prompt shows iOS and Android instructions')
    client.click('[data-action=close-sheet]')
    client.click('[data-action=help]')
    check('!!document.querySelector("[data-action=check-updates]") && !!document.getElementById("pwa-check-status")', 'help includes explicit update check and persistent result area')
    client.click('[data-action=close-sheet]')
    client.evaluate('window.dispatchEvent(new Event("appinstalled"))')
    check('document.getElementById("install-tip").hidden', 'successful app installation hides the install button')
    divisions = client.evaluate('''(async()=>{const t=HangCore.createTab({title:'Arbitrary divisions'});t.measures=t.measures.slice(0,1);t.measures[0].rows.main[0]=['D'];t.measures[0].rows.main[1]=['8'];await MobileStore.saveTab(t);return t.id;})()''')
    client.call('Page.navigate', {'url':url+'?fixture=divisions#tab/'+divisions})
    client.wait('HangMobile.getCurrent()?.title==="Arbitrary divisions"', 'division fixture')
    client.click('#cell-tools [data-action=split-cell][data-parts="4"]')
    check('(()=>{const t=HangMobile.getCurrent(),s=HangCore.slots(t,0);return s.length===7&&s[0].durationFraction==="1/16"&&s[4].offset===1&&t.measures[0].rows.main[4][0]==="8";})()', 'direct divide by four preserves quarter boundary and later notes')
    client.click('#undo')
    for parts,fraction in [(6,'1/24'),(8,'1/32'),(32,'1/128')]:
        client.click('#cell-tools [data-action=custom-split]')
        client.fill('#split-form [name=parts]', str(parts))
        client.click('#split-form [type=submit]')
        check(f'HangCore.slots(HangMobile.getCurrent(),0).length==={parts+3} && HangCore.slots(HangMobile.getCurrent(),0)[0].durationFraction==="{fraction}" && HangMobile.getCurrent().measures[0].rows.main[{parts}][0]==="8"', f'custom division into {parts} parts preserves exact timing')
        client.click('#undo')
    client.click('#cell-tools [data-action=custom-split]')
    untouched=client.evaluate('JSON.stringify(HangMobile.getCurrent())')
    for invalid in ['0','1','2.5','65','']:
        client.fill('#split-form [name=parts]', invalid)
        client.click('#split-form [type=submit]')
        check('JSON.stringify(HangMobile.getCurrent())==='+json.dumps(untouched)+' && !!document.querySelector(".sheet-error[role=alert]")', f'invalid custom subdivision {invalid!r} reports error without mutation')
    client.call('Emulation.setDeviceMetricsOverride', {'width':320,'height':568,'deviceScaleFactor':1,'mobile':True})
    check('document.documentElement.scrollWidth<=innerWidth && document.getElementById("sheet").scrollWidth<=document.getElementById("sheet").clientWidth', 'custom division sheet fits a 320px phone')
    client.fill('#split-form [name=parts]', '64')
    client.click('#split-form [type=submit]')
    check('HangCore.slots(HangMobile.getCurrent(),0).length===67 && document.querySelector("#cell-tools [data-action=custom-split]").disabled && document.querySelector(`#cell-tools [data-parts="4"]`).disabled', 'maximum subdivision disables further splitting at beat capacity')
    client.click('#cell-tools [data-action=merge-cell]')
    check('HangCore.slots(HangMobile.getCurrent(),0).length===4 && HangMobile.getCurrent().measures[0].rows.main[1][0]==="8"', 'merge restores a beat after a 64-way split')
    client.click('#cell-tools [data-action=split-cell][data-parts="2"]')
    client.click('#cell-tools [data-action=custom-split]')
    check('document.querySelector("#split-form [name=parts]").max==="63"', 'custom subdivision maximum accounts for existing cells in its beat')
    untouched=client.evaluate('JSON.stringify(HangMobile.getCurrent())')
    client.fill('#split-form [name=parts]', '64')
    client.click('#split-form [type=submit]')
    check('JSON.stringify(HangMobile.getCurrent())==='+json.dumps(untouched)+' && !!document.querySelector(".sheet-error")', 'over-capacity split is rejected without changing an existing subdivision')
    client.fill('#split-form [name=parts]', '63')
    client.click('#split-form [type=submit]')
    check('HangCore.slots(HangMobile.getCurrent(),0).length===67 && HangCore.slots(HangMobile.getCurrent(),0)[0].durationFraction==="1/504"', 'largest remaining division is accepted with exact rational duration')


def main():
    ARTIFACTS.mkdir(exist_ok=True)
    checks=[]
    server=ThreadingHTTPServer(('127.0.0.1',0),partial(Handler,directory=str(ROOT)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0))
        port=sock.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix='hang-subdivision-') as profile:
        with (ARTIFACTS/'subdivision-browser.log').open('w') as log:
            process=subprocess.Popen([str(BROWSER),'--headless','--disable-gpu','--in-process-gpu',*(['--no-sandbox'] if os.environ.get('BROWSER_NO_SANDBOX')=='1' else []),'--no-first-run','--remote-allow-origins=*',f'--remote-debugging-port={port}',f'--user-data-dir={profile}','about:blank'],stdout=log,stderr=log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            client=None
            try:
                client=CDP(wait_debugger(port,process))
                client.call('Page.enable')
                client.call('Runtime.enable')
                client.call('Emulation.setDeviceMetricsOverride',{'width':390,'height':844,'deviceScaleFactor':1,'mobile':True})
                url=f'http://127.0.0.1:{server.server_port}/'
                client.call('Page.navigate',{'url':url})
                client.wait('window.HangMobile && HangMobile.getLibrary().length===3','library')
                def check(expression,name):
                    if not client.evaluate(expression):raise AssertionError(name)
                    checks.append(name)
                    print('PASS '+name,flush=True)
                run_checks(client,url,check)
                errors=[event for event in client.events if event.get('method')=='Runtime.exceptionThrown']
                if errors:raise AssertionError(errors)
                checks.append('no uncaught browser exceptions')
                (ARTIFACTS/'subdivision-results.json').write_text(json.dumps({'passed':len(checks),'checks':checks},ensure_ascii=False,indent=2),encoding='utf-8')
            finally:
                if client:
                    try:client.call('Browser.close')
                    except (OSError,ConnectionError):pass
                    client.close()
                try:process.wait(timeout=8)
                except subprocess.TimeoutExpired:process.terminate();process.wait(timeout=5)
                server.shutdown();server.server_close()


if __name__=='__main__':main()
