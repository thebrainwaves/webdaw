// Touch-friendly knob + fader controls (pointer events; drag vertically, double-tap to reset).

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

// Generic vertical-drag behaviour; fine mode with shift or second finger not needed on phones.
function dragValue(el, getNorm, setNorm, sensitivity = 180) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    const startY = e.clientY, startX = e.clientX, start = getNorm();
    el.classList.add('active');
    const move = (ev) => {
      const fine = ev.shiftKey ? 0.2 : 1;
      const d = ((startY - ev.clientY) + (ev.clientX - startX) * 0.5) / sensitivity * fine;
      setNorm(Math.max(0, Math.min(1, start + d)));
    };
    const up = () => { el.classList.remove('active'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', (e) => { e.preventDefault(); setNorm(Math.max(0, Math.min(1, getNorm() - Math.sign(e.deltaY) * 0.02))); }, { passive: false });
}

export function createKnob(param, value, onChange, opts = {}) {
  const el = document.createElement('div');
  el.className = 'knob' + (opts.small ? ' small' : '');
  el.title = param.label;
  el.innerHTML = `<svg viewBox="0 0 40 40"><circle class="k-bg" cx="20" cy="20" r="15"/><path class="k-track"/><path class="k-val"/><line class="k-ptr" x1="20" y1="20" x2="20" y2="7"/></svg><div class="k-label">${param.label}</div><div class="k-value"></div>`;
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
  const set = (nv, fire = true) => { v = nv; render(); if (fire) onChange(v); };
  dragValue(el, () => toNorm(param, v), (n) => set(fromNorm(param, n)));
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
export function createFader(value, onChange) {
  const el = document.createElement('div');
  el.className = 'fader';
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
  dragValue(el, norm, (n) => set(fToDb(Math.pow(n, 2.2))), 140);
  onDoubleTap(el, () => set(0));
  render();
  el.setValue = (nv) => set(nv, false);
  return el;
}
