const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../core.js');

function renderer({ failEncoding = false } = {}) {
  const canvases = [], pages = [];
  const document = {
    createElement(tag) {
      assert.equal(tag, 'canvas');
      const canvas = { width: 300, height: 150 };
      const labels = [];
      const ctx = {
        font: '20px Arial', textAlign: 'left',
        measureText(value) { return { width: [...String(value)].length * Number(this.font.match(/(\d+)px/)[1]) * .6 }; },
        fillText(value, x, y, ...extra) {
          // Supplying maxWidth would hide overlapping columns by compressing
          // note names. The exporter must allocate their actual text width.
          assert.equal(extra.length, 0);
          const width = this.measureText(value).width;
          const left = this.textAlign === 'center' ? x - width / 2 : this.textAlign === 'right' ? x - width : x;
          assert.ok(left >= 0 && left + width <= canvas.width + 1, `Text outside page: ${value}`);
          assert.ok(y > 0 && y < canvas.height, `Text outside page vertically: ${value}`);
          labels.push({ text: String(value), x, y, width });
        },
        fillRect() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}
      };
      canvas.getContext = () => ctx;
      canvas.toBlob = callback => {
        pages.push({ width: canvas.width, height: canvas.height, labels: [...labels] });
        callback(failEncoding ? null : new Blob(['PNG page'], { type: 'image/png' }));
      };
      canvases.push(canvas);
      return canvas;
    }
  };
  const window = { HangCore: C };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../export.js'), 'utf8'), { window, document });
  return { api: window.HangExport, canvases, pages };
}

test('wide hybrid measures keep every chord note, hand and beat across bounded pages', async () => {
  const tab = C.createTab({ title: 'Длинная табулатура', meter: { numerator: 32, denominator: 4 }, division: 16, hands: 'split' });
  tab.notation = 'hybrid';
  tab.measures = tab.measures.slice(0, 1);
  tab.measures[0].label = 'Неровная фраза';
  tab.measures[0].rows.R = tab.measures[0].rows.R.map((_, i) => [`R${i}`, `X${i}`]);
  tab.measures[0].rows.L = tab.measures[0].rows.L.map((_, i) => [`L${i}`]);
  const { api, pages, canvases } = renderer();
  const outputs = await api.renderPNG(tab);
  assert.ok(outputs.length > 1);
  assert.equal(outputs.length, pages.length);
  const allText = pages.flatMap(page => page.labels.map(label => label.text));
  for (let i = 0; i < 512; i++) for (const prefix of ['R', 'X', 'L']) assert.equal(allText.filter(value => value === `${prefix}${i}`).length, 1);
  assert.ok(allText.some(value => /часть 2\//.test(value)));
  assert.ok(allText.some(value => /‹|›/.test(value)), 'Split beats must visibly continue');
  assert.ok(allText.includes('R') && allText.includes('L'));
  for (const page of pages) { assert.equal(page.width, 1400); assert.ok(page.height <= 2400); }
  for (const canvas of canvases) { assert.equal(canvas.width, 1); assert.equal(canvas.height, 1); }
  assert.equal(new Set(outputs.map(item => item.name)).size, outputs.length);
});

test('per-measure rhythms, phrase syllables, appendix and long notes survive export', async () => {
  let tab = C.createTab({ title: 'Тест' });
  tab = C.setMeasureRhythm(tab, 1, C.makeBeats(tab.meter, 3)).tab;
  tab.notation = 'konnakol';
  tab.phrases = [{ size: 2, syllables: ['phraseA', 'phraseB'] }];
  tab.measures[1].rows.main = tab.measures[1].rows.main.map((_, i) => [`own${i}`]);
  tab.phraseExample = { labels: Array.from({ length: 80 }, (_, i) => `syllable${i}`), notes: Array.from({ length: 80 }, (_, i) => [`example${i}`]) };
  tab.notes = Array.from({ length: 150 }, (_, i) => `Заметка-${i}`).join('\n');
  const { api, pages } = renderer();
  await api.renderPNG(tab);
  const texts = pages.flatMap(page => page.labels.map(label => label.text));
  for (let i = 0; i < 12; i++) assert.equal(texts.filter(value => value === `own${i}`).length, 1);
  for (let i = 0; i < 80; i++) { assert.equal(texts.filter(value => value === `example${i}`).length, 1); assert.equal(texts.filter(value => value === `syllable${i}`).length, 1); }
  for (let i = 0; i < 150; i++) assert.equal(texts.filter(value => value === `Заметка-${i}`).length, 1);
  assert.ok(texts.includes('phraseA') && texts.includes('phraseB'));
  assert.ok(pages.every(page => page.height <= 2400));
});

test('lazy iteration encodes only requested pages, releases canvas and snapshots the document', async () => {
  const tab = C.createTab();
  tab.measures = Array.from({ length: 25 }, () => C.emptyMeasure(tab));
  tab.measures[24].rows.main[0] = ['original'];
  const { api, pages, canvases } = renderer();
  const iterator = api.renderPages(tab);
  assert.equal(pages.length, 0);
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.equal(pages.length, 1);
  assert.ok(canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
  tab.measures[24].rows.main[0] = ['changed'];
  for await (const _ of iterator) { /* consume the snapshot */ }
  const texts = pages.flatMap(page => page.labels.map(label => label.text));
  assert.ok(texts.includes('original'));
  assert.ok(!texts.includes('changed'));
  const cancelled = api.renderPages(tab);
  await cancelled.next();
  const encoded = pages.length;
  await cancelled.return();
  assert.equal(pages.length, encoded);
});

test('single measure retains its original number, and encoding failures free pixels', async () => {
  const tab = C.createTab();
  tab.measures.forEach((measure, i) => { measure.rows.main[0] = [`measure${i}`]; });
  const { api, pages } = renderer();
  const result = await api.renderPNG(tab, { measureIndex: 2 });
  const texts = pages.flatMap(page => page.labels.map(label => label.text));
  assert.ok(texts.includes('Такт 3') && texts.includes('measure2'));
  assert.ok(!texts.includes('measure0'));
  assert.match(result[0].name, /_такт-3\.png$/);
  await assert.rejects(api.renderPNG(tab, { measureIndex: 9 }), /существующий такт/);
  const failing = renderer({ failEncoding: true });
  await assert.rejects(failing.api.renderPNG(tab), /сформировать PNG/);
  assert.ok(failing.canvases.every(canvas => canvas.width === 1 && canvas.height === 1));
});
