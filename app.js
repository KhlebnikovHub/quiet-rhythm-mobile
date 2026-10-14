/* Mobile UI. The musical document stays compatible with Hang Creator v1. */
(() => {
  'use strict';
  const C = window.HangCore, S = window.MobileStore;
  const native = window.HangNative, isNative = native?.isNative === true;
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const tokens = ['D','S','K','—',...Array.from({length:12}, (_, i) => String(i + 1))];
  const state = {tabs:[], id:null, measure:0, slot:0, row:'main', mode:'write', auto:true, playing:false, playMeasure:false, loop:false, metronome:false, storageReady:false, histories:new Map(), saves:new Map()};
  let sheetType = '', toastTimer, rhythmDraft, chordDraft = [], exportFiles = [], exportGeneration = 0, exportIterator = null, installPrompt;
  const current = () => state.tabs.find(tab => tab.id === state.id);
  const history = () => { if (!state.histories.has(state.id)) state.histories.set(state.id, {undo:[],redo:[]}); return state.histories.get(state.id); };
  function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false; $('toast').classList.toggle('error-notice', error); toastTimer = setTimeout(() => {$('toast').hidden = true;}, error ? 6500 : 3000); }
  function report(error) {const message=error?.message||String(error);if($('sheet').open){let box=$('sheet-body').querySelector('.sheet-error');if(!box){box=document.createElement('p');box.className='notice error-notice sheet-error';box.setAttribute('role','alert');$('sheet-body').prepend(box);}box.textContent=message;box.scrollIntoView({block:'nearest'});}else toast(message,true);}
  const player = window.HangPlayback.create({
    onState(playing) { state.playing = playing; renderTransport(); },
    onPosition(position) {
      document.querySelectorAll('.note-cell.playing').forEach(cell => cell.classList.remove('playing'));
      if (!position || !current()) return;
      if (state.measure !== position.measure) {state.measure = position.measure; state.slot = position.slot; renderScore(); renderNav();}
      const cells = document.querySelectorAll(`.note-cell[data-slot="${position.slot}"]`);
      cells.forEach(cell => cell.classList.add('playing'));
      if (cells[0]) revealCell(cells[0]);
    }, onError:message => toast(message, true)
  });
  function renderSave() {
    const status = state.saves.get(state.id);
    $('save-status').textContent = !state.storageReady ? 'В памяти · сохраните копию' : status?.error ? 'Не сохранено · сделайте копию' : status?.pending ? 'Сохраняем…' : 'Сохранено на устройстве';
    $('save-status').classList.toggle('failed', !state.storageReady || !!status?.error);
  }
  function persist(tab) {
    if (!state.storageReady) return;
    const marker = {pending:true}; state.saves.set(tab.id, marker); renderSave();
    S.saveTab(tab).then(() => {if (state.saves.get(tab.id) === marker) state.saves.set(tab.id, {pending:false}); renderSave();}, error => {
      if (state.saves.get(tab.id) === marker) state.saves.set(tab.id, {error:true}); renderSave();
      $('storage-error').textContent = 'Не удалось сохранить изменения на устройстве. Скачайте резервную копию библиотеки. ' + error.message;
      $('storage-error').hidden = false; report(error);
    });
  }
  function trimHistory(items) {let size = items.reduce((n, x) => n + x.length, 0); while (items.length > 40 || size > 5000000 && items.length > 1) size -= items.shift().length;}
  function commit(change, message) {
    const previous = current(); if (!previous) return;
    const copy = C.clone(previous); const output = change(copy); const tab = C.validateTab(output || copy);
    const before = JSON.stringify(previous); if (before === JSON.stringify(tab)) return;
    player.stop(); const h = history(); h.undo.push(before); trimHistory(h.undo); h.redo = [];
    state.tabs[state.tabs.findIndex(item => item.id === state.id)] = tab;
    clampSelection(); persist(tab); renderEditor(); if (message) toast(message);
  }
  function clampSelection() {
    const tab = current(); if (!tab) return;
    state.measure = Math.max(0, Math.min(tab.measures.length - 1, state.measure));
    state.slot = Math.max(0, Math.min(C.slots(tab, state.measure).length - 1, state.slot));
    if (tab.hands === 'single') state.row = 'main'; else if (!['R','L'].includes(state.row)) state.row = 'R';
  }
  function undo(redo = false) {
    const h = history(), from = redo ? h.redo : h.undo, to = redo ? h.undo : h.redo;
    if (!from.length) return; player.stop(); to.push(JSON.stringify(current())); trimHistory(to);
    const tab = C.validateTab(JSON.parse(from.pop())); state.tabs[state.tabs.findIndex(item => item.id === state.id)] = tab;
    clampSelection(); persist(tab); renderEditor();
  }
  function renderLibrary() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const tabs = state.tabs.filter(tab => (tab.title + ' ' + tab.subtitle).toLocaleLowerCase().includes(query));
    $('library-count').textContent = String(state.tabs.length).padStart(2,'0');
    $('library-list').innerHTML = tabs.length ? tabs.map((tab, i) => {
      const row = tab.hands === 'split' ? 'R' : 'main';
      const mini = tab.measures[0].rows[row].slice(0,9).map(cell => `<span>${esc(cell.length ? cell.join('·') : '—')}</span>`).join('');
      return `<button class="tab-item" data-action="open-tab" data-id="${esc(tab.id)}"><span class="tab-number">${String(i+1).padStart(2,'0')}</span><span class="tab-info"><strong>${esc(tab.title)}</strong><small>${tab.meter.numerator}/${tab.meter.denominator} &nbsp;·&nbsp; ${tab.measures.length} такт. &nbsp;·&nbsp; ${tab.tempo} BPM${tab.hands==='split'?' &nbsp;·&nbsp; R / L':''}</small><span class="mini-score" aria-hidden="true">${mini}</span></span>${icon('next')}</button>`;
    }).join('') : `<div class="empty-library">${query ? 'Такого ритма пока нет.<br>Попробуйте другое название.' : 'Здесь будет ваша музыка.<br>Создайте табулатуру или откройте файл.'}</div>`;
  }
  function showLibrary() {player.stop(); closeSheet(); location.hash = 'library'; renderScreen(false);}
  function openTab(id) {if (!state.tabs.some(tab => tab.id === id)) return; player.stop(); state.id=id; state.measure=0;state.slot=0;state.row='main';state.mode='write';clampSelection(); if(state.storageReady) S.setCurrent(id).catch(report); location.hash = 'tab/' + id; renderScreen(true);}
  function renderScreen(editor) { $('library-screen').hidden=editor; $('editor-screen').hidden=!editor; document.body.classList.toggle('editor-open',editor); if(editor) renderEditor(); else renderLibrary(); window.scrollTo({top:0,behavior:'instant'}); updateDockSize();if(editor)requestAnimationFrame(ensureSelectionVisible); }
  function renderEditor() {
    const tab=current(); if(!tab) return;
    $('editor-title').textContent=tab.title; document.title=tab.title+' · Тихий ритм';
    $('meter-chip').textContent=tab.meter.numerator+'/'+tab.meter.denominator;
    $('tempo-chip').textContent=tab.tempo+' BPM'; $('hands-chip').textContent=tab.hands==='split'?'Правая / левая':'Одна партия';
    $('editor-screen').classList.toggle('listen-only',state.mode==='listen');
    $('write-mode').setAttribute('aria-pressed',state.mode==='write'); $('listen-mode').setAttribute('aria-pressed',state.mode==='listen');
    const h=history(); $('undo').disabled=!h.undo.length; $('redo').disabled=!h.redo.length;
    renderSave();renderNav();renderScore();renderTransport();updateDockSize();
  }
  function renderNav() {
    const tab=current(); if(!tab)return;
    const nav=$('measure-nav'), scroll=nav.scrollLeft;
    nav.innerHTML=tab.measures.map((m,i)=>`<button data-action="select-measure" data-index="${i}" aria-label="Такт ${i+1}" aria-current="${i===state.measure}">${String(i+1).padStart(2,'0')}</button>`).join('')+'<button class="nav-add" data-action="add-measure" aria-label="Добавить такт">+</button>';
    nav.scrollLeft=scroll;
    const active=nav.querySelector('[aria-current=true]'); if(active) {const left=active.offsetLeft-nav.offsetLeft;if(left<nav.scrollLeft)nav.scrollLeft=left;if(left+active.offsetWidth>nav.scrollLeft+nav.clientWidth)nav.scrollLeft=left+active.offsetWidth-nav.clientWidth;}
  }
  function renderScore() {
    const tab=current(); if(!tab)return;clampSelection();
    const measure=tab.measures[state.measure], slots=C.slots(tab,state.measure), rows=tab.hands==='split'?['R','L']:['main'];
    $('measure-title').textContent='Такт '+String(state.measure+1).padStart(2,'0');
    $('measure-label').textContent=measure.label; $('measure-label').hidden=!measure.label;
    const scroller=$('grid-scroll'), scroll=scroller.scrollLeft, grid=$('score-grid');
    const labelWidth=tab.hands==='split'?30:25;
    grid.style.gridTemplateColumns=`${labelWidth}px repeat(${slots.length}, minmax(48px, 1fr))`;
    grid.style.width=Math.max(scroller.clientWidth, labelWidth+slots.length*48)+'px';
    grid.innerHTML='<span class="grid-count" aria-hidden="true">'+(tab.hands==='split'?'R/L':'♪')+'</span>'+slots.map(s=>`<button class="grid-count ${s.groupStart?'beat-start':''} ${s.beat===slots[state.slot].beat?'current-beat':''}" data-action="beat-rhythm" data-beat="${s.beat}" aria-label="Настроить долю ${s.beat+1}">${tab.notation==='hybrid'&&C.measureBeats(tab,state.measure)[s.beat].division>1?`<small>${s.sub===0?esc(C.measureBeats(tab,state.measure)[s.beat].label):'·'}</small>`:''}<span>${esc(s.displayLabel)}</span></button>`).join('')+rows.map(row=>`<span class="row-label" aria-label="${row==='R'?'Правая рука':row==='L'?'Левая рука':'Ноты'}">${row==='main'?'♪':row}</span>`+measure.rows[row].map((cell,i)=>`<button class="note-cell ${slots[i].groupStart?'beat-start':''} ${state.row===row&&state.slot===i?'selected':''}" data-action="select-cell" data-slot="${i}" data-row="${row}" aria-pressed="${state.row===row&&state.slot===i}" aria-label="${row==='R'?'Правая':row==='L'?'Левая':'Нота'}, доля ${slots[i].beat+1}, позиция ${i+1}: ${esc(cell.length?cell.join(', '):'пауза')}">${cell.length?cell.map(n=>`<span>${esc(n)}</span>`).join(''):'<span class="rest">—</span>'}</button>`).join('')).join('');
    scroller.scrollLeft=scroll;
    $('rhythm-caption').textContent=C.measureBeats(tab,state.measure).map(b=>b.division).join(' + ')+' · '+slots.length+' поз.';
    document.querySelector('.scroll-hint').hidden=grid.scrollWidth<=scroller.clientWidth+2;
    $('previous-measure').disabled=state.measure===0; $('next-measure').disabled=state.measure===tab.measures.length-1;
    $('editor-hint').textContent=state.mode==='listen'?'Слушайте и следите за подсветкой. Звуки условные — для проверки ритма.':'Коснитесь ячейки, затем выберите ноту внизу. Нажмите на счёт, чтобы изменить деление доли.';
    $('phrase-example').hidden=!tab.phraseExample;
    if(tab.phraseExample)$('phrase-example').textContent='Фразировка из оригинала · '+tab.phraseExample.notes.map(C.tokenText).join('  ');
    renderSelection();
  }
  function revealCell(cell) {const box=$('grid-scroll'); const left=cell.offsetLeft-$('score-grid').offsetLeft; if(left<box.scrollLeft+30)box.scrollLeft=Math.max(0,left-30);else if(left+cell.offsetWidth>box.scrollLeft+box.clientWidth)box.scrollLeft=left+cell.offsetWidth-box.clientWidth;}
  function renderSelection() {
    const tab=current();if(!tab)return;const slot=C.slots(tab,state.measure)[state.slot], cell=tab.measures[state.measure].rows[state.row][state.slot];
    $('selection-context').textContent=`Такт ${state.measure+1} · доля ${slot.beat+1}${state.row==='main'?'':' · '+state.row}`;
    document.querySelectorAll('.note-cell').forEach(node=>{const selected=Number(node.dataset.slot)===state.slot&&node.dataset.row===state.row;node.classList.toggle('selected',selected);node.setAttribute('aria-pressed',selected);});
    document.querySelectorAll('#note-pad button').forEach(button=>button.classList.toggle('in-cell',cell.includes(button.dataset.token)));
    requestAnimationFrame(ensureSelectionVisible);
  }
  function ensureSelectionVisible(){if($('sheet').open||$('editor-screen').hidden||state.mode==='listen')return;const cell=document.querySelector('.note-cell.selected');if(!cell)return;const rect=cell.getBoundingClientRect(),top=document.querySelector('.editor-header').getBoundingClientRect().bottom+8;const dock=$('entry-dock');const bottom=getComputedStyle(dock).position==='fixed'?dock.getBoundingClientRect().top-8:innerHeight-8;if(rect.bottom>bottom)window.scrollBy(0,rect.bottom-bottom);else if(rect.top<top)window.scrollBy(0,rect.top-top);}
  function moveCell(step) {const tab=current();const count=C.slots(tab,state.measure).length;state.slot+=step;if(state.slot>=count){if(state.measure<tab.measures.length-1){state.measure++;state.slot=0;}else state.slot=count-1;}if(state.slot<0){if(state.measure>0){state.measure--;state.slot=C.slots(tab,state.measure).length-1;}else state.slot=0;}renderNav();renderScore();const node=document.querySelector('.note-cell.selected');if(node)revealCell(node);}
  function enterNote(token) {if(state.mode!=='write')return;commit(tab=>{tab.measures[state.measure].rows[state.row][state.slot]=C.parseToken(token);});if(state.auto)moveCell(1);else renderSelection();}
  function selectMeasure(index) {player.stop();state.measure=index;state.slot=0;clampSelection();renderEditor();}
  function addMeasure(copy=false) {if(current().measures.length>=512)throw Error('В одном произведении — до 512 тактов.');const index=state.measure;commit(tab=>{const m=C.clone(tab.measures[index]);m.id=C.uid();if(!copy){m.label='';for(const key of ['main','R','L'])m.rows[key]=m.rows[key].map(()=>[]);}tab.measures.splice(index+1,0,m);});state.measure=index+1;state.slot=0;renderEditor();toast(copy?'Такт повторён':'Новый такт готов');}
  function renderTransport() {const tab=current();$('play-button').innerHTML=icon(state.playing?'stop':'play');$('play-button').setAttribute('aria-label',state.playing?'Остановить':'Прослушать');$('play-title').textContent=state.playing?'Играет ваш ритм':'Слушать ритм';$('play-detail').textContent=(state.playMeasure?'Этот такт':'Всё произведение')+' · '+(tab?.tempo||90)+' BPM'+(state.metronome?' · метроном':'');$('loop-button').setAttribute('aria-pressed',state.loop);}
  function updateDockSize() {if(!$('editor-screen').hidden)document.documentElement.style.setProperty('--dock-height',Math.ceil($('entry-dock').getBoundingClientRect().height)+'px');}
  function openSheet(title,html,type) {player.stop();closeSheet();sheetType=type;$('sheet-title').textContent=title;$('sheet-body').innerHTML=html;$('sheet').showModal();$('sheet').scrollTop=0;const focus=$('sheet').querySelector('[autofocus]');if(focus)focus.focus();}
  function releaseExportFiles() {for(const item of exportFiles)URL.revokeObjectURL(item.url);exportFiles=[];}
  function cleanExport() {exportGeneration++;releaseExportFiles();if(exportIterator){exportIterator.return().catch(()=>{});exportIterator=null;}}
  function closeSheet() {if($('sheet').open)$('sheet').close();if(sheetType==='export')cleanExport();sheetType='';}
  function meterOptions(value) {return [1,2,4,8,16,32].map(n=>`<option value="${n}" ${n===value?'selected':''}>${n}</option>`).join('');}
  function newSheet() {openSheet('Начнём с ритма',`<p>Дайте мелодии имя. Остальное можно изменить в любой момент.</p><form id="new-form"><label class="field">Название<input name="title" maxlength="160" placeholder="Мой новый ритм" required value="Новый ритм"></label><div class="form-row"><label class="field">Размер<select name="meter">${['4/4','3/4','6/8','7/8','7/4','8/4','12/8'].map(m=>`<option>${m}</option>`).join('')}</select></label><label class="field">Партии<select name="hands"><option value="single">Одна строка</option><option value="split">Правая / левая</option></select></label></div><button class="button primary full" type="submit">${icon('plus')}Создать табулатуру</button></form>`,'new');}
  function settingsSheet() {
    const t=current();openSheet('О произведении',`<form id="settings-form"><label class="field">Название<input name="title" value="${esc(t.title)}" maxlength="300" required></label><label class="field">Подзаголовок<input name="subtitle" value="${esc(t.subtitle)}" maxlength="500" placeholder="Исполнитель, строй, настроение…"></label><div class="form-row"><label class="field">Доли<input name="numerator" type="number" min="1" max="32" value="${t.meter.numerator}" required></label><label class="field">Длительность<select name="denominator">${meterOptions(t.meter.denominator)}</select></label><label class="field">Темп · BPM<input name="tempo" type="number" min="20" max="400" value="${t.tempo}" required></label></div><div class="form-row"><label class="field">Партии<select name="hands"><option value="single" ${t.hands==='single'?'selected':''}>Одна строка</option><option value="split" ${t.hands==='split'?'selected':''}>Правая / левая</option></select></label><label class="field">Запись<select name="notation">${Object.entries({count:'Счёт',konnakol:'Коннакол',hybrid:'Гибрид'}).map(([k,v])=>`<option value="${k}" ${t.notation===k?'selected':''}>${v}</option>`).join('')}</select></label></div><details><summary>Фразы и заметки</summary><label class="field">Группы коннакола<input name="phrases" value="${t.phrases.map(p=>p.size).join('+')}" placeholder="Например: 3+3+2"><small>Пустое поле — по долям. В гибриде используются деления такта.</small></label><label class="field">Заметки<textarea name="notes" maxlength="20000">${esc(t.notes)}</textarea></label></details><button class="button primary full" type="submit">Готово</button><div class="sheet-actions"><button class="button secondary" type="button" data-action="duplicate-tab">${icon('copy')}Копия</button><button class="button secondary danger" type="button" data-action="delete-tab">${icon('trash')}Удалить</button></div></form>`,'settings');
  }
  function rhythmSheet(beatIndex) {
    const tab=current();rhythmDraft=C.clone(C.measureBeats(tab,state.measure));
    openSheet('Ритм такта '+(state.measure+1),`<p class="sheet-help">Разделите доли на части. Ноты сохраняют своё положение во времени.</p><label class="field">Применить<select id="rhythm-scope"><option value="measure">Только этот такт</option><option value="all">Все такты произведения</option></select></label><div id="rhythm-beats"></div><p class="sheet-help">Слоги разделяйте пробелами. Оставьте поле пустым для автоматических слогов.</p><button class="button primary full" data-action="apply-rhythm">Применить ритм</button>`,'rhythm');renderRhythmBeats();
    if(beatIndex!==undefined)setTimeout(()=>document.getElementById('beat-setting-'+beatIndex)?.scrollIntoView({block:'nearest'}),30);
  }
  function renderRhythmBeats() {$('rhythm-beats').innerHTML=rhythmDraft.map((beat,i)=>`<section class="beat-setting" id="beat-setting-${i}"><header><strong>Доля ${esc(beat.label)}</strong><span class="muted">${beat.division} част.</span></header><div class="division-choices">${[1,2,3,4,6,8].map(n=>`<button data-action="division" data-beat="${i}" data-value="${n}" aria-pressed="${beat.division===n}" aria-label="Доля ${i+1}: ${n} частей">${n}</button>`).join('')}<input type="number" min="1" max="16" value="${beat.division}" data-division="${i}" aria-label="Своё деление доли ${i+1}"></div><label class="field">Слоги<input data-syllables="${i}" value="${esc(beat.syllables.join(' '))}" placeholder="Автоматически"></label></section>`).join('');}
  function applyRhythm() {
    let tab=C.clone(current()),lost=0;const all=$('rhythm-scope').value==='all';
    const source=C.measureBeats(current(),state.measure); const changed=rhythmDraft.map((b,i)=>({division:b.division!==source[i].division,syllables:JSON.stringify(b.syllables)!==JSON.stringify(source[i].syllables)}));
    for(let i=0;i<tab.measures.length;i++){if(!all&&i!==state.measure)continue;let beats=all?C.clone(C.measureBeats(tab,i)):C.clone(rhythmDraft);if(all){if(beats.length!==rhythmDraft.length)throw Error('В такте '+(i+1)+' другое число долей. Измените его ритм отдельно.');beats=beats.map((b,j)=>{const diff=changed[j],draft=rhythmDraft[j];if(diff.division){b.division=draft.division;if(b.syllables.length!==b.division)b.syllables=[];}if(diff.syllables){if(draft.syllables.length&&draft.syllables.length!==b.division)throw Error('Слоги не подходят к делению такта '+(i+1)+'. Выберите только этот такт или измените деление.');b.syllables=C.clone(draft.syllables);}return b;});}const result=C.setMeasureRhythm(tab,i,beats);tab=result.tab;lost+=result.lost;}
    if(lost&&!confirm(`При таком делении ${lost} заполненных ячеек не попадут в новую сетку. Применить? Изменение можно отменить.`))return;
    commit(()=>tab,'Ритм обновлён');closeSheet();
  }
  function chordSheet() {chordDraft=C.clone(current().measures[state.measure].rows[state.row][state.slot]);openSheet('Соберите аккорд',`<p class="sheet-help">Выберите несколько нот для одного удара. До восьми нот в ячейке.</p><div id="chord-pad" class="chord-pad"></div><label class="field">Точная запись<input id="chord-input" value="${esc(chordDraft.join('/'))}" placeholder="Например: D/4 или 2/4/8" autocapitalize="characters" autocomplete="off"><small>Можно ввести свои обозначения через /.</small></label><button class="button primary full" data-action="apply-chord">Поставить аккорд</button>`,'chord');renderChord();}
  function renderChord() {$('chord-pad').innerHTML=tokens.filter(t=>t!=='—').map(t=>`<button data-action="chord-token" data-token="${t}" aria-pressed="${chordDraft.includes(t)}">${t}</button>`).join('');}
  function measureMenu() {const m=current().measures[state.measure];openSheet('Такт '+(state.measure+1),`<label class="field">Подпись<input id="measure-name" value="${esc(m.label)}" maxlength="200" placeholder="Например: вступление"></label><button class="button secondary full" data-action="save-measure-name">Сохранить подпись</button><div class="menu-list"><button data-action="duplicate-measure">${icon('copy')}Повторить такт</button><button data-action="add-measure">${icon('plus')}Вставить пустой после этого</button><button data-action="move-measure-back" ${state.measure===0?'disabled':''}>${icon('back')}Переместить раньше</button><button data-action="move-measure-forward" ${state.measure===current().measures.length-1?'disabled':''}>${icon('next')}Переместить позже</button><button data-action="clear-measure">${icon('grid')}Очистить ноты</button><button data-action="delete-measure" class="danger" ${current().measures.length===1?'disabled':''}>${icon('trash')}Удалить такт</button></div>`,'measure-menu');}
  function playSettings() {const t=current();openSheet('Слушать и пробовать',`<form id="play-form"><label class="field">Темп · BPM<input type="number" name="tempo" min="20" max="400" value="${t.tempo}" required></label><label class="field">Что играть<select name="range"><option value="all" ${!state.playMeasure?'selected':''}>Всё произведение</option><option value="measure" ${state.playMeasure?'selected':''}>Только выбранный такт</option></select></label><label class="check-field"><input type="checkbox" name="loop" ${state.loop?'checked':''}>Повторять</label><label class="check-field"><input type="checkbox" name="metronome" ${state.metronome?'checked':''}>Метроном</label><p class="sheet-help">Синтезированные звуки помогают проверить ритм. При сворачивании приложения воспроизведение останавливается.</p><button class="button primary full" type="submit">Готово</button></form>`,'play');}
  async function download(blob,name) {
    if(isNative){const saved=await native.saveFile(blob,name);if(saved)exportNotice('Файл сохранён в выбранную папку');return saved;}
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);return true;
  }
  function exportNotice(message) {if(!$('sheet').open){toast(message);return;}let notice=$('sheet-body').querySelector('.export-status');if(!notice){notice=document.createElement('p');notice.className='notice export-status';notice.setAttribute('role','status');$('sheet-body').prepend(notice);}notice.textContent=message;notice.scrollIntoView({block:'nearest'});}
  function jsonBlob(value) {return new Blob([JSON.stringify(value,null,2)],{type:'application/json'});}
  function safeName(name) {return (name||'tablature').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100);}
  async function backup() {const saved=await download(jsonBlob({format:'hang-library',version:1,exportedAt:new Date().toISOString(),tabs:state.tabs}),'Тихий-ритм-библиотека.json');if(saved&&!isNative)exportNotice('Копия библиотеки подготовлена');}
  function exportSheet() {openSheet('Поделиться ритмом',`<p>Картинка для отправки. JSON — чтобы продолжить редактировать на другом устройстве.</p><label class="field">Экспортировать<select id="export-range"><option value="all">Всё произведение</option><option value="measure">Только такт ${state.measure+1}</option></select></label><button class="button primary full" data-action="generate-png" id="generate-png">${icon('export')}Подготовить PNG</button><div id="export-result" aria-live="polite"></div><button class="button secondary full" data-action="export-json" style="margin-top:14px">Сохранить табулатуру · JSON</button>`,'export');}
  async function generatePNG() {
    cleanExport(); const generation=exportGeneration, tab=C.clone(current());const opts=$('export-range').value==='measure'?{measureIndex:state.measure}:{};
    exportIterator=HangExport.renderPages(tab,opts);
    await exportBatch(generation);
  }
  async function exportBatch(generation=exportGeneration) {
    const iterator=exportIterator;if(!iterator)return;
    releaseExportFiles();
    $('generate-png').disabled=true;$('export-range').disabled=true;$('export-result').innerHTML='<p class="sheet-help">Рисуем табулатуру…</p>';
    try {
      for(let i=0;i<8;i++){const result=await iterator.next();if(generation!==exportGeneration)return;if(result.done){exportIterator=null;break;}const page=result.value;exportFiles.push({...page,url:URL.createObjectURL(page.blob)});$('export-result').innerHTML=`<p class="sheet-help">Готовим изображение ${page.page} из ${page.total}…</p>`;if(page.page===page.total){await iterator.return();exportIterator=null;break;}await new Promise(resolve=>setTimeout(resolve,0));}
      if(generation!==exportGeneration)return;
      const files=exportFiles.map(p=>new File([p.blob],p.name,{type:'image/png'}));
      let canShare=isNative;try{canShare=canShare||!!navigator.canShare?.({files});}catch{}
      $('export-result').innerHTML=`${exportIterator?`<p class="notice">Изображения ${exportFiles[0].page}–${exportFiles.at(-1).page} из ${exportFiles[0].total}. Сохраните эту часть, затем перейдите к следующей.</p>`:''}<div class="export-preview">${exportFiles.slice(0,3).map(p=>`<figure><img src="${p.url}" alt="Табулатура, страница ${p.page}" loading="lazy"><figcaption>Изображение ${p.page} из ${p.total}</figcaption></figure>`).join('')}</div>${exportFiles.length>3?'<p class="sheet-help">В предпросмотре первые три изображения этой части. Ниже можно скачать каждое.</p>':''}${canShare?`<button class="button primary full" data-action="share-png">${icon('export')}Поделиться${files.length>1?' этой частью':''}</button>`:''}<div class="export-pages" style="margin-top:10px">${exportFiles.map(p=>`<a class="button secondary" href="${p.url}" download="${esc(p.name)}">${icon('import')}Скачать PNG${p.total>1?' · '+p.page:''}</a>`).join('')}</div>${exportIterator?'<button class="button primary full" style="margin-top:14px" data-action="next-export">Следующие изображения →</button>':''}<p class="sheet-help">Если скачивание недоступно, нажмите на картинку: откроется изображение для сохранения.</p>`;
      if(isNative){
        $('export-result').querySelectorAll('a[download]').forEach((link,index)=>{const button=document.createElement('button');button.className=link.className;button.dataset.action='save-png';button.dataset.page=String(index);button.innerHTML=link.innerHTML.replace('Скачать PNG','Сохранить PNG');link.replaceWith(button);});
        $('export-result').lastElementChild.textContent='«Сохранить PNG» откроет выбор папки на телефоне. «Поделиться» отправит изображения в другое приложение.';
      }else $('export-result').querySelectorAll('.export-preview img').forEach(img=>{img.style.cursor='pointer';img.onclick=()=>window.open(img.src,'_blank','noopener');});
    }catch(error){if(generation===exportGeneration){$('export-result').textContent='Не удалось подготовить PNG. Попробуйте экспорт одного такта.';report(error);}}
    finally{if(generation===exportGeneration){$('generate-png').disabled=false;$('generate-png').textContent='Подготовить заново';$('export-range').disabled=false;}}
  }
  function nativeHelpSheet() {
    openSheet('Музыка без интернета',`<p>Всё необходимое уже внутри приложения. Создание и редактирование табулатур, прослушивание и экспорт работают без интернета — даже при первом запуске.</p><details open><summary>Сохранить картинку или табулатуру</summary><p>Откройте экспорт в редакторе → «Подготовить PNG» → «Сохранить PNG» и выберите папку на телефоне. «Поделиться» открывает список приложений для отправки. Для продолжения редактирования сохраняйте JSON.</p></details><details><summary>Где хранится музыка</summary><p>Изменения автоматически сохраняются на этом телефоне. «Резервная копия» сохраняет всю библиотеку отдельным файлом. Её можно открыть на другом телефоне через «Открыть файл».</p><p>Удаление приложения или очистка его данных удаляет локальную библиотеку. Сохраняйте резервные копии важных работ. Автоматической синхронизации между устройствами нет.</p></details><details><summary>Как записывать</summary><p>Коснитесь ячейки, затем выберите ноту внизу. «Аккорд» объединяет несколько нот. «Автопереход» переводит курсор дальше. Касание счёта открывает деление доли. R — правая рука, L — левая.</p></details><button class="button secondary full" data-action="backup">Сохранить резервную копию</button>`,'help');
  }
  async function importFiles(files) {
    const imported=[];
    for(const file of files) {if(file.size>10000000)throw Error('Файл слишком большой (максимум 10 МБ).');const text=(await file.text()).replace(/^\uFEFF/,'');if(/\.txt$/i.test(file.name))imported.push(C.importText(text,file.name.replace(/\.txt$/i,'')));else{const input=JSON.parse(text);if(input.format==='hang-library'){if(input.version!==1||!Array.isArray(input.tabs)||input.tabs.length>1000)throw Error('Некорректная копия библиотеки.');imported.push(...input.tabs.map(C.validateTab));}else imported.push(C.validateTab(input));}}
    const seen=new Map(state.tabs.map(t=>[t.id,t])), added=[];
    for(let tab of imported){const existing=seen.get(tab.id);if(existing&&JSON.stringify(existing)===JSON.stringify(tab))continue;if(existing)tab={...tab,id:C.uid()};seen.set(tab.id,tab);added.push(tab);}
    if(!added.length){toast('Эти табулатуры уже в библиотеке');return;}
    if(state.storageReady)await S.saveTabs(added);
    state.tabs.push(...added);renderLibrary();toast(`Добавлено: ${added.length}`);if(added.length===1)openTab(added[0].id);
  }
  function helpSheet() {openSheet('Ритм всегда с вами',`<p>Создавайте табулатуры, слушайте и сохраняйте их в картинки. Работы хранятся на этом устройстве.</p><details open><summary>Добавить на главный экран</summary><p><b>iPhone:</b> откройте ссылку в Safari → «Поделиться» → «На экран Домой». Если есть переключатель «Открывать как веб-приложение», включите его.</p><p><b>Android:</b> в меню браузера выберите «Установить приложение» или «Добавить на главный экран».</p></details><details><summary>Работать без интернета</summary><p>При первом открытии нужен интернет. Дождитесь надписи «Готово без интернета» в библиотеке. После этого приложение и сохранённые табулатуры доступны автономно. Обновления загрузятся при следующем подключении.</p></details><details><summary>Сохранить и перенести музыку</summary><p>Изменения сохраняются автоматически. «Резервная копия» скачивает всю библиотеку. На другом устройстве выберите «Открыть файл». PNG — картинка, JSON — редактируемая табулатура.</p><p>Очистка данных сайта удаляет локальную библиотеку. Для важных работ сохраняйте резервную копию. Автоматической синхронизации между устройствами нет.</p></details><details><summary>Как записывать</summary><p>Выберите ячейку и нажмите D, S, K или номер поля. «Аккорд» объединяет несколько нот. «Автопереход» переводит курсор дальше. Нажатие на счёт открывает деление доли. R — правая рука, L — левая.</p><p>На компьютере: стрелки — перемещение, цифры и D/S/K — ввод, Delete — очистить, Ctrl/Cmd+Z — отменить, пробел — прослушать.</p></details><button class="button secondary full" data-action="backup">Сохранить резервную копию</button>`,'help');}
  const actions={
    'new':newSheet, 'library':showLibrary, 'open-tab':b=>openTab(b.dataset.id), 'settings':settingsSheet,
    'select-measure':b=>selectMeasure(Number(b.dataset.index)), 'previous-measure':()=>selectMeasure(state.measure-1), 'next-measure':()=>selectMeasure(state.measure+1),
    'select-cell':b=>{if(state.mode==='listen')return;player.stop();state.slot=Number(b.dataset.slot);state.row=b.dataset.row;renderSelection();},
    'note':b=>enterNote(b.dataset.token==='—'?'-':b.dataset.token), 'next-cell':()=>moveCell(1), 'previous-cell':()=>moveCell(-1),
    'clear-cell':()=>commit(tab=>{tab.measures[state.measure].rows[state.row][state.slot]=[];}), 'undo':()=>undo(), 'redo':()=>undo(true),
    'rhythm':()=>rhythmSheet(), 'beat-rhythm':b=>rhythmSheet(Number(b.dataset.beat)), 'apply-rhythm':applyRhythm,
    'division':b=>{const beat=rhythmDraft[Number(b.dataset.beat)];const n=Number(b.dataset.value);if(beat.division!==n){beat.division=n;beat.syllables=[];}renderRhythmBeats();},
    'chord':chordSheet, 'chord-token':b=>{const t=b.dataset.token;if(chordDraft.includes(t))chordDraft=chordDraft.filter(n=>n!==t);else{if(chordDraft.length>=8)throw Error('До восьми нот в аккорде.');chordDraft.push(t);}$('chord-input').value=chordDraft.join('/');renderChord();},
    'apply-chord':()=>{const notes=C.parseToken($('chord-input').value);commit(tab=>{tab.measures[state.measure].rows[state.row][state.slot]=notes;});closeSheet();if(state.auto)moveCell(1);},
    'measure-menu':measureMenu, 'save-measure-name':()=>{const label=$('measure-name').value;commit(t=>{t.measures[state.measure].label=label;});closeSheet();},
    'add-measure':()=>{addMeasure();closeSheet();}, 'duplicate-measure':()=>{addMeasure(true);closeSheet();},
    'move-measure-back':()=>moveMeasure(-1), 'move-measure-forward':()=>moveMeasure(1),
    'clear-measure':()=>{if(!confirm('Очистить все ноты этого такта? Изменение можно отменить.'))return;commit(t=>{for(const row of ['main','R','L'])t.measures[state.measure].rows[row]=t.measures[state.measure].rows[row].map(()=>[]);});closeSheet();},
    'delete-measure':()=>{if(current().measures.length===1)return;if(!confirm('Удалить этот такт? Изменение можно отменить.'))return;commit(t=>{t.measures.splice(state.measure,1);});closeSheet();},
    'duplicate-tab':async()=>{const tab=C.clone(current());tab.id=C.uid();tab.title=(tab.title+' — копия').slice(0,300);if(state.storageReady)await S.saveTab(tab);state.tabs.unshift(tab);closeSheet();openTab(tab.id);toast('Копия создана');},
    'delete-tab':async()=>{const tab=current();if(!confirm(`Удалить «${tab.title}» из библиотеки? Для сохранения работы сначала экспортируйте JSON.`))return;if(state.storageReady)await S.deleteTab(tab.id);state.tabs=state.tabs.filter(t=>t.id!==tab.id);state.histories.delete(tab.id);state.id=null;showLibrary();toast('Табулатура удалена');},
    'write-mode':()=>{state.mode='write';renderEditor();}, 'listen-mode':()=>{state.mode='listen';renderEditor();},
    'play':()=>{if(state.playing)player.stop();else player.play(current(),{measure:state.playMeasure?state.measure:null,loop:state.loop,metronome:state.metronome});},
    'loop':()=>{state.loop=!state.loop;if(state.playing)player.stop();renderTransport();}, 'play-settings':playSettings,
    'import':()=>$('import-file').click(), 'backup':backup, 'export':exportSheet, 'generate-png':generatePNG, 'next-export':()=>exportBatch(),
    'export-json':()=>download(jsonBlob(current()),safeName(current().title)+'.json'),
    'save-png':async button=>{const page=exportFiles[Number(button.dataset.page)];if(!page)return;button.disabled=true;try{await download(page.blob,page.name);}finally{button.disabled=false;}},
    'share-png':async button=>{button.disabled=true;try{if(isNative)await native.shareFiles(exportFiles,current().title);else await navigator.share({files:exportFiles.map(p=>new File([p.blob],p.name,{type:'image/png'})),title:current().title});}catch(error){if(error.name!=='AbortError')throw error;}finally{button.disabled=false;}},
    'close-sheet':closeSheet,'help':isNative?nativeHelpSheet:helpSheet,'install':async()=>{if(installPrompt){await installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;}else helpSheet();}
  };
  function moveMeasure(step){const index=state.measure,next=index+step;if(next<0||next>=current().measures.length)return;commit(t=>{[t.measures[index],t.measures[next]]=[t.measures[next],t.measures[index]];});state.measure=next;renderEditor();closeSheet();}
  document.addEventListener('click',async event=>{const button=event.target.closest('[data-action]');if(!button||button.disabled)return;try{await actions[button.dataset.action]?.(button);}catch(error){report(error);}});
  document.addEventListener('submit',async event=>{
    const form=event.target;if(!['new-form','settings-form','play-form'].includes(form.id))return;event.preventDefault();
    const submit=form.querySelector('[type=submit]');submit.disabled=true;
    try{
      const data=new FormData(form);
      if(form.id==='new-form'){const [numerator,denominator]=data.get('meter').split('/').map(Number);const tab=C.createTab({title:String(data.get('title')).trim()||'Новый ритм',meter:{numerator,denominator},hands:data.get('hands')});tab.measures=tab.measures.slice(0,1);if(state.storageReady)await S.saveTab(tab);state.tabs.unshift(tab);closeSheet();openTab(tab.id);S.requestPersistence().catch(()=>{});}
      if(form.id==='settings-form'){
        let tab=C.clone(current());const numerator=Number(data.get('numerator')),denominator=Number(data.get('denominator'));
        if(numerator!==tab.meter.numerator||denominator!==tab.meter.denominator){const meter={numerator,denominator},result=C.setRhythm(tab,meter,C.makeBeats(meter));if(!confirm('Изменение размера перестроит сетку всех тактов.'+(result.lost?` Не поместятся заполненные ячейки: ${result.lost}.`:'')+' Продолжить?'))return;tab=result.tab;}
        tab=C.setHands(tab,data.get('hands'));tab.title=String(data.get('title')).trim()||'Без названия';tab.subtitle=data.get('subtitle');tab.tempo=Number(data.get('tempo'));tab.notation=data.get('notation');tab.notes=data.get('notes');
        const groups=String(data.get('phrases')).trim();if(groups!==current().phrases.map(p=>p.size).join('+')){if(groups&&!/^\d+(\s*\+\s*\d+)*$/.test(groups))throw Error('Укажите группы числами через +, например 3+3+2.');tab.phrases=groups?groups.split('+').map(n=>({size:Number(n),syllables:[]})):[];}
        commit(()=>tab);closeSheet();
      }
      if(form.id==='play-form'){const tempo=Number(data.get('tempo'));commit(t=>{t.tempo=tempo;});state.playMeasure=data.get('range')==='measure';state.loop=data.has('loop');state.metronome=data.has('metronome');player.stop();renderTransport();closeSheet();}
    }catch(error){report(error);}finally{submit.disabled=false;}
  });
  document.addEventListener('change',event=>{const el=event.target;try{
    if(el.id==='auto-advance')state.auto=el.checked;
    if(el.dataset.division!==undefined){const n=Number(el.value);if(!Number.isInteger(n)||n<1||n>16)throw Error('Деление — от 1 до 16 частей.');const beat=rhythmDraft[Number(el.dataset.division)];if(beat.division!==n){beat.division=n;beat.syllables=[];}renderRhythmBeats();}
    if(el.dataset.syllables!==undefined){const beat=rhythmDraft[Number(el.dataset.syllables)];beat.syllables=el.value.trim()?el.value.trim().split(/\s+/):[];}
    if(el.id==='chord-input'){chordDraft=C.parseToken(el.value);renderChord();}
  }catch(error){report(error);}});
  $('search').addEventListener('input',renderLibrary);
  $('import-file').addEventListener('change',async event=>{try{await importFiles([...event.target.files]);}catch(error){report(error);}finally{event.target.value='';}});
  $('sheet').addEventListener('click',event=>{if(event.target===$('sheet')){const rect=$('sheet').getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeSheet();}});
  $('sheet').addEventListener('close',()=>{if($('sheet').open)return;if(sheetType==='export')cleanExport();sheetType='';});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)player.stop();});
  window.addEventListener('hang-native-pause',()=>player.stop());
  window.addEventListener('hang-native-back',event=>{if($('sheet').open){event.preventDefault();closeSheet();}else if(!$('editor-screen').hidden){event.preventDefault();showLibrary();}});
  window.addEventListener('hashchange',()=>{const id=location.hash.startsWith('#tab/')?location.hash.slice(5):null;if(id&&state.tabs.some(t=>t.id===id)){if(state.id!==id)openTab(id);else renderScreen(true);}else{player.stop();closeSheet();renderScreen(false);}});
  window.addEventListener('resize',()=>{updateDockSize();if(current()&&!$('editor-screen').hidden)renderScore();});
  if(window.ResizeObserver)new ResizeObserver(updateDockSize).observe($('entry-dock'));
  document.addEventListener('keydown',event=>{
    if($('editor-screen').hidden||$('sheet').open||/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)||event.altKey)return;
    if((event.ctrlKey||event.metaKey)&&event.code==='KeyZ'){event.preventDefault();undo(event.shiftKey);return;}
    if((event.ctrlKey||event.metaKey)&&event.code==='KeyY'){event.preventDefault();undo(true);return;}
    if(event.ctrlKey||event.metaKey)return;
    if(event.code==='Space'){event.preventDefault();actions.play();return;}if(event.code==='Escape'){player.stop();return;}
    if(state.mode==='listen')return;
    try{if(event.key==='ArrowRight'||event.key==='ArrowLeft'){event.preventDefault();moveCell(event.key==='ArrowRight'?1:-1);}else if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();if(current().hands==='split'){state.row=event.key==='ArrowUp'?'R':'L';renderSelection();}}else if(['Delete','Backspace'].includes(event.key)){event.preventDefault();actions['clear-cell']();}else if(['KeyD','KeyS','KeyK'].includes(event.code)){event.preventDefault();enterNote(event.code.slice(3));}else if(/^[1-9]$/.test(event.key)){event.preventDefault();enterNote(event.key);}else if(event.key==='-'){event.preventDefault();enterNote('-');}else if(event.key==='Enter'){event.preventDefault();chordSheet();}}catch(error){report(error);}
  });
  $('note-pad').innerHTML=tokens.map(t=>`<button class="${['D','S','K','—'].includes(t)?'special':''}" data-action="note" data-token="${t}" aria-label="${({D:'Ding',S:'Slap',K:'Ka','—':'Пауза'})[t]||'Поле '+t}">${t}${['D','S','K','—'].includes(t)?`<small>${({D:'Ding',S:'Slap',K:'Ka','—':'пауза'})[t]}</small>`:''}</button>`).join('');
  let offlineReady=false;
  function connectivity(){ $('offline-status').textContent=isNative?'Полностью офлайн · на этом телефоне':offlineReady?(navigator.onLine?'Готово без интернета':'Работаем без интернета'):navigator.onLine?'На этом устройстве':'Нет сети · локальная библиотека'; }
  window.addEventListener('online',connectivity);window.addEventListener('offline',connectivity);
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install-tip').hidden=false;});
  async function setupPWA(){
    if(isNative){$('install-tip').hidden=true;connectivity();return;}
    $('install-tip').hidden=matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
    if(!('serviceWorker' in navigator)||!window.isSecureContext){connectivity();return;}
    try{const reg=await navigator.serviceWorker.register('./sw.js');await navigator.serviceWorker.ready;offlineReady=true;connectivity();if(reg.waiting)toast('Обновление готово. Закройте все окна приложения и откройте снова.');reg.addEventListener('updatefound',()=>{const worker=reg.installing;worker?.addEventListener('statechange',()=>{if(worker.state==='installed'&&navigator.serviceWorker.controller)toast('Есть обновление. Оно применится после закрытия всех окон приложения.');});});}catch{connectivity();}
  }
  const ready=(async()=>{
    try{const saved=await S.initialize(HangSamples);state.tabs=saved.tabs;state.storageReady=true;}
    catch(error){$('storage-error').hidden=false;$('storage-error').textContent='Хранилище недоступно. Существующие данные не изменены. Новые работы будут только в памяти — сохраняйте JSON перед закрытием. '+error.message;}
    renderLibrary();const id=location.hash.startsWith('#tab/')?location.hash.slice(5):null;if(id&&state.tabs.some(t=>t.id===id))openTab(id);setupPWA();
  })();
  window.HangMobile={ready,getCurrent:()=>current()?C.clone(current()):null,getLibrary:()=>C.clone(state.tabs)};
})();
