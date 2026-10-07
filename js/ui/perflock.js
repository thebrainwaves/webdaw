// Performance lock + Resolume Arena / TouchDesigner readout.
// The browser cannot send UDP OSC. This panel is the packet the grid would send
// to a local bridge (Arena listens on UDP 7000; TouchDesigner OSC In on UDP 9000).

const MAX_LOG = 8;

export function createPerfLock({ toast, haptic }) {
  let on = false;
  let wake = null;
  let holdTimer = null;
  const log = [];

  function layerIndex(project, trackId) {
    if (!project) return 1;
    let n = 0;
    for (const t of project.tracks) {
      if (t.kind === 'group') continue;
      n += 1;
      if (t.id === trackId) return n;
    }
    return n || 1;
  }

  function pushLog(line) {
    log.unshift(line);
    if (log.length > MAX_LOG) log.length = MAX_LOG;
    render();
  }

  function packets(project, engine) {
    const bpm = project ? project.bpm : 120;
    const pos = engine && engine.position != null ? engine.position : 0;
    const beat = engine && engine.beatDur ? pos / engine.beatDur : 0;
    const bar = Math.floor(beat / 4) + 1;
    const beatInBar = (Math.floor(beat) % 4) + 1;
    return [
      { dest: 'Arena', addr: '/composition/tempocontroller/tempo', val: String(bpm), note: 'Link is the real tempo lock. This is the readout only.' },
      { dest: 'TD', addr: '/auduio/bpm', val: String(bpm), note: 'OSC In CHOP, port 9000' },
      { dest: 'TD', addr: '/auduio/bar', val: String(bar), note: 'bar.beat ' + bar + '.' + beatInBar },
      { dest: 'TD', addr: '/auduio/beat', val: String(beatInBar), note: '1–4' },
    ];
  }

  function render() {
    const root = document.getElementById('rigReadout');
    if (!root) return;
    root.hidden = !on;
    if (!on) return;
    const project = window.__daw && window.__daw.S && window.__daw.S.project;
    const engine = window.__daw && window.__daw.engine;
    const rows = packets(project, engine).map((p) =>
      '<div class="rig-row"><b>' + p.dest + '</b><code>' + p.addr + '</code><span>' + p.val + '</span><i>' + p.note + '</i></div>'
    ).join('');
    const lines = log.length ? log.map((l) => '<li>' + l + '</li>').join('') : '<li>Launch a clip or scene. The packet lands here.</li>';
    root.innerHTML =
      '<header><strong>Arena · TouchDesigner</strong><span>UDP bridge, not a socket</span></header>' +
      '<p class="rig-wire">Arena UDP 7000 · column = scene row · layer = track. TouchDesigner OSC In UDP 9000. Browser cannot send UDP. A local bridge forwards these.</p>' +
      rows +
      '<ol class="rig-log">' + lines + '</ol>';
  }

  async function setOn(next) {
    on = next;
    document.body.classList.toggle('perf-lock', on);
    const btn = document.getElementById('btnPerf');
    if (btn) {
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.textContent = on ? 'Locked' : 'Lock';
    }
    const menu = document.getElementById('menu');
    if (on && menu) menu.classList.remove('open');
    if (on) {
      const sessionBtn = document.querySelector('.views button[data-view="session"]');
      if (sessionBtn && !sessionBtn.classList.contains('on')) sessionBtn.click();
      try { wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; }
      toast('Performance lock: session grid only. Hold Lock to exit.', 2200);
    } else {
      if (wake) { try { await wake.release(); } catch (e) { /* already released */ } wake = null; }
      toast('Performance lock off', 1200);
    }
    haptic(on ? 16 : 8);
    render();
  }

  function bind(btn) {
    if (!btn) return;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (!on) { setOn(true); return; }
      holdTimer = setTimeout(() => { holdTimer = null; setOn(false); }, 700);
    });
    btn.addEventListener('pointerup', () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; if (on) toast('Hold Lock to exit', 900); } });
    btn.addEventListener('pointerleave', () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } });
  }

  return {
    bind,
    isOn: () => on,
    guardView(v) { return on ? 'session' : v; },
    blockMenu() { return on; },
    noteScene(index) {
      if (!on) return;
      const col = index + 1;
      pushLog('Arena /composition/columns/' + col + '/connect 1 · TD /auduio/scene ' + col);
    },
    noteClip(track, slot) {
      if (!on) return;
      const project = window.__daw && window.__daw.S && window.__daw.S.project;
      const layer = layerIndex(project, track.id);
      const clip = slot + 1;
      const name = (track.slots[slot] && track.slots[slot].name) || ('clip ' + clip);
      pushLog('Arena /composition/layers/' + layer + '/clips/' + clip + '/connect 1 · ' + name + ' · TD /auduio/layer/' + layer + ' ' + clip);
    },
    noteStop() {
      if (!on) return;
      pushLog('Arena /composition/disconnectall 1 · TD /auduio/stop 1');
    },
    render,
  };
}
