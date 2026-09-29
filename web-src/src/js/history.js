// Undo/redo via project snapshots. Every mutating UI action calls `history.push(label)` BEFORE it
// changes the project. Audio buffers are immutable and referenced by id, so snapshots stay small.
// Continuous gestures (knob drags, fader moves) are coalesced by key.
export class History {
  constructor(getSnapshot, restore, limit = 150) {
    this.getSnapshot = getSnapshot; this.restore = restore; this.limit = limit;
    this.undoStack = []; this.redoStack = []; this.lastKey = null; this.lastTime = 0; this.listeners = [];
  }
  push(label, coalesceKey = null) {
    const now = Date.now();
    if (coalesceKey && coalesceKey === this.lastKey && now - this.lastTime < 1500) { this.lastTime = now; return; }
    this.undoStack.push({ label, snap: this.getSnapshot() });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = []; this.lastKey = coalesceKey; this.lastTime = now;
    this.changed();
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }
  undo() {
    const e = this.undoStack.pop(); if (!e) return null;
    this.redoStack.push({ label: e.label, snap: this.getSnapshot() });
    this.lastKey = null; this.restore(e.snap); this.changed(); return e.label;
  }
  redo() {
    const e = this.redoStack.pop(); if (!e) return null;
    this.undoStack.push({ label: e.label, snap: this.getSnapshot() });
    this.lastKey = null; this.restore(e.snap); this.changed(); return e.label;
  }
  clear() { this.undoStack = []; this.redoStack = []; this.lastKey = null; this.changed(); }
  onChange(fn) { this.listeners.push(fn); }
  changed() { this.listeners.forEach((f) => f(this)); }
}
