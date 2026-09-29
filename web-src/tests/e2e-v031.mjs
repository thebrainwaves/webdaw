// v0.3.1 checks: no emoji anywhere in the rendered UI, instant clip/slot audition, auto-monitoring of the
// selected armed track, professional styling. Run after `node tools/build.mjs`: node tests/e2e-v031.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8769), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 600) : ''}`); };
const shots = path.join(ROOT, 'screenshots', 'v3'); fs.mkdirSync(shots, { recursive: true });
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
// Emoji / pictograph detector used on the rendered DOM: Unicode Extended_Pictographic plus the symbol blocks
// that were used as icons before (geometric shapes, dingbats, misc technical, arrows except plain → and ←).
const SCAN = `(() => {
  const re = /[\\p{Extended_Pictographic}\\u{1F000}-\\u{1FAFF}\\u2600-\\u27BF\\u25A0-\\u25FF\\u2300-\\u23FF\\u2193-\\u21FF\\uFF0B\\uFE0F]/u;
  const hits = [];
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while ((n = walk.nextNode())) { if (re.test(n.nodeValue)) hits.push('text:' + n.nodeValue.trim().slice(0, 40)); }
  for (const el of document.querySelectorAll('[title],[aria-label],[placeholder],option,optgroup')) for (const a of ['title', 'aria-label', 'placeholder', 'label']) { const v = el.getAttribute(a); if (v && re.test(v)) hits.push(a + ':' + v.slice(0, 40)); }
  for (const el of document.querySelectorAll('body *')) { for (const pe of ['::before', '::after']) { const c = getComputedStyle(el, pe).content; if (c && c !== 'none' && c !== 'normal' && re.test(c)) hits.push('css' + pe + ':' + c); } }
  const t = document.title; if (re.test(t)) hits.push('title:' + t);
  return [...new Set(hits)];
})()`;
const MK = `window.__mkBuf = (id, secs) => { const { engine } = __daw; const sr = engine.ctx.sampleRate; const b = engine.ctx.createBuffer(2, Math.round(sr * secs), sr);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < d.length; i++) { const t = i / sr; d[i] = Math.exp(-(t % 0.5) * 6) * 0.7 * Math.sin(2 * Math.PI * 220 * t); } } engine.buffers.set(id, b); return b; };`;

