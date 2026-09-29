// Small DOM helpers + preferences + haptics shared by the UI modules.
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
// Element builder. Never uses innerHTML for data; text is always inserted as text nodes.
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? e.style.setProperty(sk, sv) : (e.style[sk] = sv); }
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
let toastTimer;
export function toast(msg, ms = 2600) {
  const t = $('#toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
// ------------------------------------------------------------------ preferences (localStorage)
const PREF_KEY = 'webdaw.prefs';
const DEFAULTS = { easy: false, hc: false, haptics: true, guideDone: false, tutorialDone: false, phoneMode: 'auto', showTransients: true, autoRecThreshold: -40, autoRecPreroll: 1, sessionScale: 1 };
export const prefs = (() => { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch (e) { return { ...DEFAULTS }; } })();
export function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} }
// ------------------------------------------------------------------ haptics (silently ignored where unsupported, e.g. iOS Safari)
let lastBuzz = 0;
export function haptic(ms = 8) {
  if (!prefs.haptics || !navigator.vibrate) return;
  const now = performance.now(); if (now - lastBuzz < 35) return; lastBuzz = now;
  try { navigator.vibrate(ms); } catch (e) {}
}
