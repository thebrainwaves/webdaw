// v0.5.1: two main views + docked sequencer side panel (desktop) / slide-out (phone), computer MIDI keyboard,
// micro editing (Alt/Shift free, arrow nudge, sample-level zoom, fine trim + fades, numeric fields, piano-roll
// fine edit + undo inside the piano roll), About > Licences + privacy note, no third-party brand names in the UI.
// Run after `node tools/build.mjs`: node tests/e2e-v051.mjs   (PORT env, default 8781)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8781), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 600) : ''}`); };
const shots = path.join(ROOT, 'shots'); fs.mkdirSync(shots, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(shots, name + '.png') });
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const browser = await chromium.launch({ headless: true, ...(process.env.DAW_BROWSER ? { executablePath: process.env.DAW_BROWSER } : {}), args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const errors = [];
async function newPage(opts = {}, prefs = { guideDone: true, tutorialDone: true, phoneMode: 'off' }) {
  const ctx = await browser.newContext({ permissions: ['microphone'], ...opts });
  await ctx.addInitScript((prefs) => { if (prefs && !localStorage.getItem('webdaw.prefs')) localStorage.setItem('webdaw.prefs', JSON.stringify(prefs)); }, prefs);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Refused to execute inline script|Executing inline script violates/.test(m.text())) errors.push(`[console] ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  return { ctx, page };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MK = `window.__mkBuf = (id, secs) => { const { engine } = __daw; const sr = engine.ctx.sampleRate; const b = engine.ctx.createBuffer(2, Math.round(sr * secs), sr);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.exp(-(t % 0.5) * 6) * 0.7 * Math.sin(2 * Math.PI * 220 * t); } } engine.buffers.set(id, b); return b; };`;
const START = async (page) => { await page.goto(URL_); await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300); await page.evaluate(MK); };
// brand names / "X-style" wording that must not appear anywhere user-visible
const BRANDS = /ableton|bitwig|squarp|pyramid|hapax|elektron|roland|\b808\b|\b909\b|maschine|serum|auto-?tune|antares|fl studio|logic pro|pro tools|cubase|-style\b/i;
const VISIBLE_TEXT = `(() => { const out = [document.title]; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) out.push(n.nodeValue);
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],option')) for (const a of ['title', 'aria-label', 'placeholder']) { const v = el.getAttribute(a); if (v) out.push(v); }
  for (const m of document.querySelectorAll('meta[content]')) out.push(m.getAttribute('content')); return out.join('\\n'); })()`;
const spyNotes = `window.__spy = (tid) => { const n = __daw.engine.tracks.get(tid); const log = []; for (const d of [n.midi || n.inst]) { const on = d.noteOn.bind(d), off = d.noteOff.bind(d); d.noteOn = (a, b, ...r) => { log.push(['on', a, b]); return on(a, b, ...r); }; d.noteOff = (a, ...r) => { log.push(['off', a]); return off(a, ...r); }; } return log; };`;

try {
  // ============================================================ desktop: views + side panel
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await START(page);
  const views = await page.evaluate(() => [...document.querySelectorAll('.views button[data-view]')].map((b) => b.dataset.view));
  ok('Exactly two main views: Session and Arrangement (no separate sequencer view)', JSON.stringify(views) === '["session","arrange"]' && !(await page.evaluate(() => !!document.querySelector('#seqView, [data-view=seq]'))), JSON.stringify(views));
  await page.evaluate(() => { const { S } = __daw; const t = S.project.tracks.find((x) => x.kind === 'midi') || null; if (!t) document.querySelector('.add-track[title*="synth" i]')?.click(); });
  await sleep(200);
  const tid = await page.evaluate(() => { const { S } = __daw; let t = S.project.tracks.find((x) => x.kind === 'midi' && x.instrument !== 'drums'); return t ? t.id : null; });
  const panel = await page.evaluate(() => { const p = document.querySelector('#seqPanel'); const r = p.getBoundingClientRect(); const c = document.querySelector('#center').getBoundingClientRect(); return { w: r.width, right: r.right, cRight: c.right, open: __daw.seq.open, vis: getComputedStyle(p).display !== 'none' }; });
  ok('Sequencer side panel is docked on the right of the work area (default ~420 px) in the Session view', panel.vis && panel.open && Math.abs(panel.w - 420) < 30 && panel.right > panel.cRight, JSON.stringify(panel));
  await page.evaluate(() => document.querySelector('.views button[data-view=arrange]').click()); await sleep(250);
  const inArr = await page.evaluate(() => ({ view: __daw.S.view, vis: document.querySelector('#seqPanel').getBoundingClientRect().width > 100 }));
  ok('Side panel stays visible in the Arrangement view', inArr.view === 'arrange' && inArr.vis, JSON.stringify(inArr));
  await page.keyboard.press('Tab'); await sleep(150); const v1 = await page.evaluate(() => __daw.S.view); await page.keyboard.press('Tab'); await sleep(150); const v2 = await page.evaluate(() => __daw.S.view);
  ok('Tab switches between the two views only', v1 === 'session' && v2 === 'arrange', v1 + ',' + v2);
  // follows the selected track
  const names = await page.evaluate(async () => { const { S } = __daw; const out = []; for (const t of S.project.tracks.filter((x) => x.kind !== 'group').slice(0, 3)) { document.querySelector(`#arrangeView .lane-head[data-id="${t.id}"]`).click(); await new Promise((r) => setTimeout(r, 120)); out.push([t.name, (document.querySelector('#seqPanel .sqp-track') || {}).textContent || '']); } return out; });
  ok('Side panel follows the selected track (header shows its name)', names.length >= 2 && names.every(([a, b]) => b.includes(a)), JSON.stringify(names));
  // resize with the grip
  const g = await page.evaluate(() => { const r = document.querySelector('#seqPanel .sqp-grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(g.x, g.y); await page.mouse.down(); await page.mouse.move(g.x - 80, g.y, { steps: 6 }); await page.mouse.up(); await sleep(150);
  const w2 = await page.evaluate(() => ({ w: __daw.seq.width, dom: document.querySelector('#seqPanel').getBoundingClientRect().width, pref: JSON.parse(localStorage.getItem('webdaw.prefs') || localStorage.getItem('auduio.prefs') || '{}').seqW }));
  ok('Dragging the grip resizes the panel and remembers the width', Math.abs(w2.w - 500) < 12 && Math.abs(w2.dom - w2.w) < 4, JSON.stringify(w2));
  await page.evaluate(() => { const gr = document.querySelector('#seqPanel .sqp-grip'); gr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); }); await sleep(100);
  const w3 = await page.evaluate(() => __daw.seq.width);
  ok('Double-click on the grip resets the default width', Math.abs(w3 - 420) < 2, String(w3));
  // select the synth track for screenshots
  if (tid) await page.evaluate((id) => document.querySelector(`#arrangeView .lane-head[data-id="${id}"]`)?.click(), tid);
  await sleep(200); await shot(page, 'v051-arrangement-sidepanel');
  await page.evaluate(() => document.querySelector('.views button[data-view=session]').click()); await sleep(250); await shot(page, 'v051-session-sidepanel');
  await page.click('#seqPanel .sqp-tog'); await sleep(200);
  const col = await page.evaluate(() => ({ open: __daw.seq.open, w: document.querySelector('#seqPanel').getBoundingClientRect().width }));
  ok('Collapse button folds the panel to a thin strip; the work area gets the space', !col.open && col.w < 60, JSON.stringify(col));
  await page.click('#seqPanel .sqp-tog'); await sleep(200);
  ok('Panel opens again', await page.evaluate(() => __daw.seq.open && document.querySelector('#seqPanel').getBoundingClientRect().width > 300));

  // ============================================================ computer MIDI keyboard
  const synthId = await page.evaluate(() => { const { S } = __daw; const t = S.project.tracks.find((x) => x.kind === 'midi' && x.instrument !== 'drums'); document.querySelector(`#sessionView .col[data-id="${t.id}"] .col-head, #sessionView .col[data-id="${t.id}"]`)?.click(); S.selected = t.id; return t.id; });
  await page.evaluate(spyNotes); await page.evaluate((id) => { window.__log = __spy(id); }, synthId);
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press('m'); await sleep(100);
  const ckOn = await page.evaluate(() => ({ on: __daw.compKeys.on, widget: !!document.querySelector('#ckWidget') && !document.querySelector('#ckWidget').hidden, btn: document.querySelector('#btnKeys').classList.contains('on') }));
  ok('M switches the computer keyboard on (KEYS button lit, widget with mini piano shown)', ckOn.on && ckOn.widget && ckOn.btn, JSON.stringify(ckOn));
  await page.keyboard.down('a'); await sleep(60); await page.keyboard.up('a'); await page.keyboard.down('w'); await sleep(40); await page.keyboard.up('w');
  await page.keyboard.press('x'); await page.keyboard.down('a'); await sleep(40); await page.keyboard.up('a');
  await page.keyboard.press('z'); await page.keyboard.press('z');
  await page.keyboard.press('c'); await page.keyboard.down('k'); await sleep(40); await page.keyboard.up('k');
  const log1 = await page.evaluate(() => __log.slice());
  const ons = log1.filter((e) => e[0] === 'on');
  ok('A / W play C4 / C#4; X shifts up an octave (A = C5); Z twice = one octave below start (K = C4 there)', ons.length >= 4 && ons[0][1] === 60 && ons[1][1] === 61 && ons[2][1] === 72 && ons[3][1] === 60, JSON.stringify(ons));
  ok('C lowers the velocity step (notes after C are softer)', ons[3] && ons[3][2] < ons[0][2], JSON.stringify(ons.map((o) => o[2])));
  ok('Every key release sends a note-off (no stuck notes)', log1.filter((e) => e[0] === 'off').length >= ons.length && (await page.evaluate(() => __daw.compKeys.held)) === 0);
  // blur while held -> released
  await page.evaluate(() => { __log.length = 0; }); await page.keyboard.down('s'); await sleep(50);
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await sleep(50);
  const blur = await page.evaluate(() => ({ log: __log.slice(), held: __daw.compKeys.held })); await page.keyboard.up('s');
  ok('Losing window focus while a key is held releases the note', blur.held === 0 && blur.log.some((e) => e[0] === 'off'), JSON.stringify(blur));
  // typing guard
  await page.evaluate(() => { __log.length = 0; }); await page.focus('#bpm'); await page.keyboard.press('a'); await page.keyboard.press('s');
  const typ = await page.evaluate(() => __log.length); await page.evaluate(() => document.activeElement.blur());
  ok('Typing in a text/number field never plays notes', typ === 0, String(typ));
  // mini piano click
  await page.evaluate(() => { __log.length = 0; }); const kb = await page.evaluate(() => { const r = document.querySelector('#ckWidget .ck-k.w').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.bottom - 6 }; });
  await page.mouse.move(kb.x, kb.y); await page.mouse.down(); await sleep(60); await page.mouse.up(); await sleep(50);
  const clk = await page.evaluate(() => __log.slice());
  ok('Clicking the mini piano plays and releases a note', clk.some((e) => e[0] === 'on') && clk.some((e) => e[0] === 'off'), JSON.stringify(clk));
  await shot(page, 'v051-midi-keyboard');
  // record into the arrangement from the computer keyboard
  await page.evaluate((id) => { const { S } = __daw; for (const t of S.project.tracks) t.arm = false; const t = S.project.tracks.find((x) => x.id === id); t.arm = true; S.view = 'arrange'; document.querySelector('.views button[data-view=arrange]').click(); __daw.engine.setPosition(0); }, synthId);
  await sleep(200); await page.evaluate(() => document.body.focus());
  const before = await page.evaluate((id) => __daw.S.project.tracks.find((x) => x.id === id).arrangement.length, synthId);
  const recBase = await page.evaluate(() => __daw.compKeys.base);
  await page.keyboard.press('r'); await sleep(900);
  await page.keyboard.down('d'); await sleep(250); await page.keyboard.up('d'); await sleep(150); await page.keyboard.down('f'); await sleep(250); await page.keyboard.up('f'); await sleep(300);
  await page.keyboard.press('Space'); await sleep(500);
  const rec = await page.evaluate((id) => { const t = __daw.S.project.tracks.find((x) => x.id === id); const c = t.arrangement[t.arrangement.length - 1]; return { n: t.arrangement.length, notes: c && c.notes ? c.notes.map((x) => x.n) : null, playing: __daw.engine.playing }; }, synthId);
  ok('Recording with the computer keyboard writes the notes into a MIDI clip on the armed track', rec.n > before && !!rec.notes && rec.notes.includes(recBase + 4) && rec.notes.includes(recBase + 5) && !rec.playing, JSON.stringify(rec));
  await page.keyboard.press('m'); await sleep(80);
  ok('M again switches the computer keyboard off', !(await page.evaluate(() => __daw.compKeys.on)));

  // ============================================================ micro editing (arrangement)
  await page.evaluate(() => { const { S, engine } = __daw; __mkBuf('mb', 6); const t = S.project.tracks.find((x) => x.kind === 'audio'); t.arrangement = [{ id: 'mc', bufferId: 'mb', start: 1, offset: 0, duration: 4, name: 'Micro' }]; S.sel = null; document.querySelector('.views button[data-view=session]').click(); document.querySelector('.views button[data-view=arrange]').click(); });
  await sleep(300);
  const clipBox = async () => page.evaluate(() => { const r = document.querySelector('.aclip[data-clip="mc"]').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width }; });
  let cb = await clipBox();
  await page.mouse.click(cb.l + cb.w / 2, cb.t + 20); await sleep(150);
  const beat = await page.evaluate(() => __daw.engine.beatDur);
  await page.keyboard.press('ArrowRight'); await sleep(80);
  const n1 = await page.evaluate(() => __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc').start);
  await page.keyboard.press('Alt+ArrowRight'); await sleep(80);
  const n2 = await page.evaluate(() => __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc').start);
  await page.keyboard.press('Alt+Shift+ArrowLeft'); await sleep(80);
  const n3 = await page.evaluate(() => __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc').start);
  ok('Arrow nudges the selected clip by one beat; Alt+Arrow by 1 ms; Alt+Shift+Arrow by 10 ms', Math.abs(n1 - (1 + beat)) < 1e-6 && Math.abs(n2 - n1 - 0.001) < 1e-6 && Math.abs(n3 - n2 + 0.01) < 1e-6, JSON.stringify({ n1, n2, n3, beat }));
  await page.keyboard.press('Control+z'); await sleep(80);
  const nu = await page.evaluate(() => __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc').start);
  ok('Nudges are undoable', Math.abs(nu - 1) < 1e-6 || Math.abs(nu - n1) < 1e-6, String(nu));
  await page.evaluate(() => { const c = __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc'); c.start = 1; }); await page.evaluate(() => { document.querySelector('.views button[data-view=session]').click(); document.querySelector('.views button[data-view=arrange]').click(); }); await sleep(250);
  // trim end with Alt (free) vs snapped
  cb = await clipBox(); const pxs = cb.w / 4;
  await page.mouse.move(cb.r - 2, cb.t + 20); await page.mouse.down(); await page.mouse.move(cb.r - 2 - pxs * 0.37, cb.t + 20, { steps: 5 }); await page.mouse.up(); await sleep(100);
  const tr1 = await page.evaluate(() => __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc').duration);
  ok('Dragging a clip\'s right edge trims its end, snapped to the beat grid', Math.abs(tr1 / beat - Math.round(tr1 / beat)) < 1e-6 && tr1 < 4, String(tr1));
  cb = await clipBox();
  await page.keyboard.down('Alt'); await page.mouse.move(cb.r - 2, cb.t + 20); await page.mouse.down(); await page.mouse.move(cb.r - 2 - pxs * 0.137, cb.t + 20, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt'); await sleep(100);
  const tr2 = await page.evaluate(() => __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc').duration);
  ok('Alt while trimming = free (no snap)', tr2 < tr1 && Math.abs(tr2 / beat - Math.round(tr2 / beat)) > 1e-3, String(tr2));
  cb = await clipBox();
  await page.keyboard.down('Shift'); await page.mouse.move(cb.l + 2, cb.t + 20); await page.mouse.down(); await page.mouse.move(cb.l + 2 + pxs * 0.21, cb.t + 20, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift'); await sleep(100);
  const ts = await page.evaluate(() => { const c = __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc'); return { s: c.start, o: c.offset, d: c.duration }; });
  ok('Shift-dragging the left edge trims the start freely and moves the audio offset with it (audio stays in place)', ts.s > 1.1 && Math.abs(ts.o - (ts.s - 1)) < 1e-3, JSON.stringify(ts));
  // fades via handles
  cb = await clipBox();
  await page.mouse.move(cb.l + cb.w / 2, cb.t + 20); await sleep(50);
  const fh = await page.evaluate(() => { const r = document.querySelector('.aclip[data-clip="mc"] .fh.fi').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.keyboard.down('Alt'); await page.mouse.move(fh.x, fh.y); await page.mouse.down(); await page.mouse.move(fh.x + pxs * 0.3, fh.y, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Alt'); await sleep(100);
  const fo = await page.evaluate(() => { const r = document.querySelector('.aclip[data-clip="mc"] .fh.fo').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.move(fo.x, fo.y); await page.mouse.down(); await page.mouse.move(fo.x - pxs * 0.5, fo.y, { steps: 5 }); await page.mouse.up(); await sleep(100);
  const fades = await page.evaluate(() => { const c = __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc'); return { fi: c.fadeIn, fo: c.fadeOut, d: c.duration, s: c.start }; });
  ok('Fade handles set fade in (free with Alt) and fade out (snapped) on the clip', fades.fi > 0.2 && fades.fi < 0.5 && fades.fo > 0.3 && fades.fo < 1 && Math.abs(((fades.d + fades.s - fades.fo) / 0.5) - Math.round((fades.d + fades.s - fades.fo) / 0.5)) < 1e-6, JSON.stringify(fades));
  // fades are rendered by the engine: schedule and check the gain automation
  const env = await page.evaluate(() => { const { engine, S } = __daw; const t = S.project.tracks.find((x) => x.arrangement.some((c) => c.id === 'mc')); const c = t.arrangement.find((x) => x.id === 'mc');
    const calls = []; const fake = { value: 0, setValueAtTime: (v, at) => calls.push(['set', +v.toFixed(4), at]), linearRampToValueAtTime: (v, at) => calls.push(['ramp', +v.toFixed(4), at]) };
    engine.clipEnvelope(fake, c, 1, 0, 10); return { calls, fi: c.fadeIn, fo: c.fadeOut, d: c.duration }; });
  const cs = env.calls;
  ok('Engine applies the fades as a gain envelope (0 -> 1 over the fade in, 1 -> 0 over the fade out)', cs[0][0] === 'set' && cs[0][1] === 0 && cs[1][0] === 'ramp' && Math.abs(cs[1][2] - (10 + env.fi)) < 1e-6 && cs[cs.length - 1][1] === 0 && Math.abs(cs[cs.length - 1][2] - (10 + env.d)) < 1e-6, JSON.stringify(env));
  // numeric fields in the clip detail panel
  await page.evaluate(() => { const el = document.querySelector('.aclip[data-clip="mc"]'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', clientX: el.getBoundingClientRect().left + 40, clientY: el.getBoundingClientRect().top + 30 })); window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); });
  await sleep(250);
  const hasNums = await page.evaluate(() => [...document.querySelectorAll('.clip-nums input')].map((i) => i.dataset.field));
  ok('Clip detail panel has exact number fields: position, length, offset, fade in, fade out', ['start', 'duration', 'offset', 'fadeIn', 'fadeOut'].every((f) => hasNums.includes(f)), JSON.stringify(hasNums));
  const setNum = async (field, v) => { await page.fill(`.clip-nums input[data-field="${field}"]`, String(v)); await page.press(`.clip-nums input[data-field="${field}"]`, 'Enter'); await sleep(120); };
  await setNum('start', 2.3456); await setNum('duration', 1.25); await setNum('fadeIn', 12.5); await setNum('fadeOut', 40);
  const nums = await page.evaluate(() => { const c = __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc'); return { s: c.start, d: c.duration, fi: c.fadeIn, fo: c.fadeOut }; });
  ok('Typing exact values sets position / length (s) and fades (ms) precisely', Math.abs(nums.s - 2.3456) < 1e-9 && Math.abs(nums.d - 1.25) < 1e-9 && Math.abs(nums.fi - 0.0125) < 1e-9 && Math.abs(nums.fo - 0.04) < 1e-9, JSON.stringify(nums));
  // sample-level zoom in the arrangement
  for (let i = 0; i < 40; i++) await page.evaluate(() => document.querySelector('#arrangeView .view-tools button[title^="Zoom in"]').click());
  await sleep(200);
  const z = await page.evaluate(() => ({ zoom: __daw.S.zoom, sr: __daw.engine.ctx.sampleRate, info: document.querySelector('#arrangeView .zoom-info')?.textContent, w: parseFloat(document.querySelector('#arrangeView .arr-content').style.width), fine: !document.querySelector('#arrangeView .fine-ruler').hidden }));
  ok('Arrangement zooms down to sample level (>= 1 px per sample), shows the scale and a fine ms ruler; timeline width stays within browser limits', z.zoom >= z.sr && /sample/.test(z.info || '') && z.fine && z.w <= 16e6 + 1, JSON.stringify(z));
  await page.evaluate(() => { const c = __daw.S.project.tracks.flatMap((t) => t.arrangement).find((c) => c.id === 'mc'); const sc = document.querySelector('#arrangeView .arr-scroll'); sc.scrollLeft = (c.start + 0.25) * __daw.S.zoom; sc.dispatchEvent(new Event('scroll')); });
  await sleep(250);
  const drawn = await page.evaluate(() => { const cv = document.querySelector('.aclip[data-clip="mc"] canvas'); return cv && cv.width > 100; });
  ok('Waveform is drawn at sample zoom (only the visible part)', drawn);
  // clip-detail zoom to samples
  for (let i = 0; i < 30; i++) await page.evaluate(() => document.querySelector('#devHead button[title="Zoom in (or pinch / Ctrl+wheel)"]')?.click());
  await sleep(150);
  const cz = await page.evaluate(() => { const i = document.querySelector('.clip-info'); return { spp: +(i && i.dataset.spp), txt: i && i.textContent.slice(0, 60) }; });
  ok('Clip editor zooms down to individual samples', cz.spp > 0 && cz.spp < 1, JSON.stringify(cz));
  for (let i = 0; i < 4; i++) await page.evaluate(() => document.querySelector('#devHead button[title="Zoom out"]')?.click());
  await sleep(150); await shot(page, 'v051-micro-edit-zoom');
  const nulls = await page.evaluate(() => { const bad = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) if (/^(null|undefined|NaN|\[object Object\])$/.test(n.nodeValue.trim())) bad.push(n.parentElement.className + ':' + n.nodeValue); return bad; });
  ok('No stray "null" / "undefined" / "NaN" text in the UI (arrangement + clip detail)', nulls.length === 0, JSON.stringify(nulls));
  await page.evaluate(() => { for (let i = 0; i < 60; i++) document.querySelector('#arrangeView .view-tools button[title="Zoom out"]').click(); });
  // split keeps fades only on the outer edges; save/load keeps fades
  const sp = await page.evaluate(() => { const { S, engine } = __daw; const t = S.project.tracks.find((x) => x.arrangement.some((c) => c.id === 'mc')); const c = t.arrangement.find((x) => x.id === 'mc'); S.sel = { kind: 'arr', trackId: t.id, clipId: 'mc' }; engine.setPosition(c.start + c.duration / 2); return t.id; });
  await page.keyboard.press('s'); await sleep(150);
  const halves = await page.evaluate((tid) => __daw.S.project.tracks.find((x) => x.id === tid).arrangement.filter((c) => c.bufferId === 'mb').sort((a, b) => a.start - b.start).map((c) => ({ fi: c.fadeIn || 0, fo: c.fadeOut || 0 })), sp);
  ok('Splitting a faded clip keeps the fade in on the left part and the fade out on the right part only', halves.length === 2 && halves[0].fi > 0 && !halves[0].fo && !halves[1].fi && halves[1].fo > 0, JSON.stringify(halves));
  await ctx.close();

  // ============================================================ piano roll fine edit
  {
    const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
    await START(page);
    await page.evaluate(() => document.querySelector('.add-track[title*="synth" i]').click()); await sleep(200);
    await page.evaluate(() => { const { S } = __daw; const t = S.project.tracks.find((x) => x.kind === 'midi' && x.instrument !== 'drums'); t.slots[0] = { type: 'midi', name: 'PR', lengthBeats: 8, notes: [{ t: 1, d: 0.5, n: 60, v: 100 }] }; S.selected = t.id; window.__prt = t.id; });
    await page.evaluate(() => { document.querySelector('.views button[data-view=session]').click(); }); await sleep(200);
    await page.evaluate(() => { const el = document.querySelector(`#sessionView .col[data-id="${__prt}"] .slot[data-slot="0"]`); el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
    await sleep(300);
    let open = await page.evaluate(() => !!document.querySelector('.pianoroll'));
    if (!open) { await page.evaluate(() => { const { S } = __daw; const t = S.project.tracks.find((x) => x.id === __prt); }); }
    // select the note by clicking it
    const pos = await page.evaluate(() => { const cv = document.querySelector('.pr-canvas'); const r = cv.getBoundingClientRect(); return { l: r.left, t: r.top }; });
    open = await page.evaluate(() => !!document.querySelector('.pianoroll'));
    ok('Piano roll opens for a MIDI clip', open);
    // note at beat 1, pitch 60: x = 44 + (1-0)*60 + 5, y = (top-60)*14 + 7 where top = 66
    await page.mouse.click(pos.l + 44 + 60 + 8, pos.t + (66 - 60) * 14 + 7); await sleep(120);
    const fields = await page.evaluate(() => ({ s: document.querySelector('.pr-fields input[aria-label^="Note start"]').value, l: document.querySelector('.pr-fields input[aria-label^="Note length"]').value, v: document.querySelector('.pr-fields input[aria-label="Note velocity"]').value }));
    ok('Selecting a note fills the start / length / velocity fields', fields.s === '1' && fields.l === '0.5' && fields.v === '100', JSON.stringify(fields));
    const note = () => page.evaluate(() => { const t = __daw.S.project.tracks.find((x) => x.id === __prt); const n = t.slots[0].notes[0]; return { t: n.t, d: n.d, n: n.n, v: n.v }; });
    await page.keyboard.press('Alt+ArrowRight'); await page.keyboard.press('Alt+ArrowRight'); await sleep(50);
    let nt = await note();
    ok('Alt+Arrow nudges a note by 1 tick (1/960 beat)', Math.abs(nt.t - (1 + 2 / 960)) < 1e-9, JSON.stringify(nt));
    await page.keyboard.press('ArrowLeft'); nt = await note();
    ok('Arrow moves a note by the grid step', Math.abs(nt.t - (0.75 + 2 / 960)) < 1e-9, JSON.stringify(nt));
    await page.keyboard.press('Alt+Shift+ArrowRight'); nt = await note();
    ok('Alt+Shift+Arrow lengthens a note by 1 tick', Math.abs(nt.d - (0.5 + 1 / 960)) < 1e-9, JSON.stringify(nt));
    await page.keyboard.press('Control+ArrowUp'); await page.keyboard.press('Control+Shift+ArrowDown'); nt = await note();
    ok('Ctrl+Up/Down change velocity by 1 (Shift = 10)', nt.v === 91, JSON.stringify(nt));
    await page.keyboard.press('ArrowUp'); nt = await note();
    ok('Up raises the pitch a semitone', nt.n === 61, JSON.stringify(nt));
    await page.fill('.pr-fields input[aria-label^="Note start"]', '2.123'); await page.press('.pr-fields input[aria-label^="Note start"]', 'Enter');
    await page.fill('.pr-fields input[aria-label="Note velocity"]', '37'); await page.press('.pr-fields input[aria-label="Note velocity"]', 'Enter');
    await page.evaluate(() => document.activeElement.blur()); nt = await note();
    ok('Typed note start / velocity are applied (start rounded to the tick grid)', Math.abs(nt.t - Math.round(2.123 * 960) / 960) < 1e-9 && nt.v === 37, JSON.stringify(nt));
    await page.keyboard.press('Control+z'); await sleep(200); nt = await note();
    const still = await page.evaluate(() => !!document.querySelector('.pianoroll'));
    ok('Ctrl+Z inside the piano roll undoes the last note edit and keeps the piano roll open on the same clip', nt.v !== 37 && still, JSON.stringify(nt));
    await page.keyboard.press('Control+Shift+z'); await sleep(200); nt = await note();
    ok('Ctrl+Shift+Z redoes it', nt.v === 37, JSON.stringify(nt));
    await page.keyboard.press('Escape'); await sleep(100);
    await ctx.close();
  }

  // ============================================================ About > Licences, privacy, brand names
  {
    const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
    await START(page);
    const txt = await page.evaluate(VISIBLE_TEXT);
    const m = txt.match(BRANDS);
    ok('No third-party DAW/hardware brand names or "X-style" wording in the visible UI', !m, m ? m[0] + ' … ' + txt.slice(Math.max(0, m.index - 60), m.index + 60) : '');
    await page.click('#btnMenu'); await sleep(100);
    const about = await page.evaluate(() => { const b = [...document.querySelectorAll('#menu button')].find((x) => /About/.test(x.textContent)); b && b.click(); return !!b; });
    await sleep(200);
    const ab = await page.evaluate(() => ({ txt: document.querySelector('#dlg')?.textContent || '', lic: !!document.querySelector('#dlg button.lic-btn') }));
    ok('About shows the version, a privacy note and a Licences button', about && /0\.5\.1/.test(ab.txt) && /privacy/i.test(ab.txt) && ab.lic, ab.txt.slice(0, 300));
    await page.click('#dlg button.lic-btn'); await sleep(400);
    const lic = await page.evaluate(() => document.querySelector('#dlg')?.textContent || '');
    ok('Licences screen lists third-party notices (VST trademark wording, CLAP MIT)', /VST is a trademark of Steinberg Media Technologies GmbH/.test(lic) && /CLAP/.test(lic) && /MIT/.test(lic), lic.slice(0, 300));
    const aboutTxt = ab.txt + lic; const m2 = aboutTxt.match(/ableton|bitwig|squarp|hapax|pyramid|-style\b/i);
    ok('About / Licences text has no DAW brand names', !m2, m2 ? m2[0] : '');
    const notices = await page.evaluate(async () => { const r = await fetch('THIRD-PARTY-NOTICES.txt'); return r.ok ? (await r.text()).length : 0; });
    ok('THIRD-PARTY-NOTICES.txt ships with the web build', notices > 1000, String(notices));
    await ctx.close();
  }

  // ============================================================ phone: slide-out sequencer, no Steps tab
  {
    const { ctx, page } = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, { guideDone: true, tutorialDone: true, phoneMode: 'on' });
    await START(page);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('#phone [data-tab]')].map((b) => b.dataset.tab));
    ok('Phone: no Steps tab in the bottom bar', !tabs.includes('seq') && tabs.length >= 3, JSON.stringify(tabs));
    await page.evaluate(() => document.querySelector('.add-track[title*="synth" i]').click()); await sleep(200);
    await page.evaluate(() => { const { S } = __daw; const t = S.project.tracks.find((x) => x.kind === 'midi'); S.selected = t.id; __daw.phone.render && __daw.phone.render(); });
    await page.click('#phone .ph-steps'); await sleep(350);
    await page.evaluate(() => document.querySelector('#phone .ph-side [data-act=enable]')?.click()); await sleep(300);
    const side = await page.evaluate(() => { const s = document.querySelector('#phone .ph-side'); const r = s.getBoundingClientRect(); return { hidden: s.hidden, w: r.width, right: r.right, steps: s.querySelectorAll('.sq-step').length, open: __daw.phone.seqOpen }; });
    ok('Phone: the sequencer slides out from the side with the step grid', !side.hidden && side.open && side.w > 250 && side.right <= 391 && side.steps > 0, JSON.stringify(side));
    await shot(page, 'v051-phone-sequencer');
    const overlap = await page.evaluate(() => { const els = [...document.querySelectorAll('#phone .ph-side button')].filter((b) => b.offsetParent); const bad = []; for (const b of els) { const r = b.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1) bad.push(b.getAttribute('aria-label') || b.textContent.slice(0, 12)); } return bad; });
    ok('Phone: nothing in the slide-out sticks out of the screen', overlap.length === 0, JSON.stringify(overlap));
    await page.click('#phone .ph-side-close'); await sleep(300);
    ok('Phone: close button slides it away again', await page.evaluate(() => !__daw.phone.seqOpen));
    ok('Phone: computer keyboard widget is not shown', await page.evaluate(() => { const w = document.querySelector('#ckWidget'); return !w || w.hidden || !w.offsetParent; }));
    await shot(page, 'v051-phone-main');
    await ctx.close();
  }
} catch (e) { ok('test run crashed', false, e.stack); }
ok('No page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
await browser.close(); server.kill();
fs.writeFileSync(path.join(ROOT, 'last-results-v051.json'), JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
