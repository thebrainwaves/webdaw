// Computer MIDI keyboard: play the selected (or armed) instrument track from the letter keys.
//   A W S E D F T G Y H U J K O L P ;  = notes (white keys on the home row, black keys above)
//   Z / X = octave down / up, C / V = velocity down / up. M (in main.js) switches it on/off.
// Physical key codes are used, so it works on any keyboard layout. Keys never fire while typing in a text field
// or a dialog. Every note-on is paired with a note-off on the SAME targets and pitch (even if the octave or the
// selected track changed in between), and all held notes are released when the window loses focus, the tab is
// hidden, a text field gets focus or the keyboard is switched off: no stuck notes.
import { h, $, prefs, savePrefs } from './dom.js';
import { icon } from './icons.js';

export const KEY_MAP = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };
export const VELS = [1, 20, 40, 60, 80, 100, 127];
const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const name = (n) => NN[n % 12] + (Math.floor(n / 12) - 1);
const BLACK = new Set([1, 3, 6, 8, 10]);

export function isTyping(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName; if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !/^(range|checkbox|radio|button|submit|reset|color|file)$/i.test(el.type || 'text');
  return false;
}

export function createCompKeys(api) {
  // api: { targets(): tracks, noteOn(t, n, v), noteOff(t, n), hint(msg), onToggle() }
  const st = { on: !!prefs.compKeys, base: Math.max(0, Math.min(108, prefs.compKeysBase ?? 60)), vi: Math.max(0, Math.min(VELS.length - 1, prefs.compKeysVel ?? 5)) };
  const held = new Map(); // key code or 'ptr:<id>' -> { n, targets }
  let widget = null, hinted = 0;
  const vel = () => VELS[st.vi];
  const save = () => { prefs.compKeys = st.on; prefs.compKeysBase = st.base; prefs.compKeysVel = st.vi; savePrefs(); };

  function press(id, n) {
    if (held.has(id) || n < 0 || n > 127) return;
    const targets = api.targets();
    if (!targets.length) { if (Date.now() - hinted > 4000) { hinted = Date.now(); api.hint('Select an instrument (MIDI) track to play it from the computer keyboard.'); } return; }
    held.set(id, { n, targets });
    for (const t of targets) api.noteOn(t, n, vel());
    paint();
  }
  function release(id) {
    const e = held.get(id); if (!e) return; held.delete(id);
    // only release the pitch if no other held key still plays it on that track
    for (const t of e.targets) { if (![...held.values()].some((o) => o.n === e.n && o.targets.includes(t))) api.noteOff(t, e.n); }
    paint();
  }
  function releaseAll() { for (const id of [...held.keys()]) release(id); }
  function setOn(on) { if (!on) releaseAll(); st.on = !!on; save(); render(); if (api.onToggle) api.onToggle(st.on); }
  function octave(d) { st.base = Math.max(0, Math.min(108, st.base + 12 * d)); save(); render(); }
  function velocity(d) { st.vi = Math.max(0, Math.min(VELS.length - 1, st.vi + d)); save(); render(); }

  function onKeyDown(e) {
    if (!st.on || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target) || (document.querySelector('dialog[open]'))) return false;
    const c = e.code;
    if (c in KEY_MAP) { e.preventDefault(); if (!e.repeat) press(c, st.base + KEY_MAP[c]); return true; }
    if (c === 'KeyZ' || c === 'KeyX') { e.preventDefault(); if (!e.repeat) octave(c === 'KeyZ' ? -1 : 1); return true; }
    if (c === 'KeyC' || c === 'KeyV') { e.preventDefault(); if (!e.repeat) velocity(c === 'KeyC' ? -1 : 1); return true; }
    return false;
  }
  function onKeyUp(e) { if (held.has(e.code)) { release(e.code); return true; } return false; }
  document.addEventListener('keydown', (e) => { if (onKeyDown(e)) e.stopImmediatePropagation(); }, true);
  document.addEventListener('keyup', (e) => { if (onKeyUp(e)) e.stopImmediatePropagation(); }, true);
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  window.addEventListener('pagehide', releaseAll);
  document.addEventListener('focusin', (e) => { if (isTyping(e.target)) releaseAll(); });

  // ---- on-screen indicator + clickable mini piano (two octaves from the current base note)
  function render() {
    if (!st.on) { if (widget) widget.hidden = true; return; }
    if (!widget) build();
    widget.hidden = false;
    $('.ck-oct', widget).textContent = name(st.base);
    $('.ck-vel', widget).textContent = String(vel());
    const kb = $('.ck-kb', widget); kb.replaceChildren();
    const whites = [];
    for (let i = 0; i < 25; i++) { const n = st.base + i; if (n > 127) break; if (!BLACK.has(n % 12)) whites.push(n); }
    const wW = 100 / whites.length;
    for (const [wi, n] of whites.entries()) kb.append(h('button', { class: 'ck-k w', 'data-note': n, 'aria-label': name(n), style: { left: wi * wW + '%', width: wW + '%' } }, n % 12 === 0 ? name(n) : ''));
    for (const [wi, n] of whites.entries()) { const b = n + 1; if (BLACK.has(b % 12) && b <= st.base + 24 && b <= 127) kb.append(h('button', { class: 'ck-k b', 'data-note': b, 'aria-label': name(b), style: { left: `calc(${(wi + 1) * wW}% - ${wW * 0.3}%)`, width: wW * 0.6 + '%' } })); }
    paint();
  }
  function paint() {
    if (!widget || widget.hidden) return;
    const on = new Set([...held.values()].map((e) => e.n));
    widget.querySelectorAll('.ck-k').forEach((k) => k.classList.toggle('down', on.has(+k.dataset.note)));
  }
  function build() {
    widget = h('div', { id: 'ckWidget', class: 'ck', role: 'group', 'aria-label': 'Computer MIDI keyboard' },
      h('div', { class: 'ck-top' },
        h('span', { class: 'ck-t' }, icon('keys'), 'Computer keys'),
        h('span', { class: 'ck-info', title: 'Z / X: octave down / up' }, 'Oct ', h('b', { class: 'ck-oct' })),
        h('button', { class: 'ck-mini', 'aria-label': 'Octave down (Z)', title: 'Octave down (Z)', onclick: () => octave(-1) }, '-'),
        h('button', { class: 'ck-mini', 'aria-label': 'Octave up (X)', title: 'Octave up (X)', onclick: () => octave(1) }, '+'),
        h('span', { class: 'ck-info', title: 'C / V: velocity down / up' }, 'Vel ', h('b', { class: 'ck-vel' })),
        h('button', { class: 'ck-mini', 'aria-label': 'Velocity down (C)', title: 'Velocity down (C)', onclick: () => velocity(-1) }, '-'),
        h('button', { class: 'ck-mini', 'aria-label': 'Velocity up (V)', title: 'Velocity up (V)', onclick: () => velocity(1) }, '+'),
        h('button', { class: 'ck-close', 'aria-label': 'Switch the computer keyboard off (M)', title: 'Switch off (M)', onclick: () => setOn(false) }, icon('close'))),
      h('div', { class: 'ck-kb' }),
      h('div', { class: 'ck-help' }, 'A W S E D F T G Y H U J K O L P ;  play  ·  Z X octave  ·  C V velocity'));
    const kb = $('.ck-kb', widget);
    kb.addEventListener('pointerdown', (e) => { const k = e.target.closest('.ck-k'); if (!k) return; e.preventDefault(); try { kb.setPointerCapture(e.pointerId); } catch (x) {} press('ptr:' + e.pointerId, +k.dataset.note); });
    kb.addEventListener('pointermove', (e) => { const id = 'ptr:' + e.pointerId; if (!held.has(id)) return; const el = document.elementFromPoint(e.clientX, e.clientY), k = el && el.closest && el.closest('.ck-k'); if (k && +k.dataset.note !== held.get(id).n) { release(id); press(id, +k.dataset.note); } });
    const up = (e) => release('ptr:' + e.pointerId);
    kb.addEventListener('pointerup', up); kb.addEventListener('pointercancel', up); kb.addEventListener('lostpointercapture', up);
    document.body.append(widget);
  }
  render();
  return { get on() { return st.on; }, toggle: () => setOn(!st.on), setOn, octave, velocity, releaseAll, get base() { return st.base; }, get velocity_() { return vel(); }, get held() { return held.size; }, render };
}
