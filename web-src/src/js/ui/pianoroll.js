// Basic piano roll: tap empty = add note, drag note = move, drag right edge = resize,
// double-tap/click note or Delete = remove. Alt/Shift while dragging = no snap (1 tick = 1/960 beat).
// Arrow keys: Left/Right move the selected note by the grid (Alt = 1 tick), Shift+Left/Right change its
// length (Alt+Shift = 1 tick), Up/Down pitch (Shift = octave), Ctrl/Cmd+Up/Down velocity (Shift = 10).
// The number fields in the bar edit start / length (beats) and velocity exactly. Wheel/drag on keys = scroll pitch, ctrl+wheel or
// pinch = zoom, two-finger drag = pan. Edits are applied live (the scheduler reads the clip).
import { h, $, haptic } from './dom.js';
import { noteName } from '../audio/pitchdsp.js';

export function openPianoRoll({ clip, title, color = '#8B5CF6', history, onChange, preview, onUndo, view: keep }) {
  const view = Object.assign({ x0: 0, ppb: 60, top: 84, nh: 14 }, keep || {}); // top = highest visible note
  let grid = 0.25, sel = null, drag = null;
  const KEYW = 44;
  const canvas = h('canvas', { class: 'pr-canvas' });
  const lenInput = h('input', { type: 'number', min: 1, max: 256, step: 1, value: clip.lengthBeats, title: 'Clip length in beats', onchange: (e) => { history && history.push('Clip length'); clip.lengthBeats = Math.max(1, Math.min(256, +e.target.value || 4)); onChange && onChange('length'); draw(); } });
  const gridSel = h('select', { title: 'Note grid', onchange: (e) => { grid = +e.target.value; } }, [['1', '1/4'], ['0.5', '1/8'], ['0.25', '1/16'], ['0.125', '1/32']].map(([v, l]) => h('option', { value: v, selected: v === '0.25' }, l)));
  const TICK = 1 / 960;
  const tick = (b) => Math.round(b / TICK) * TICK;
  const fStart = h('input', { type: 'number', class: 'pr-num', min: 0, step: TICK, title: 'Note start in beats (1 tick = 1/960 beat)', 'aria-label': 'Note start (beats)', disabled: true, onchange: (e) => setSel('Note start', (nt) => { nt.t = Math.max(0, Math.min(clip.lengthBeats - TICK, tick(+e.target.value || 0))); }) });
  const fLen = h('input', { type: 'number', class: 'pr-num', min: TICK, step: TICK, title: 'Note length in beats', 'aria-label': 'Note length (beats)', disabled: true, onchange: (e) => setSel('Note length', (nt) => { nt.d = Math.max(TICK, Math.min(256, tick(+e.target.value || grid))); }) });
  const fVel = h('input', { type: 'number', class: 'pr-num vel', min: 1, max: 127, step: 1, title: 'Note velocity (1-127)', 'aria-label': 'Note velocity', disabled: true, onchange: (e) => setSel('Note velocity', (nt) => { nt.v = Math.max(1, Math.min(127, Math.round(+e.target.value || 100))); }) });
  const fName = h('span', { class: 'pr-note dim' }, '');
  function setSel(label, fn, key) { if (!sel) return; history && history.push(label, key); fn(sel); onChange && onChange('notes'); draw(); }
  function syncFields() {
    const on = !!sel; for (const f of [fStart, fLen, fVel]) f.disabled = !on;
    const fmt = (x) => String(Math.round(x * 1000) / 1000);
    if (on) { if (document.activeElement !== fStart) fStart.value = fmt(sel.t); if (document.activeElement !== fLen) fLen.value = fmt(sel.d); if (document.activeElement !== fVel) fVel.value = sel.v; fName.textContent = noteName(sel.n); }
    else { fStart.value = fLen.value = fVel.value = ''; fName.textContent = ''; }
  }
  const del = h('button', { title: 'Delete selected note', onclick: () => { if (sel) { history && history.push('Delete note'); clip.notes.splice(clip.notes.indexOf(sel), 1); sel = null; onChange && onChange('notes'); draw(); } } }, 'Delete');
  const ov = h('div', { class: 'pianoroll', role: 'dialog', 'aria-label': 'Piano roll' },
    h('div', { class: 'pr-bar' }, h('span', { class: 'pr-title', style: { '--c': color } }, title || 'MIDI clip'),
      h('label', { title: 'Grid' }, 'Grid ', gridSel), h('label', {}, 'Beats ', lenInput), del,
      h('span', { class: 'pr-fields', role: 'group', 'aria-label': 'Selected note' }, fName, h('label', {}, 'Start ', fStart), h('label', {}, 'Len ', fLen), h('label', {}, 'Vel ', fVel)),
      h('span', { class: 'hint' }, 'Tap: add · drag: move (Alt = free) · edge: length · arrows: nudge'),
      h('button', { class: 'pr-close', onclick: () => close(), title: 'Close piano roll' }, 'Done')),
    h('div', { class: 'pr-body' }, canvas));
  document.body.append(ov);
  const ctx2 = canvas.getContext('2d');
  const noteAt = (x, y) => {
    const b = view.x0 + (x - KEYW) / view.ppb, n = Math.floor(view.top - y / view.nh) + 1;
    const hit = clip.notes.find((nt) => nt.n === n && b >= nt.t && b <= nt.t + nt.d);
    return { beat: b, note: n, hit, edge: hit && (hit.t + hit.d - b) * view.ppb < 10 };
  };
  function draw() {
    const w = canvas.width = canvas.clientWidth * devicePixelRatio, hh = canvas.height = canvas.clientHeight * devicePixelRatio;
    const g = ctx2; g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    const W = w / devicePixelRatio, H = hh / devicePixelRatio;
    g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, W, H);
    const rows = Math.ceil(H / view.nh) + 1;
    for (let r = 0; r < rows; r++) {
      const n = view.top - r, black = [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
      g.fillStyle = black ? '#202020' : '#262626'; g.fillRect(KEYW, r * view.nh, W, view.nh);
      g.fillStyle = black ? '#111' : '#ddd'; g.fillRect(0, r * view.nh, KEYW - 2, view.nh - 1);
      if (n % 12 === 0) { g.fillStyle = '#555'; g.font = '9px sans-serif'; g.fillText(noteName(n), 2, r * view.nh + view.nh - 3); }
    }
    for (let b = Math.floor(view.x0); b <= view.x0 + W / view.ppb; b += grid) {
      const x = KEYW + (b - view.x0) * view.ppb; g.fillStyle = b % 4 === 0 ? '#444' : b % 1 === 0 ? '#333' : '#2a2a2a'; g.fillRect(x, 0, 1, H);
    }
    const endX = KEYW + (clip.lengthBeats - view.x0) * view.ppb; g.fillStyle = '#0008'; g.fillRect(endX, 0, W, H);
    for (const nt of clip.notes) {
      const x = KEYW + (nt.t - view.x0) * view.ppb, y = (view.top - nt.n) * view.nh;
      g.fillStyle = nt === sel ? '#fff' : color; g.globalAlpha = 0.5 + 0.5 * nt.v / 127;
      g.fillRect(x, y + 1, Math.max(3, nt.d * view.ppb - 1), view.nh - 2); g.globalAlpha = 1;
    }
    syncFields();
  }
  let free = false; // Alt/Shift held during a drag: no grid snap, 1-tick resolution
  const snap = (b) => Math.max(0, free ? tick(b) : Math.round(b / grid) * grid);
  const pointers = new Map(); let pinch = null, lastTap = 0;
  canvas.addEventListener('pointerdown', (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), ppb: view.ppb, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, x0: view.x0, top: view.top }; drag = null; return; }
    const hit = noteAt(e.offsetX, e.offsetY);
    if (e.offsetX < KEYW) { drag = { mode: 'scroll', y: e.offsetY, top: view.top }; if (preview) preview(hit.note); return; }
    const now = Date.now();
    if (hit.hit) {
      if (now - lastTap < 320 && sel === hit.hit) { history && history.push('Delete note'); clip.notes.splice(clip.notes.indexOf(hit.hit), 1); sel = null; onChange && onChange('notes'); draw(); haptic(10); return; }
      lastTap = now; sel = hit.hit; history && history.push('Edit note');
      drag = { mode: hit.edge ? 'resize' : 'move', nt: hit.hit, b0: hit.beat, t0: hit.hit.t, n0: hit.hit.n, d0: hit.hit.d };
    } else drag = { mode: 'maybe-add', x: e.offsetX, y: e.offsetY, x0: view.x0, top: view.top, hit };
    draw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      view.ppb = Math.max(15, Math.min(4000, pinch.ppb * d / pinch.d));
      view.x0 = Math.max(0, pinch.x0 + (pinch.cx - KEYW) / pinch.ppb - (cx - KEYW) / view.ppb);
      view.top = Math.max(20, Math.min(127, pinch.top + Math.round((cy - pinch.cy) / view.nh)));
      draw(); return;
    }
    if (!drag) return;
    free = e.altKey || e.shiftKey;
    const hit = noteAt(e.offsetX, e.offsetY);
    if (drag.mode === 'scroll') { view.top = Math.max(20, Math.min(127, drag.top + Math.round((e.offsetY - drag.y) / view.nh))); draw(); }
    else if (drag.mode === 'move') { const nt = drag.nt; const nn = Math.max(0, Math.min(127, drag.n0 + Math.round((drag.y0 ?? 0)))); nt.t = snap(drag.t0 + hit.beat - drag.b0); const newN = Math.max(0, Math.min(127, hit.note)); if (newN !== nt.n) { nt.n = newN; haptic(4); if (preview) preview(newN); } draw(); void nn; }
    else if (drag.mode === 'resize') { const mn = free ? TICK : grid; drag.nt.d = Math.max(mn, snap(hit.beat) - drag.nt.t || mn); draw(); }
    else if (drag.mode === 'maybe-add' && Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) > 8) { drag.mode = 'pan'; }
    if (drag.mode === 'pan') { view.x0 = Math.max(0, drag.x0 - (e.offsetX - drag.x) / view.ppb); view.top = Math.max(20, Math.min(127, drag.top + Math.round((e.offsetY - drag.y) / view.nh))); draw(); }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && drag.mode === 'maybe-add') {
      const b = Math.floor(drag.hit.beat / grid) * grid;
      if (b < clip.lengthBeats) { history && history.push('Add note'); const nt = { t: b, d: grid, n: drag.hit.note, v: 100 }; clip.notes.push(nt); sel = nt; haptic(8); if (preview) preview(nt.n); onChange && onChange('notes'); }
    } else if (drag && (drag.mode === 'move' || drag.mode === 'resize')) onChange && onChange('notes');
    drag = null; draw();
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const b = view.x0 + (e.offsetX - KEYW) / view.ppb; view.ppb = Math.max(15, Math.min(4000, view.ppb * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); view.x0 = Math.max(0, b - (e.offsetX - KEYW) / view.ppb); }
    else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) view.x0 = Math.max(0, view.x0 + (e.deltaX || e.deltaY) / view.ppb);
    else view.top = Math.max(20, Math.min(127, view.top - Math.sign(e.deltaY) * 2));
    draw();
  }, { passive: false });
  const onKey = (e) => {
    if (e.target && e.target.closest && e.target.closest('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && onUndo && (k === 'z' || k === 'y')) { e.preventDefault(); e.stopPropagation(); onUndo(k === 'y' || e.shiftKey); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); e.stopPropagation(); del.click(); }
    else if (e.key === 'Escape') close();
    else if (sel && e.key.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); nudge(e); }
  };
  function nudge(e) {
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 1, step = e.altKey ? TICK : grid;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (e.shiftKey) setSel('Note length', (nt) => { nt.d = Math.max(TICK, tick(nt.d + dir * step)); }, 'nl');
      else setSel('Nudge note', (nt) => { nt.t = Math.max(0, Math.min(clip.lengthBeats - TICK, tick(nt.t + dir * step))); }, 'nt');
    } else if (e.ctrlKey || e.metaKey) setSel('Note velocity', (nt) => { nt.v = Math.max(1, Math.min(127, nt.v + dir * (e.shiftKey ? 10 : 1))); }, 'nv');
    else setSel('Note pitch', (nt) => { nt.n = Math.max(0, Math.min(127, nt.n + dir * (e.shiftKey ? 12 : 1))); if (preview) preview(nt.n); }, 'np');
  }
  document.addEventListener('keydown', onKey, true);
  const ro = new ResizeObserver(draw); ro.observe(canvas);
  // centre view on existing notes
  if (clip.notes.length && !keep) view.top = Math.min(127, Math.max(...clip.notes.map((n) => n.n)) + 6);
  function close() { ro.disconnect(); document.removeEventListener('keydown', onKey, true); ov.remove(); onChange && onChange('close'); }
  draw();
  return { close, el: ov, select: (i) => { sel = clip.notes[i] || null; draw(); }, get selected() { return sel; }, view };
}
