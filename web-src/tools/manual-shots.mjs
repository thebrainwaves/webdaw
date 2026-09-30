// Screenshots for the user manual (docs/img/). Run after `node tools/build.mjs`: node tools/manual-shots.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'docs', 'img'); fs.mkdirSync(OUT, { recursive: true });
const PORT = +(process.env.PORT || 8798), BASE = '/daw/';
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, executablePath: process.env.DAW_BROWSER, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const done = [];
async function page(vp, prefs, start = true) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: vp.width < 500 ? 2 : 1, hasTouch: vp.width < 500, permissions: ['microphone'] });
  await ctx.addInitScript((p) => localStorage.setItem('auduio.prefs', JSON.stringify(p)), prefs);
  const pg = await ctx.newPage(); pg.on('pageerror', (e) => console.log('pageerror', e.message));
  await pg.goto(`http://localhost:${PORT}${BASE}?nosw`);
  if (start) { await pg.click('#startBtn'); await pg.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay')); await sleep(400); }
  return pg;
}
const snap = async (pg, name, opts = {}) => { try { await pg.screenshot({ path: path.join(OUT, name + '.png'), ...opts }); done.push(name); } catch (e) { console.log('shot failed', name, e.message); } };
const E = (pg, fn, a) => pg.evaluate(fn, a);
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log('step failed:', name, e.message.split('\n')[0]); } };
const view = (pg, v) => E(pg, (v) => document.querySelector(`.views button[data-view=${v}]`).click(), v);
const DEMO = () => {
  const { engine, S } = __daw; const sr = engine.ctx.sampleRate;
  const mk = (id, secs, f, shape) => { const b = engine.ctx.createBuffer(2, sr * secs, sr); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = shape(t) * Math.sin(2 * Math.PI * f * t + c * 0.3); } } engine.buffers.set(id, b); };
  mk('bv', 16, 220, (t) => 0.5 * (0.6 + 0.4 * Math.sin(t * 1.7)) * Math.min(1, (t % 4) * 3) * Math.exp(-((t % 4) > 3.2 ? ((t % 4) - 3.2) * 8 : 0)));
  mk('bg', 16, 110, (t) => 0.6 * Math.exp(-(t % 0.5) * 5));
  const [a, b] = S.project.tracks; a.name = 'Vocal'; b.name = 'Guitar';
  a.arrangement = [{ id: 'v1', bufferId: 'bv', start: 0, offset: 0, duration: 8, name: 'Vocal take', takes: [{ bufferId: 'bv', duration: 8 }, { bufferId: 'bv', duration: 8 }, { bufferId: 'bv', duration: 8 }], take: 2 }, { id: 'v2', bufferId: 'bv', start: 10, offset: 2, duration: 6, name: 'Chorus' }];
  b.arrangement = [{ id: 'g1', bufferId: 'bg', start: 0, offset: 0, duration: 16, name: 'Guitar' }];
  a.slots[0] = { bufferId: 'bv', name: 'Verse', loopLength: 8, loopStart: 0 }; b.slots[0] = { bufferId: 'bg', name: 'Riff', loopLength: 4, loopStart: 0 }; b.slots[1] = { bufferId: 'bg', name: 'Riff 2', loopLength: 2, loopStart: 0 };
  S.project.loop = { on: true, start: 0, end: 4 * engine.barDur }; engine.setLoop(S.project.loop);
  S.project.tracks.forEach((t) => engine.rescheduleTrack(t)); S.project.name = 'My First Song'; document.querySelector('#projName').textContent = S.project.name;
};
const addFx = (pg, type) => E(pg, (type) => { const dv = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Devices' && b.getClientRects().length); if (dv) dv.click(); document.querySelectorAll('.toast').forEach((x) => x.remove()); const s = [...document.querySelectorAll('#devHead select, .devbar select, select')].find((x) => x.getClientRects().length && [...x.options].some((o) => o.value === type)); if (!s) throw new Error('no select offers ' + type); s.value = type; s.dispatchEvent(new Event('change', { bubbles: true })); }, type);
const snapEl = async (pg, sel, name) => { try { await pg.locator(sel).first().screenshot({ path: path.join(OUT, name + '.png') }); done.push(name); } catch (e) { console.log('shot failed', name, e.message.split('\n')[0]); } };

// ---------------- desktop
const pg = await page({ width: 1440, height: 900 }, { guideDone: true, tutorialDone: true, phoneMode: 'off' }, false);
await snap(pg, 'start');
await pg.click('#startBtn'); await pg.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay')); await sleep(400);
await E(pg, DEMO);
await step('session', async () => {
  for (const sel of ['.add-col .add-track:nth-child(2)', '.add-col .add-track:nth-child(3)']) await pg.click(sel);
  await E(pg, () => { const L = __daw.S.project.tracks; L[2].name = 'Keys'; L[3].name = 'Beat'; }); await view(pg, 'arrange'); await view(pg, 'session'); await sleep(300);
  await snap(pg, 'session');
});
await step('transport', async () => snap(pg, 'transport', { clip: { x: 0, y: 0, width: 1440, height: 40 } }));
await step('arrange', async () => { await view(pg, 'arrange'); await sleep(400); await snap(pg, 'arrange'); });
await step('clip menu', async () => {
  const b = await E(pg, () => { const r = document.querySelector('.aclip[data-clip="v1"]').getBoundingClientRect(); return { x: r.left + 120, y: r.top + r.height / 2 }; });
  await pg.mouse.click(b.x, b.y, { button: 'right' }); await sleep(200); await snap(pg, 'clip-menu', { clip: { x: 150, y: 40, width: 800, height: 520 } }); await pg.keyboard.press('Escape'); await E(pg, () => document.querySelectorAll('.ctxmenu').forEach((m) => m.remove()));
});
await step('edit menu', async () => { await pg.click('.edit-btn'); await sleep(150); await snap(pg, 'edit-menu', { clip: { x: 150, y: 40, width: 800, height: 260 } }); await E(pg, () => document.querySelectorAll('.ctxmenu').forEach((m) => m.remove())); });
await step('cut tool', async () => {
  await pg.click('.cut-btn'); const b = await E(pg, () => { const r = document.querySelector('.aclip[data-clip="g1"]').getBoundingClientRect(); return { x: r.left + 300, y: r.top + r.height / 2 }; });
  await pg.mouse.move(b.x, b.y); await sleep(100); await snap(pg, 'cut-tool', { clip: { x: 150, y: 40, width: 1100, height: 330 } }); await pg.click('.cut-btn');
});
await step('tempo', async () => { await pg.click('#btnTempo'); await sleep(200); await snap(pg, 'tempo', { clip: { x: 150, y: 0, width: 900, height: 480 } }); await pg.keyboard.press('Escape'); await E(pg, () => document.querySelectorAll('.popover').forEach((m) => m.remove())); });
await step('pitch', async () => {
  await E(pg, () => { __daw.S.selected = __daw.S.project.tracks[0].id; }); await view(pg, 'session'); await sleep(100);
  await addFx(pg, 'pitch'); await sleep(200); await addFx(pg, 'reverb'); await sleep(300);
  await snapEl(pg, '#devices', 'pitch-correct');
});
await step('randomizer', async () => {
  await E(pg, () => { const L = document.querySelectorAll('.rand-more'); (L[1] || L[0]).click(); }); await sleep(200);
  await snap(pg, 'randomizer', { clip: { x: 150, y: 200, width: 1100, height: 700 } }); await E(pg, () => document.querySelectorAll('.popover').forEach((m) => m.remove()));
});
await step('rack', async () => {
  await E(pg, () => { __daw.S.selected = __daw.S.project.tracks[1].id; }); await view(pg, 'session'); await sleep(100);
  await addFx(pg, 'rack:Parallel Crush'); await sleep(300); await snapEl(pg, '#devices', 'rack');
});
await step('instrument + midi fx', async () => {
  await E(pg, () => { __daw.S.selected = __daw.S.project.tracks[2].id; }); await view(pg, 'session'); await sleep(100);
  await addFx(pg, 'arp'); await sleep(200); await addFx(pg, 'chord'); await sleep(300);
  await snapEl(pg, '#devices', 'instrument-midifx');
});
await step('piano roll', async () => {
  await E(pg, () => { const { S } = __daw; const t = S.project.tracks[2]; t.slots[0] = { type: 'midi', name: 'Chords', lengthBeats: 16, notes: [0, 4, 8, 12].flatMap((b, i) => [[60, 64, 67], [57, 60, 64], [53, 57, 60], [55, 59, 62]][i].map((n) => ({ t: b, d: 3.5, n, v: 96 }))) }; });
  await view(pg, 'arrange'); await view(pg, 'session'); await sleep(200);
  await E(pg, () => { const el = [...document.querySelectorAll('.slot')].find((s) => /Chords/.test(s.textContent)); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); el.click(); }); await sleep(500);
  await snap(pg, 'piano-roll'); await pg.click('.pr-close'); await sleep(200);
});
await step('automix', async () => { await E(pg, () => document.querySelector('#dlg') && document.querySelector('#dlg').open && document.querySelector('#dlg').close()); await pg.click('#btnAutoMix'); await sleep(900); await snap(pg, 'automix'); await E(pg, () => document.querySelector('#dlg').close()); });
await step('help mode', async () => { await pg.click('#btnHelp'); await sleep(100); await pg.click('#btnTap'); await sleep(250); await snap(pg, 'help-mode', { clip: { x: 0, y: 0, width: 1100, height: 300 } }); await pg.click('#btnHelp'); });
await step('easy', async () => { await pg.click('#btnEasy'); await sleep(300); await snap(pg, 'easy-mode'); await pg.click('#btnEasy'); });
await step('menu', async () => { await pg.click('#btnMenu'); await sleep(200); await snap(pg, 'menu', { clip: { x: 1040, y: 0, width: 400, height: 640 } }); await pg.click('#btnMenu'); });
await step('seq', async () => {
  await view(pg, 'session'); await E(pg, () => { __daw.S.selected = __daw.S.project.tracks[3].id; __daw.seq.setOpen(true); __daw.seq.render(); }); await sleep(200);
  await E(pg, () => document.querySelector('#seqPanel [data-act=enable]').click()); await sleep(200);
  for (const [si, n] of [[0, 36], [4, 38], [8, 36], [10, 36], [12, 38], [2, 42], [6, 42], [10, 42], [14, 42], [15, 46]]) await pg.click(`#seqPanel .sq-dcell[data-si="${si}"][data-n="${n}"]`);
  await E(pg, () => __daw.engine.play(0)); await sleep(900); await snap(pg, 'seq-drums'); await E(pg, () => { __daw.engine.stop(); __daw.engine.stop(); });
});
await step('seq synth', async () => {
  await E(pg, () => { __daw.S.selected = __daw.S.project.tracks[2].id; __daw.seq.render(); }); await sleep(200);
  await E(pg, () => { const b = document.querySelector('#seqPanel [data-act=enable]'); if (b) b.click(); }); await sleep(200);
  await E(pg, () => { const t = __daw.S.project.tracks[2]; const p = t.seq.patterns[t.seq.active]; [[0, 60], [3, 63], [6, 67], [8, 60], [11, 70], [14, 67]].forEach(([i, n]) => { p.steps[i].on = true; p.steps[i].notes = [n]; }); p.steps[6].rat = 3; p.steps[11].pl = { 'inst|cutoff': 900 }; __daw.seq.render(); });
  await sleep(150); await pg.click('#seqPanel .sq-step[data-si="6"] .sq-num'); await sleep(200);
  await snap(pg, 'seq-synth');
  await E(pg, () => { const b = [...document.querySelectorAll('#seqPanel button')].find((x) => x.textContent.trim() === 'P-Lock'); if (b) b.click(); }); await sleep(250);
  await snap(pg, 'seq-plock');
  await E(pg, () => { const b = [...document.querySelectorAll('#seqPanel button')].find((x) => x.textContent.trim() === 'P-Lock'); if (b) b.click(); });
});
await step('keys', async () => {
  await E(pg, () => { document.activeElement && document.activeElement.blur(); __daw.compKeys.setOn(true); }); await sleep(200);
  await pg.keyboard.down('d'); await pg.keyboard.down('g'); await sleep(150); await snap(pg, 'keys'); await pg.keyboard.up('d'); await pg.keyboard.up('g');
  await E(pg, () => __daw.compKeys.setOn(false));
});
await step('micro edit', async () => {
  await view(pg, 'arrange'); await sleep(300);
  await E(pg, () => { const c = __daw.S.project.tracks[1].arrangement.find((x) => x.id === 'g1'); c.fadeIn = 0.35; c.fadeOut = 1.2; });
  await view(pg, 'session'); await view(pg, 'arrange'); await sleep(300);
  const b = await E(pg, () => { const r = document.querySelector('.aclip[data-clip="g1"]').getBoundingClientRect(); return { x: r.left + 200, y: r.top + r.height / 2 }; });
  await pg.mouse.click(b.x, b.y); await sleep(200); await E(pg, () => __daw.engine.stopAudition());
  for (let i = 0; i < 16; i++) await E(pg, () => document.querySelector('#devHead button[title^="Zoom in"]')?.click());
  await sleep(250); await snap(pg, 'micro-edit');
});
await pg.context().close();

// ---------------- phone
const ph = await page({ width: 390, height: 844 }, { guideDone: true, tutorialDone: true, phoneMode: 'on', haptics: true });
await E(ph, DEMO);
for (const tab of ['record', 'tracks', 'mix', 'effects', 'more']) await step('phone ' + tab, async () => { await E(ph, (t) => document.querySelector(`.ph-tab[data-tab=${t}]`).click(), tab); await sleep(400); await snap(ph, 'phone-' + tab); });
await step('phone clip sheet', async () => { await E(ph, () => { __daw.engine.setPosition(3); document.querySelector('.ph-tab[data-tab=tracks]').click(); }); await sleep(200); await E(ph, () => document.querySelector('.ph-clip').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await sleep(300); await snap(ph, 'phone-split'); });
await step('phone steps', async () => {
  await E(ph, () => { const { S } = __daw; __daw.phone.openSeq(false); document.querySelector('.ph-tab[data-tab=tracks]').click(); });
  await E(ph, () => { const t = __daw.S.project.tracks.find((x) => x.kind === 'midi'); if (t) __daw.S.selected = t.id; }); await sleep(100);
  await E(ph, () => document.querySelector('#phone .ph-steps').click()); await sleep(300);
  await E(ph, () => { const b = [...document.querySelectorAll('#phone .ph-side button')].find((x) => /instrument track|Add step sequencer/i.test(x.textContent)); if (b) b.click(); }); await sleep(300);
  await E(ph, () => { const b = [...document.querySelectorAll('#phone .ph-side button')].find((x) => /Add step sequencer/i.test(x.textContent)); if (b) b.click(); }); await sleep(300);
  for (const i of [0, 3, 6, 8, 12]) await E(ph, (i) => document.querySelector(`#phone .ph-side .sq-step[data-si="${i}"]`)?.click(), i);
  await sleep(200); await snap(ph, 'phone-steps'); await E(ph, () => __daw.phone.openSeq(false)); await sleep(200);
});
await ph.context().close();
await browser.close(); server.kill();
console.log('shots:', done.join(', '));
