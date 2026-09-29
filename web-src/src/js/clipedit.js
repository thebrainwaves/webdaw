// Clip cutting (arrangement): split at a time, split at the loop edges, delete a section (optionally closing
// the gap). Pure functions on a track's arrangement array so they can be unit tested; the caller wraps them in
// one undo step and reschedules playback. Works the same for audio and MIDI clips: a clip is a window
// (start, duration) onto its source, `offset` is where that window starts in the source (seconds of source
// audio, scaled by the clip's playback rate; MIDI clips use rate 1, so offset is in seconds of beat time).
const EPS = 1e-6;
const clone = (c) => JSON.parse(JSON.stringify(c));
export const defaultRate = (c) => (c.type === 'midi' ? 1 : Math.pow(2, (c.transpose || 0) / 12));

// Split clip c (in list) at time p. Returns the new right-hand clip, or null when p is not inside c.
export function splitClip(list, c, p, newId, rate = defaultRate) {
  if (!(p > c.start + EPS && p < c.start + c.duration - EPS)) return null;
  const cut = p - c.start;
  const right = { ...clone(c), id: newId(), start: p, offset: (c.offset || 0) + cut * rate(c), duration: c.duration - cut };
  if (right.takes) right.takes = clone(c.takes);
  c.duration = cut; list.push(right);
  return right;
}
// Split every clip that spans time p. Returns the new right-hand clips.
export function splitAllAt(list, p, newId, rate = defaultRate) {
  const out = [];
  for (const c of [...list]) { const r = splitClip(list, c, p, newId, rate); if (r) out.push(r); }
  return out;
}
// Split at both loop edges (a, b). Returns how many cuts were made.
export function splitAtRange(list, a, b, newId, rate = defaultRate) {
  return splitAllAt(list, a, newId, rate).length + splitAllAt(list, b, newId, rate).length;
}
// Remove the time section [a, b) from the clips in list (trims, splits or removes clips).
// ripple=true closes the gap: everything after b moves left by (b - a). Returns the new list.
export function deleteSection(list, a, b, newId, { ripple = false } = {}, rate = defaultRate) {
  if (!(b > a + EPS)) return list;
  const out = [];
  for (const o of list) {
    const oa = o.start, ob = o.start + o.duration;
    if (ob <= a + EPS) { out.push(o); continue; }                          // before
    if (oa >= b - EPS) { if (ripple) o.start -= b - a; out.push(o); continue; } // after
    if (oa >= a - EPS && ob <= b + EPS) continue;                            // inside: removed
    if (oa < a && ob > b) {                                                  // spans: keep both ends
      const right = { ...clone(o), id: newId(), start: ripple ? a : b, offset: (o.offset || 0) + (b - oa) * rate(o), duration: ob - b };
      o.duration = a - oa; out.push(o, right); continue;
    }
    if (oa < a) { o.duration = a - oa; out.push(o); continue; }             // tail inside: shorten
    const cut = b - oa; o.offset = (o.offset || 0) + cut * rate(o); o.duration -= cut; o.start = ripple ? a : b; out.push(o); // head inside
  }
  return out;
}
