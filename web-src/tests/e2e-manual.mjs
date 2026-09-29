// User manual: in-app links (desktop Menu, Help bar, phone More) open the bundled PDF. Run: node tests/e2e-manual.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import path from 'node:path';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = +(process.env.PORT || 8796), BASE = '/daw/';
const URL_ = `http://localhost:${PORT}${BASE}?nosw`;
const results = [];
const ok = (name, cond, info = '') => { results.push({ name, pass: !!cond, info }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + String(info).slice(0, 400) : ''}`); };
const server = spawn('node', [path.join(ROOT, 'tools/serve.mjs'), path.join(ROOT, 'dist'), String(PORT), BASE], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let browser;
async function open(ctxOpts, prefs) {
  const ctx = await browser.newContext(ctxOpts);
  await ctx.addInitScript((p) => localStorage.setItem('auduio.prefs', JSON.stringify(p)), prefs);
  await ctx.addInitScript(() => { const o = window.open; window.__opened = []; window.open = function (u, ...a) { window.__opened.push(new URL(u, location.href).href); return o.call(window, u, ...a); }; });
  const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_); await page.click('#startBtn').catch(() => page.tap('#startBtn'));
  await page.waitForFunction(() => window.__daw && __daw.S.project && !document.querySelector('#startOverlay'), null, { timeout: 20000 }); await sleep(300);
  return { ctx, page };
}
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.DAW_BROWSER, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  // the PDF ships in the app and is served
  const res = await fetch(`http://localhost:${PORT}${BASE}manual/Auduio-Manual.pdf`);
  const head = new Uint8Array(await res.arrayBuffer()).slice(0, 5);
  ok('The manual PDF is part of the app and is served (200, application/pdf, %PDF header)', res.status === 200 && /pdf/.test(res.headers.get('content-type')) && String.fromCharCode(...head) === '%PDF-', res.status + ' ' + res.headers.get('content-type'));
  const sw = fs.readFileSync(path.join(ROOT, 'dist', 'sw.js'), 'utf8');
  ok('The 2.6 MB PDF is not in the install-time precache (cached on first open instead)', !/Auduio-Manual\.pdf/.test(sw) && /index\.html/.test(sw));
  // desktop: Menu > User manual (PDF) opens a new tab with the PDF
  const d = await open({ viewport: { width: 1280, height: 800 } }, { guideDone: true, tutorialDone: true, phoneMode: 'off' });
  await d.page.click('#btnMenu'); await sleep(150);
  const item = await d.page.evaluate(() => [...document.querySelectorAll('#menu button')].map((b) => b.textContent).find((t) => /User manual/.test(t)));
  const [pop] = await Promise.all([d.ctx.waitForEvent('page', { timeout: 5000 }), d.page.evaluate(() => [...document.querySelectorAll('#menu button')].find((b) => /User manual/.test(b.textContent)).click())]);
  const u1 = await d.page.evaluate(() => window.__opened.slice(-1)[0]);
  ok('Desktop: Menu has "User manual (PDF)" and it opens the PDF in a new tab', item === 'User manual (PDF)' && !!pop && /\/daw\/manual\/Auduio-Manual\.pdf$/.test(u1), `${item} -> ${u1}`);
  await pop.close();
  await d.page.click('#btnHelp'); await sleep(150);
  const bar = await d.page.evaluate(() => [...document.querySelectorAll('.help-bar button')].map((b) => b.textContent));
  ok('Help mode bar also offers "User manual"', bar.includes('User manual'), JSON.stringify(bar));
  await d.ctx.close();
  // phone: More > User manual
  const p = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }, { guideDone: true, tutorialDone: true, phoneMode: 'on' });
  await p.page.tap('.ph-tab[data-tab=more]'); await sleep(250);
  const [pop2] = await Promise.all([p.ctx.waitForEvent('page', { timeout: 5000 }), p.page.tap('.ph-manual')]);
  const u2 = await p.page.evaluate(() => window.__opened.slice(-1)[0]);
  ok('Phone: More > User manual opens the PDF in a new tab', !!pop2 && /\/daw\/manual\/Auduio-Manual\.pdf$/.test(u2), u2);
  await p.ctx.close();
  ok('No page errors', !errors.length, errors.join(' | '));
} catch (e) { ok('manual test run completed without exception', false, e.stack || e.message); }
finally { if (browser) await browser.close(); server.kill(); }
const pass = results.filter((r) => r.pass).length;
console.log(`\n${pass}/${results.length} manual checks passed`);
process.exit(pass === results.length ? 0 : 1);
