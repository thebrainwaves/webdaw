// Device browser (desktop layout): a compact, collapsible sidebar listing instruments, MIDI effects,
// audio effects, racks and plugins. Items are added by dragging them onto a track (or the device panel),
// by double-clicking / pressing Enter (adds to the selected track) or with the + button on each row.
import { h, $, $$, prefs, savePrefs } from './dom.js';
import { icon } from './icons.js';

export const DEVICE_MIME = 'application/x-auduio-device';

export function createBrowser(api) {
  const root = api.root;
  let query = '';
  const closedSecs = new Set(Array.isArray(prefs.browserClosed) ? prefs.browserClosed : []);
  const isOpen = () => prefs.browserOpen !== false;

  function setOpen(on) {
    prefs.browserOpen = !!on; savePrefs(); render();
    if (api.onLayout) api.onLayout();
  }
  function toggleSec(id, force) {
    const open = force != null ? force : closedSecs.has(id);
    open ? closedSecs.delete(id) : closedSecs.add(id);
    prefs.browserClosed = [...closedSecs]; savePrefs(); render();
  }
  const match = (it) => !query || (it.label + ' ' + (it.search || '') + ' ' + (it.help || '')).toLowerCase().includes(query);

  function itemRow(it, sec) {
    const row = h('li', { class: 'br-item' + (it.locked ? ' locked' : '') + (it.disabled ? ' disabled' : ''), tabindex: 0, draggable: it.disabled ? 'false' : 'true', role: 'option',
      'data-kind': it.kind, 'data-type': it.type || '', title: (it.help || it.label) + (it.disabled ? '' : '\nDrag onto a track, or double-click to add to the selected track.'),
      style: { '--ic': it.color || sec.color } });
    row.append(h('span', { class: 'br-dot' }), h('span', { class: 'br-label' }, it.label));
    if (it.badge) row.append(h('span', { class: 'br-badge' }, it.badge));
    if (it.locked) row.append(h('span', { class: 'br-lock', title: 'Needs a higher tier' }, icon('lock')));
    if (!it.disabled) row.append(h('button', { class: 'br-add', title: 'Add to the selected track', 'aria-label': 'Add ' + it.label, onclick: (e) => { e.stopPropagation(); api.onAdd(it, null); } }, icon('plus')));
    if (!it.disabled) {
      row.addEventListener('dblclick', () => api.onAdd(it, null));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); api.onAdd(it, null); } });
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData(DEVICE_MIME, JSON.stringify(it.drag || { kind: it.kind, type: it.type, name: it.name }));
        e.dataTransfer.setData('text/plain', it.label);
        document.body.classList.add('dev-dragging');
      });
      row.addEventListener('dragend', () => { document.body.classList.remove('dev-dragging'); clearTargets(); });
    }
    return row;
  }

  function render() {
    root.innerHTML = '';
    root.classList.toggle('open', isOpen()); root.classList.toggle('closed', !isOpen());
    const secs = api.sections();
    if (!isOpen()) {
      // collapsed: a thin rail with one icon per section
      root.append(h('button', { class: 'br-toggle', title: 'Show the browser (B)', 'aria-label': 'Show browser', 'aria-expanded': 'false', onclick: () => setOpen(true) }, icon('sidebar')));
      for (const s of secs) root.append(h('button', { class: 'br-rail', title: s.label, 'aria-label': s.label, style: { '--ic': s.color }, onclick: () => { closedSecs.delete(s.id); prefs.browserClosed = [...closedSecs]; setOpen(true); setTimeout(() => { const el = $(`.br-sec[data-sec="${s.id}"]`, root); if (el) el.scrollIntoView({ block: 'start' }); }, 0); } }, icon(s.icon)));
      return;
    }
    const search = h('input', { type: 'search', class: 'br-search', placeholder: 'Search devices', 'aria-label': 'Search devices', value: query,
      oninput: (e) => { query = e.target.value.trim().toLowerCase(); renderList(); } });
    root.append(h('div', { class: 'br-head' },
      h('span', { class: 'br-title' }, 'Browser'),
      h('button', { class: 'br-toggle', title: 'Hide the browser (B)', 'aria-label': 'Hide browser', 'aria-expanded': 'true', onclick: () => setOpen(false) }, icon('chevLeft'))),
      h('label', { class: 'br-search-wrap' }, icon('search'), search));
    const list = h('div', { class: 'br-list', role: 'listbox', 'aria-label': 'Devices' });
    root.append(list, h('div', { class: 'br-foot' }, 'Drag onto a track, or double-click to add.'));
    function renderList() {
      list.innerHTML = '';
      for (const s of secs) {
        const items = s.items.filter(match);
        if (query && !items.length && !s.note) continue;
        const open = query ? true : !closedSecs.has(s.id);
        const sec = h('section', { class: 'br-sec' + (open ? ' open' : ''), 'data-sec': s.id, style: { '--ic': s.color } });
        sec.append(h('button', { class: 'br-sec-head', 'aria-expanded': String(open), onclick: () => toggleSec(s.id) },
          icon(open ? 'chevDown' : 'chevRight', 'br-chev'), icon(s.icon, 'br-sec-ico'), h('span', { class: 'br-sec-label' }, s.label), h('span', { class: 'br-count' }, String(s.items.length))));
        if (open) {
          if (s.note) sec.append(h('div', { class: 'br-note' + (s.noteKind ? ' ' + s.noteKind : '') }, s.noteIcon ? icon(s.noteIcon) : null, h('span', {}, s.note)));
          if (s.actions) sec.append(h('div', { class: 'br-actions' }, s.actions.map((a) => h('button', { class: 'small', title: a.title || a.label, onclick: a.run, disabled: !!a.disabled }, a.icon ? icon(a.icon) : null, a.label))));
          const ul = h('ul', { class: 'br-items' }); items.forEach((it) => ul.append(itemRow(it, s))); sec.append(ul);
        }
        list.append(sec);
      }
      if (!list.children.length) list.append(h('div', { class: 'br-empty' }, 'Nothing matches “' + query + '”.'));
    }
    renderList();
  }

  // --- drop targets (tracks in session/arrangement, device panel, empty space = new track)
  function clearTargets() { $$('.dev-drop').forEach((x) => x.classList.remove('dev-drop')); }
  const hasDev = (e) => [...(e.dataTransfer?.types || [])].includes(DEVICE_MIME);
  document.addEventListener('dragover', (e) => {
    if (!hasDev(e)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
    clearTargets(); const t = api.resolveTarget(e.clientX, e.clientY); if (t && t.el) t.el.classList.add('dev-drop');
  }, true);
  document.addEventListener('drop', (e) => {
    if (!hasDev(e)) return;
    e.preventDefault(); e.stopPropagation(); clearTargets(); document.body.classList.remove('dev-dragging');
    let it; try { it = JSON.parse(e.dataTransfer.getData(DEVICE_MIME)); } catch (err) { return; }
    if (!it || typeof it !== 'object') return;
    if (root.contains(e.target)) return; // dropped back on the browser
    // a sample dropped on a drum pad goes to that pad
    const pad = it.kind === 'sample' && e.target.closest && e.target.closest('.dr-pad[data-note]');
    if (pad) { const rk = pad.closest('.dr-rack'); api.onAdd({ ...it, padNote: +pad.dataset.note }, rk ? rk.dataset.tid : null); return; }
    const t = api.resolveTarget(e.clientX, e.clientY);
    api.onAdd(it, t ? t.trackId : 'new');
  }, true);

  render();
  return { render, setOpen, toggle: () => setOpen(!isOpen()), get open() { return isOpen(); } };
}
