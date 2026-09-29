// Interactive first-run tutorial: one sentence per step, a highlight ring on the real control, advances
// when you use the control (or tap Next). Skippable; replay from Help / More → Tutorial.
import { h, $, prefs, savePrefs } from './dom.js';

export function createTutorial() {
  let steps = [], i = 0, layer = null, ring = null, bubble = null, timer = null, onTarget = null, done = null;
  function stop(finished) {
    clearInterval(timer); timer = null;
    if (onTarget) { document.removeEventListener('click', onTarget, true); onTarget = null; }
    if (layer) layer.remove(); layer = null;
    prefs.tutorialDone = true; savePrefs();
    const d = done; done = null; if (d) d(finished);
  }
  function start(list, { onDone } = {}) {
    if (layer) stop(false);
    steps = list; i = 0; done = onDone || null;
    layer = h('div', { class: 'tut', role: 'dialog', 'aria-live': 'polite', 'aria-label': 'Tutorial' });
    ring = h('div', { class: 'tut-ring' }); bubble = h('div', { class: 'tut-bubble' });
    layer.append(ring, bubble); document.body.append(layer);
    show();
    timer = setInterval(place, 250); // follow layout changes / wait for targets to appear
  }
  const target = () => { const s = steps[i]; if (!s) return null; const el = typeof s.target === 'function' ? s.target() : $(s.target); return el && el.offsetParent !== null ? el : null; };
  function show() {
    if (!layer) return;
    if (i >= steps.length) return stop(true);
    const s = steps[i];
    if (s.before) try { s.before(); } catch (e) {}
    bubble.innerHTML = '';
    bubble.append(h('div', { class: 'tut-step' }, `Step ${i + 1} of ${steps.length}`), h('p', { class: 'tut-text' }, s.text),
      h('div', { class: 'tut-btns' },
        h('button', { class: 'tut-skip', onclick: () => stop(false) }, 'Skip tutorial'),
        h('button', { class: 'tut-next primary', onclick: () => next() }, i === steps.length - 1 ? 'Finish' : 'Next')));
    if (onTarget) document.removeEventListener('click', onTarget, true);
    // using the highlighted control counts as doing the step
    onTarget = (e) => { const el = target(); if (el && (el === e.target || el.contains(e.target))) setTimeout(() => next(), s.delay || 350); };
    document.addEventListener('click', onTarget, true);
    place();
  }
  function next() { if (!layer) return; i++; show(); }
  function place() {
    if (!layer) return;
    const el = target();
    if (!el) { ring.style.display = 'none'; bubble.classList.add('center'); bubble.style.left = ''; bubble.style.top = ''; return; }
    const r = el.getBoundingClientRect(), pad = 6;
    ring.style.display = 'block';
    Object.assign(ring.style, { left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: r.height + pad * 2 + 'px' });
    bubble.classList.remove('center');
    const bw = Math.min(320, innerWidth - 16), bh = bubble.offsetHeight || 120;
    let top = r.bottom + 14; if (top + bh > innerHeight - 8) top = Math.max(8, r.top - bh - 14);
    const left = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    Object.assign(bubble.style, { left: left + 'px', top: top + 'px', width: bw + 'px' });
  }
  return { start, stop, next, get running() { return !!layer; }, get step() { return i; }, get count() { return steps.length; } };
}
