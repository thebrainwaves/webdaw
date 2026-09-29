// Monochrome line icons (24x24 grid, 1.75px stroke, currentColor). Transport glyphs are solid shapes.
// Used instead of emoji / Unicode pictographs so the UI renders identically everywhere.
const P = {
  play: '<path d="M7.5 5.2v13.6L18.5 12z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1" fill="currentColor" stroke="none"/>',
  record: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  seq: '<rect x="3" y="6" width="4" height="4" rx=".8"/><rect x="10" y="6" width="4" height="4" rx=".8" fill="currentColor"/><rect x="17" y="6" width="4" height="4" rx=".8"/><rect x="3" y="14" width="4" height="4" rx=".8" fill="currentColor"/><rect x="10" y="14" width="4" height="4" rx=".8"/><rect x="17" y="14" width="4" height="4" rx=".8" fill="currentColor"/>',
  cut: '<circle cx="6" cy="7" r="2.6"/><circle cx="6" cy="17" r="2.6"/><path d="M8.2 8.6 20 17M8.2 15.4 20 7"/>',
  chain: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6"/>',
  keys: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M7.5 5v14M12 5v14M16.5 5v14"/><path d="M6 5v8h3V5M15 5v8h3V5" fill="currentColor"/>',
  drums: '<ellipse cx="12" cy="10" rx="8" ry="3"/><path d="M4 10v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="m8 3 3.5 6M16 3l-3.5 6"/>',
  note: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>',
  group: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 10h18M3 14.5h18"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4"/><rect x="8" y="13" width="8" height="7"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.8 2.1c-.8.5-1.3 1.1-1.3 2.1"/><path d="M12 17h.01"/>',
  settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  mixer: '<path d="M6 4v16M12 4v16M18 4v16"/><path d="M4 14h4M10 8h4M16 11h4"/>',
  fx: '<path d="M3 12c1.5-5 3-5 4.5 0s3 5 4.5 0 3-5 4.5 0 3 5 4.5 0"/>',
  tracks: '<path d="M4 6h16M4 12h16M4 18h11"/>',
  more: '<circle cx="6" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="18" cy="12" r="1.4" fill="currentColor"/>',
  book: '<path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4zM20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z"/>',
  desktop: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  move: '<path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  loop: '<path d="m17 2 3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="m7 22-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="9" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r="1.3" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  plug: '<path d="M9 3v5M15 3v5"/><path d="M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  midi: '<circle cx="12" cy="12" r="9"/><circle cx="7.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="16.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="8.2" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="8.2" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none"/><path d="M10 17h4"/>',
  rack: '<rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="11" width="18" height="5" rx="1"/><path d="M7 20h10"/>',
  wave: '<path d="M3 12h2l2-6 3 12 3-9 2 6 2-3h4"/>',
  synth: '<rect x="3" y="7" width="18" height="12" rx="1.5"/><path d="M7 7v7M11 7v7M15 7v7"/><circle cx="7" cy="4" r="1"/><circle cx="12" cy="4" r="1"/><circle cx="17" cy="4" r="1"/>',
  editor: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8h18"/><circle cx="8" cy="14" r="2"/><path d="M13 12h5M13 16h5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.7L4 8"/><path d="M4 3v5h5"/><path d="M4 13a8 8 0 0 0 14.3 4.7L20 16"/><path d="M20 21v-5h-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>', chevUp: '<path d="m6 15 6-6 6 6"/>', chevRight: '<path d="m9 6 6 6-6 6"/>', chevLeft: '<path d="m15 6-6 6 6 6"/>',
  power: '<path d="M12 3v8"/><path d="M6.8 6.6a7.5 7.5 0 1 0 10.4 0"/>',
  height: '<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>',
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  logo: '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M6.5 12h2l1.5-4.5 3 9 1.5-4.5h3"/>',
};
export const ICON_NAMES = Object.keys(P);
export function iconSVG(name, cls = '') {
  return `<svg class="ico ico-${name}${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}
export function icon(name, cls = '') {
  const t = document.createElement('template'); t.innerHTML = iconSVG(name, cls); return t.content.firstChild;
}
// replace a button's content with an icon (keeps aria-label/title)
export function setIcon(el, name, text) { if (!el) return; el.replaceChildren(icon(name)); if (text) el.append(document.createTextNode(text)); }