try {
  const { ctx, page } = await newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(URL_);
  const startHits = await page.evaluate(SCAN);
  await page.click('#startBtn'); await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300);
  await page.evaluate(MK);
  // content that exercises most UI: clips, fx cards, MIDI track, group, locked features
  await page.evaluate(() => { const { S, engine } = __daw; __mkBuf('ba', 4); const t = S.project.tracks[0]; t.slots[0] = { bufferId: 'ba', name: 'Loop A', loopLength: 2 };
    t.arrangement.push({ id: 'ca', bufferId: 'ba', start: 0, offset: 0, duration: 4, name: 'Take A' }); t.fx.push({ type: 'compressor', enabled: true, values: {} }, { type: 'reverb', enabled: true, values: {} }); engine.setTrackFx(t); engine.rescheduleTrack(t); });
  await page.evaluate(() => { [...document.querySelectorAll('.add-track')].find((b) => /Drums/.test(b.textContent)).click(); });
  await page.evaluate(() => { __daw.S.selected = __daw.S.project.tracks[0].id; document.querySelector('.views button[data-view=arrange]').click(); document.querySelector('.views button[data-view=session]').click(); });
  await sleep(300);
  const hits = { start: startHits };
  hits.session = await page.evaluate(SCAN);
  await page.click('.views button[data-view=arrange]'); await sleep(300); hits.arrange = await page.evaluate(SCAN);
  await page.click('#btnMenu'); await sleep(200); hits.menu = await page.evaluate(SCAN); await page.keyboard.press('Escape');
  await page.click('#arrangeView .aclip[data-clip="ca"]', { button: 'right' }); await sleep(200); hits.ctx = await page.evaluate(SCAN); await page.keyboard.press('Escape');
  await page.evaluate(() => __daw.engine.stopAudition());
  await page.click('#btnHelp'); await sleep(150); hits.help = await page.evaluate(SCAN); await page.click('#btnHelp');
  await page.evaluate(() => __daw.tutorial.start([{ target: '#btnRec', text: 'x' }])); await sleep(200); hits.tut = await page.evaluate(SCAN); await page.evaluate(() => __daw.tutorial.stop());
  const allHits = Object.entries(hits).filter(([, v]) => v.length);
  ok('No emoji / pictographic characters in the rendered desktop UI (start screen, session, arrangement, menus, help, tutorial)', !allHits.length, JSON.stringify(allHits));
  const svgIcons = await page.evaluate(() => ['#btnPlay', '#btnStop', '#btnRec', '#btnMenu', '#btnUndo'].map((s) => !!document.querySelector(s + ' svg.ico')));
  ok('Transport and menu buttons use SVG line icons', svgIcons.every(Boolean), JSON.stringify(svgIcons));

  // ---- audition: arrangement clip (press = instant; quick tap latches; second tap stops; hold = stop on release)
  const box = await page.evaluate(() => { const r = document.querySelector('.aclip[data-clip="ca"]').getBoundingClientRect(); return { x: r.left + 40, y: r.top + r.height / 2 }; });
  await page.mouse.move(box.x, box.y); await page.mouse.down();
  const t0 = await page.evaluate(() => ({ key: __daw.engine.audition && __daw.engine.audition.key, playing: __daw.engine.playing }));
  await page.mouse.up(); await sleep(250);
  const latched = await page.evaluate(() => !!__daw.engine.audition);
  const lvl = await page.evaluate(async () => { const { engine, S } = __daw; const t = S.project.tracks[0]; const pk = () => Math.max(...((engine.meters.get('master') || {}).peak || [0]));
    await new Promise((r) => setTimeout(r, 300)); const on = pk(); t.volume = -60; engine.syncTrack(t); await new Promise((r) => setTimeout(r, 400)); const down = pk(); t.volume = 0; engine.syncTrack(t); return { on: +on.toFixed(3), fader60: +down.toFixed(4) }; });
  await shot(page, 'desktop-audition-clip');
  await page.mouse.click(box.x, box.y); await sleep(150);
  const stopped = await page.evaluate(() => !__daw.engine.audition);
  await page.mouse.move(box.x, box.y); await page.mouse.down(); await sleep(600); const held = await page.evaluate(() => !!__daw.engine.audition); await page.mouse.up(); await sleep(100);
  const releasedStops = await page.evaluate(() => !__daw.engine.audition);
  ok('Arrangement clip: pressing it auditions instantly (transport stays stopped), through the track chain (reaches master; follows the track fader)', t0.key === 'arr:ca' && !t0.playing && lvl.on > 0.05 && lvl.fader60 < lvl.on / 20, JSON.stringify({ t0, lvl }));
  ok('Audition: quick tap keeps playing, a second tap stops; press-and-hold stops on release', latched && stopped && held && releasedStops, JSON.stringify({ latched, stopped, held, releasedStops }));
  // ---- audition: session slot
  await page.click('.views button[data-view=session]'); await sleep(250);
  const sp = await page.evaluate(() => { const t = __daw.S.project.tracks[0]; const r = document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="0"] .clip-name`).getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height / 2 }; });
  await page.mouse.click(sp.x, sp.y); await sleep(200);
  const sa = await page.evaluate(() => ({ key: __daw.engine.audition && __daw.engine.audition.key, loop: __daw.engine.audition && __daw.engine.audition.loop, playing: __daw.engine.playing, cls: !!document.querySelector('.slot.auditioning') }));
  await shot(page, 'desktop-audition-slot');
  await page.mouse.click(sp.x, sp.y); await sleep(150);
  const sStop = await page.evaluate(() => !__daw.engine.audition);
  ok('Session slot with audio: tap auditions immediately (looping, no bar quantize, marked PREVIEW); tap again stops', /^slot:/.test(sa.key || '') && sa.loop && !sa.playing && sa.cls && sStop, JSON.stringify({ sa, sStop }));
  // the launch button still launches into the session (quantized)
  await page.evaluate(() => { const t = __daw.S.project.tracks[0]; document.querySelector(`#sessionView .col[data-id="${t.id}"] .slot[data-slot="0"] .slot-launch`).click(); });
  await sleep(700);
  const launched = await page.evaluate(() => ({ playing: __daw.engine.playing, slot: __daw.engine.tracks.get(__daw.S.project.tracks[0].id).sessionSlot }));
  ok('The slot’s play button still launches the clip in the session', launched.playing && launched.slot === 0, JSON.stringify(launched));
  await page.evaluate(() => { __daw.engine.stop(); __daw.engine.stop(); });
  // ---- clip detail: Preview button + tap on the waveform = from that point
  await page.click('.views button[data-view=arrange]'); await sleep(250);
  await page.evaluate(() => { __daw.S.sel = { kind: 'arr', trackId: __daw.S.project.tracks[0].id, clipId: 'ca' }; document.querySelector('.views button[data-view=arrange]').click(); });
  await sleep(400);
  await page.click('.clip-detail .preview-btn, #devHead .preview-btn'); await sleep(200);
  const pv = await page.evaluate(() => ({ key: __daw.engine.audition && __daw.engine.audition.key, on: !!document.querySelector('.preview-btn.on') }));
  await page.click('.preview-btn'); await sleep(100);
  const ov = await page.evaluate(() => { const r = document.querySelector('.clip-over').getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height * 0.6 }; });
  await page.mouse.click(ov.x, ov.y); await sleep(300);
  const tapFrom = await page.evaluate(() => ({ off: __daw.engine.audition && +__daw.engine.audition.off.toFixed(2), pos: __daw.engine.auditionPos() }));
  await shot(page, 'desktop-clip-detail-preview');
  await page.mouse.click(ov.x, ov.y); await sleep(100);
  const tapStop = await page.evaluate(() => !__daw.engine.audition);
  ok('Clip detail: Preview button plays the clip; tapping the waveform plays from that point (≈2.0 s of 4 s); tap again stops', pv.key === 'detail' && pv.on && tapFrom.off > 1.6 && tapFrom.off < 2.4 && tapStop, JSON.stringify({ pv, tapFrom, tapStop }));
  // ---- auto-monitor: select an armed audio track → its input is heard; select another → off
  const mon = await page.evaluate(async () => {
    const { S, engine } = __daw; const [a, b] = S.project.tracks;
    const btn = document.querySelector(`.arr-heads [data-id="${a.id}"] .arm`); btn.click(); await new Promise((r) => setTimeout(r, 1200));
    const g = () => engine.tracks.get(a.id).monitor.gain.value;
    document.querySelector(`.arr-heads .lane-head[data-id="${a.id}"]`).click(); await new Promise((r) => setTimeout(r, 200)); const sel = g();
    document.querySelector(`.arr-heads .lane-head[data-id="${b.id}"]`).click(); await new Promise((r) => setTimeout(r, 200)); const other = g();
    document.querySelector(`.arr-heads .lane-head[data-id="${a.id}"]`).click(); await new Promise((r) => setTimeout(r, 200)); const back = g();
    return { arm: a.arm, sel: +sel.toFixed(2), other: +other.toFixed(2), back: +back.toFixed(2) };
  });
  ok('Auto-monitor: the selected armed track plays its input through its chain; selecting another track turns it off', mon.arm && mon.sel > 0.9 && mon.other < 0.1 && mon.back > 0.9, JSON.stringify(mon));
  const monOff = await page.evaluate(async () => { const { S, engine } = __daw; const p = JSON.parse(localStorage.getItem('webdaw.prefs')); engine.setAutoMonitor(S.selected, false); await new Promise((r) => setTimeout(r, 150)); const v = engine.tracks.get(S.project.tracks[0].id).monitor.gain.value; engine.setAutoMonitor(S.selected, true); return +v.toFixed(2); });
  ok('Auto-monitor can be switched off (Preferences)', monOff < 0.1, 'gain ' + monOff);
  await page.evaluate(() => { const a = __daw.S.project.tracks[0]; document.querySelector(`.arr-heads [data-id="${a.id}"] .arm`).click(); });
  await shot(page, 'desktop-arrangement-v031');
  await page.click('.views button[data-view=session]'); await sleep(300); await shot(page, 'desktop-session-v031');
  await ctx.close();

  // ---- phone: no emoji on any tab, icons in tab bar, preview from the Tracks screen
  const pc = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, { tutorialDone: true });
  const P = pc.page; await P.goto(URL_); await P.tap('#startBtn'); await P.waitForFunction(() => __daw.phone && __daw.phone.active, null, { timeout: 20000 }); await sleep(400);
  await P.evaluate(MK);
  await P.evaluate(() => { const { S, engine } = __daw; __mkBuf('bp', 3); S.project.tracks[0].arrangement.push({ id: 'cp', bufferId: 'bp', start: 0, offset: 0, duration: 3, name: 'Take 1' }); S.project.tracks[0].fx.push({ type: 'compressor', enabled: true, values: {} }); engine.setTrackFx(S.project.tracks[0]); __daw.phone.render(); });
  const ph = {};
  for (const tab of ['record', 'tracks', 'seq', 'mix', 'effects', 'more']) { await P.tap(`.ph-tab[data-tab=${tab}]`); await sleep(250); ph[tab] = await P.evaluate(SCAN); if (tab !== 'seq') await shot(P, `phone-390-${tab}-v031`); }
  await P.tap('.ph-tab[data-tab=effects]'); await P.tap('.ph-addfx'); await sleep(200); ph.sheet = await P.evaluate(SCAN); await P.keyboard.press('Escape'); await P.evaluate(() => document.querySelector('.ph-sheet') && document.querySelector('.ph-sheet').remove());
  const phHits = Object.entries(ph).filter(([, v]) => v.length);
  ok('No emoji in any phone screen (all six tabs incl. Steps + add-effect sheet); tab bar uses SVG icons', !phHits.length && (await P.evaluate(() => document.querySelectorAll('.ph-tab svg.ico').length)) === 6, JSON.stringify(phHits));
  await P.tap('.ph-tab[data-tab=tracks]'); await sleep(250);
  await P.tap('.ph-clip'); await sleep(250);
  const pa = await P.evaluate(() => ({ key: __daw.engine.audition && __daw.engine.audition.key, cls: !!document.querySelector('.ph-clip.auditioning') }));
  await shot(P, 'phone-390-preview');
  await P.tap('.ph-clip'); await sleep(150);
  const pStop = await P.evaluate(() => !__daw.engine.audition);
  await P.tap('.ph-wavebox'); await sleep(200); const wv = await P.evaluate(() => !!__daw.engine.audition); await P.tap('.ph-wavebox'); await sleep(100);
  ok('Phone: tapping a clip (or the big waveform) previews it; tapping again stops', pa.key === 'arr:cp' && pa.cls && pStop && wv, JSON.stringify({ pa, pStop, wv }));
  await pc.ctx.close();
  // tutorial on phone: screenshot of the restyled bubble
  const tc = await newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, null);
  await tc.page.goto(URL_); await tc.page.waitForSelector('.tut-bubble'); await sleep(300);
  const tutHits = await tc.page.evaluate(SCAN);
  await shot(tc.page, 'phone-390-tutorial-v031');
  ok('No emoji in the tutorial', !tutHits.length, JSON.stringify(tutHits));
  await tc.ctx.close();
} catch (e) { ok('v0.3.1 test run completed without exception', false, e.stack); }
const relevant = errors.filter((e) => !/favicon/i.test(e));
ok('No console errors / page errors (v0.3.1 run)', relevant.length === 0, relevant.join('\n'));
await browser.close(); server.kill();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} v0.3.1 checks passed`);
fs.writeFileSync(path.join(ROOT, 'tests', 'last-results-v031.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
