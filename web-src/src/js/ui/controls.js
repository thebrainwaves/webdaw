// Touch-friendly knob + fader controls (pointer events; drag vertically, double-tap to reset).
import { haptic } from './dom.js';

export function toNorm(p, v) {
  if (p.curve === 'log') return Math.log(v / p.min) / Math.log(p.max / p.min);
  return (v - p.min) / (p.max - p.min);
}
export function fromNorm(p, n) {
  n = Math.max(0, Math.min(1, n));
  if (p.curve === 'log') return p.min * Math.pow(p.max / p.min, n);
  return p.min + n * (p.max - p.min);
}
export function fmt(p, v) {
  if (p.unit === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : Math.round(v) + '';
  if (p.unit === 'ms') return v < 10 ? v.toFixed(1) : Math.round(v) + '';
  if (p.unit === 's') return v.toFixed(2);
  if (p.unit === 'dB') return (v > 0 ? '+' : '') + v.toFixed(1);
  if (p.unit === ':1') return v.toFixed(1) + ':1';
  if (p.unit === '%') return Math.round(v) + '%';
  return Math.abs(v) < 10 ? v.toFixed(2) : Math.round(v) + '';
}

function onDoubleTap(el, fn) {
  let last = 0;
  el.addEventListener('dblclick', (e) => { e.preventDefault(); fn(); });
  el.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = Date.now(); if (now - last < 300) fn(); last = now;
  });
}

// Generic vertical-drag behaviour. Fine mode: hold Shift/Alt (desktop) or put a second finger on
// the control (touch). In fine mode `fine` (if given) moves in small value steps with a light haptic
// tick per step and a precision readout.
function dragValue(el, getNorm, setNorm, sensitivity = 180, defNorm = null, onStart = null, fine = null) {
  const touches = new Set(); let primary = null;
  el.addEventListener('pointerdown', (e) => {
    if (document.body.classList.contains('learn') || document.body.classList.contains('helpmode') || document.body.classList.contains('maplearn')) return; // handled by MIDI learn / help
    e.preventDefault();
    touches.add(e.pointerId);
    if (primary != null) return; // second finger: only switches to fine mode
    primary = e.pointerId;
    if (onStart) onStart();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    let startY = e.clientY, startX = e.clientX, start = getNorm(), fineMode = false, startVal = 0, lastSteps = 0;
    let detent = Math.floor(start * 24);
    el.classList.add('active');
    const move = (ev) => {
      if (ev.pointerId !== primary) return;
      const wantFine = !!(ev.shiftKey || ev.altKey || touches.size > 1);
      if (wantFine !== fineMode) { fineMode = wantFine; startY = ev.clientY; startX = ev.clientX; start = getNorm(); startVal = fine ? fine.get() : 0; lastSteps = 0; el.classList.toggle('fine', fineMode); if (fineMode && fine) fine.show(); }
      const px = (startY - ev.clientY) + (ev.clientX - startX) * 0.5;
      if (fineMode && fine) {
        const steps = Math.round(px / fine.pxPerStep);
        if (steps !== lastSteps) { lastSteps = steps; haptic(2); fine.set(startVal + steps * fine.step); fine.show(); }
        return;
      }
      const d = px / sensitivity * (fineMode ? 0.2 : 1);
      const n = Math.max(0, Math.min(1, start + d));
      const det = Math.floor(n * 24);
      if (det !== detent) { // haptic "detents"; a stronger pulse when crossing the default value
        const crossedDef = defNorm != null && (Math.floor(defNorm * 24) === det);
        haptic(crossedDef ? 12 : 3); detent = det;
      }
      setNorm(n);
    };
    const up = (ev) => {
      touches.delete(ev.pointerId);
      if (ev.pointerId !== primary) return;
      primary = null; touches.clear();
      el.classList.remove('active', 'fine'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault(); if (onStart) onStart();
    if ((e.shiftKey || e.altKey) && fine) { fine.set(fine.get() - Math.sign(e.deltaY || e.deltaX) * fine.step); fine.show(); el.classList.add('fine'); clearTimeout(el._fineT); el._fineT = setTimeout(() => el.classList.remove('fine'), 900); return; }
    setNorm(Math.max(0, Math.min(1, getNorm() - Math.sign(e.deltaY) * 0.02)));
  }, { passive: false });
}
export function fmtFine(p, v) {
  if (p.type === 'select') return String(v);
  if (p.unit === 'dB') return (v > 0 ? '+' : '') + v.toFixed(2) + ' dB';
  if (p.unit === 'Hz') return (v < 100 ? v.toFixed(2) : v.toFixed(1)) + ' Hz';
  if (p.step) return String(Math.round(v)) + (p.unit ? ' ' + p.unit : '');
  const a = Math.abs(v); return (a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : v.toFixed(3)) + (p.unit ? ' ' + p.unit : '');
}

export function createKnob(param, value, onChange, opts = {}) {
  const el = document.createElement('div');
  el.className = 'knob' + (opts.small ? ' small' : '');
  el.title = (param.help ? `${param.label}: ${param.help}` : param.label + (param.unit ? ` (${param.unit})` : '')) + ' — drag up/down; Shift/Alt-drag or a second finger = fine; double-tap resets';
  if (opts.learnKey) el.dataset.learn = opts.learnKey;
  el.innerHTML = `<svg viewBox="0 0 40 40"><circle class="k-bg" cx="20" cy="20" r="15"/><path class="k-track"/><path class="k-val"/><line class="k-ptr" x1="20" y1="20" x2="20" y2="7"/></svg><div class="k-label">${param.label}</div><div class="k-value"></div><div class="k-fine" aria-hidden="true"></div>`;
  el.setAttribute('role', 'slider'); el.tabIndex = 0;
  const valEl = el.querySelector('.k-value'), arc = el.querySelector('.k-val'), trk = el.querySelector('.k-track'), ptr = el.querySelector('.k-ptr');
  const A0 = -135, A1 = 135;
  const pt = (a) => { const r = (a - 90) * Math.PI / 180; return [20 + 15 * Math.cos(r), 20 + 15 * Math.sin(r)]; };
  const arcPath = (a, b) => { const [x0, y0] = pt(a), [x1, y1] = pt(b); return `M${x0} ${y0} A15 15 0 ${b - a > 180 ? 1 : 0} 1 ${x1} ${y1}`; };
  trk.setAttribute('d', arcPath(A0, A1));
  const bipolar = param.min < 0 && param.max > 0 && param.curve !== 'log';
  let v = value;
  const render = () => {
    const n = toNorm(param, v); const a = A0 + n * (A1 - A0);
    const zero = bipolar ? A0 + toNorm(param, 0) * (A1 - A0) : A0;
    arc.setAttribute('d', Math.abs(a - zero) < 0.5 ? '' : arcPath(Math.min(a, zero), Math.max(a, zero)));
    ptr.setAttribute('transform', `rotate(${a} 20 20)`);
    valEl.textContent = fmt(param, v) + (param.unit && !['%', ':1'].includes(param.unit) && !opts.small ? '' : '');
    el.setAttribute('aria-valuetext', fmt(param, v) + ' ' + (param.unit || ''));
  };
  let glowT;
  const set = (nv, fire = true) => { if (param.step) nv = Math.round(nv / param.step) * param.step; nv = Math.max(param.min, Math.min(param.max, nv)); if (nv === v && fire) return; v = nv; render(); if (fire) { onChange(v); el.classList.add('glow'); clearTimeout(glowT); glowT = setTimeout(() => el.classList.remove('glow'), 400); } };
  const fineEl = el.querySelector('.k-fine');
  const fine = param.curve === 'log'
    ? { get: () => toNorm(param, v), step: 1 / 4000, pxPerStep: 2, set: (n) => set(fromNorm(param, n)) }
    : { get: () => v, step: param.step || (param.unit === 'dB' ? 0.01 : (param.max - param.min) / 4000), pxPerStep: param.step ? 10 : 2, set: (x) => set(x) };
  fine.show = () => { fineEl.textContent = fmtFine(param, v); };
  dragValue(el, () => toNorm(param, v), (n) => set(fromNorm(param, n)), 180, toNorm(param, param.def), opts.onStart, fine);
  onDoubleTap(el, () => set(param.def));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(fromNorm(param, toNorm(param, v) + 0.01));
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(fromNorm(param, toNorm(param, v) - 0.01));
  });
  render();
  el.setValue = (nv) => set(nv, false);
  return el;
}

