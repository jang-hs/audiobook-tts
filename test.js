// Self-check for the pure helpers in main.js. Run: node test.js
// Stubs `obsidian` so main.js loads outside Obsidian.
const Module = require('module');
const orig = Module._load;
Module._load = (req, ...rest) => (req === 'obsidian'
  ? { Plugin: class {}, PluginSettingTab: class {}, FuzzySuggestModal: class {} }
  : orig(req, ...rest));

const assert = require('assert');
const { cleanMarkdown, chunkText, renderTable, concatWavBuffers } = require('./main.js')._internal;

// ---- cleanMarkdown ----
const opts = { skipCode: true, readTables: true, readParens: true, tableOrder: 'row' };
const md = [
  '---', 'title: meta', '---',
  '# Heading',
  '',
  'Hello [world](http://a.b) and `code` and https://bare.url',
  '',
  '```js', 'drop me', '```',
  '',
  '| Part | Role |', '| --- | --- |', '| CPU | compute |',
].join('\n');
const clean = cleanMarkdown(md, opts);
assert(!clean.includes('title: meta'), 'frontmatter kept');
assert(!clean.includes('drop me'), 'code block kept');
assert(!clean.includes('http'), 'url kept');
assert(clean.includes('Heading.'), 'heading lost its sentence stop');
assert(clean.includes('Hello world'), 'link text lost');
assert(clean.includes('CPU: compute.'), 'table not spoken');
assert(!cleanMarkdown('a (b) c', { ...opts, readParens: false }).includes('b'), 'parens kept');

// ---- chunkText ----
const chunks = chunkText('가나다라마바사 아자차카타파하. ' .repeat(20), 40);
assert(chunks.every((c) => c.length <= 40), 'chunk over maxLen');
assert(chunks.join('').includes('가나다라마바사'), 'text mangled');
assert(chunkText('one. two. three.', 100).length === 1, 'over-split short text');
// A single unbreakable run still terminates and loses nothing.
const long = chunkText('x'.repeat(250), 100);
assert(long.join('').length === 250, 'hard-cut path dropped characters');

// ---- renderTable ----
assert.deepStrictEqual(
  renderTable(['Part', 'Role'], [['CPU', 'compute'], ['RAM', 'storage']], 'row'),
  ['CPU: compute.', 'RAM: storage.'],
);
assert.deepStrictEqual(
  renderTable(['Part', 'Role'], [['CPU', 'compute'], ['RAM', 'storage']], 'col'),
  ['Part: CPU, RAM.', 'Role: compute, storage.'],
);

// ---- concatWavBuffers ----
function wav(nBytes, fill) {
  const buf = new ArrayBuffer(44 + nBytes);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const tag = (s, off) => [...s].forEach((c, i) => u8[off + i] = c.charCodeAt(0));
  tag('RIFF', 0); dv.setUint32(4, 36 + nBytes, true); tag('WAVE', 8);
  tag('fmt ', 12); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 24000, true); dv.setUint32(28, 48000, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag('data', 36); dv.setUint32(40, nBytes, true);
  u8.fill(fill, 44);
  return buf;
}
const out = concatWavBuffers([wav(100, 1), wav(60, 2)]);
const odv = new DataView(out.buffer);
assert.strictEqual(String.fromCharCode(...out.slice(0, 4)), 'RIFF');
assert.strictEqual(odv.getUint32(4, true), out.byteLength - 8, 'RIFF size wrong');
assert.strictEqual(odv.getUint32(40, true), 160, 'data size not summed');
assert.strictEqual(out[44], 1, 'first buffer misplaced');
assert.strictEqual(out[144], 2, 'second buffer misplaced');

console.log('ok');