// dB fader: -60..+6 with a perceptual curve
const FADER_MIN = -60, FADER_MAX = 6;
const dbToF = (db) => db <= FADER_MIN ? 0 : Math.pow((db - FADER_MIN) / (FADER_MAX - FADER_MIN), 2.2);
const fToDb = (f) => f <= 0 ? -Infinity : FADER_MIN + Math.pow(f, 1 / 2.2) * (FADER_MAX - FADER_MIN);
export function createFader(value, onChange, onStart) {
  const el = document.createElement('div');
  el.className = 'fader'; el.title = 'Volume — drag up/down, double-tap for 0 dB';
  el.innerHTML = '<div class="f-track"><div class="f-fill"></div><div class="f-thumb"></div></div><div class="f-val"></div>';
  const thumb = el.querySelector('.f-thumb'), fill = el.querySelector('.f-fill'), val = el.querySelector('.f-val');
  let v = value;
  const norm = () => Math.pow(dbToF(v), 1 / 2.2);
  const render = () => {
    const n = norm();
    thumb.style.bottom = `calc(${n * 100}% - 5px)`; fill.style.height = n * 100 + '%';
    val.textContent = v <= FADER_MIN ? '-inf' : (v > 0 ? '+' : '') + v.toFixed(1);
  };
  const set = (nv, fire = true) => { v = Math.max(FADER_MIN, Math.min(FADER_MAX, nv)); render(); if (fire) onChange(v <= FADER_MIN ? -100 : v); };
  dragValue(el, norm, (n) => set(fToDb(Math.pow(n, 2.2))), 140, 60 / 66, onStart);
  onDoubleTap(el, () => set(0));
  render();
  el.setValue = (nv) => set(nv, false);
  return el;
}
