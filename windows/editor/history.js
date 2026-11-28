// Non-destructive Delta / Command-Pattern Undo/Redo Manager (default 50 steps, configurable)
// + Real replayable structured Command Journal persisted to both Host (data/tmp/recovery/) & localStorage
// so Crash/Hang Auto-Downgrade restores 100% of prior operations & Undo history without losing progress!
import { DEFAULT_MAX_HISTORY_STEPS } from "./constants.js";
import { t } from "./i18n.js";

const LOG_STORAGE_KEY = "splat_editor_journal_v3";

/**
 * Compress a sorted or unsorted array of integer indices into compact RLE pairs [[start, count], ...].
 */
export function encodeIndexRanges(indices) {
  if (!indices || indices.length === 0) return [];
  const sorted = Array.from(indices).sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    if (v === prev) continue;
    if (v === prev + 1) {
      prev = v;
    } else {
      ranges.push([start, prev - start + 1]);
      start = prev = v;
    }
  }
  ranges.push([start, prev - start + 1]);
  return ranges;
}

export function decodeIndexRanges(ranges, callback) {
  if (!Array.isArray(ranges)) return;
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length < 2) continue;
    const s = r[0] | 0;
    const e = s + (r[1] | 0);
    for (let i = s; i < e; i++) callback(i);
  }
}

export class HistoryManager {
  constructor(maxSteps = DEFAULT_MAX_HISTORY_STEPS, onChange = null, onPersistCheckpoint = null) {
    this.maxSteps = Math.max(10, Number(maxSteps) || DEFAULT_MAX_HISTORY_STEPS);
    this.undoStack = [];
    this.redoStack = [];
    this.journal = []; // replayable structured command log entries
    this.onChange = onChange;
    this.onPersistCheckpoint = onPersistCheckpoint;
    this.sessionKey = "";
  }

  setSessionKey(key) {
    this.sessionKey = String(key || "");
  }

  setMaxSteps(n) {
    this.maxSteps = Math.max(10, Math.min(300, Number(n) || DEFAULT_MAX_HISTORY_STEPS));
    while (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }
    this._notify();
  }

  push(cmd, execute = false) {
    if (execute && typeof cmd.redo === "function") {
      cmd.redo();
    }
    this.undoStack.push(cmd);
    this.redoStack.length = 0;
    if (this.undoStack.length > this.maxSteps) {
      this.undoStack.shift();
    }
    if (cmd.journalEntry) {
      this.journal.push({ ...cmd.journalEntry, label: cmd.label, ts: Date.now() });
      this.persistJournal();
    }
    this._notify();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    if (typeof cmd.undo === "function") cmd.undo();
    this.redoStack.push(cmd);
    if (cmd.journalEntry && this.journal.length > 0) {
      this.journal.pop();
      this.persistJournal();
    }
    this._notify();
    return cmd;
  }

  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    if (typeof cmd.redo === "function") cmd.redo();
    this.undoStack.push(cmd);
    if (cmd.journalEntry) {
      this.journal.push({ ...cmd.journalEntry, label: cmd.label, ts: Date.now() });
      this.persistJournal();
    }
    this._notify();
    return cmd;
  }

  /**
   * Non-destructive timeline snapshot (0 = initial state, 1..undoCount = applied, >undoCount = redoable future).
   */
  getTimeline() {
    const entries = [{
      index: 0,
      label: t("editor.history.initialState"),
      state: this.undoStack.length === 0 ? "current" : "done",
      groupKey: null,
      groupLabel: null,
    }];
    for (let i = 0; i < this.undoStack.length; i++) {
      const stepIdx = i + 1;
      const cmd = this.undoStack[i];
      entries.push({
        index: stepIdx,
        label: cmd.label || t("editor.history.stepFallback", { step: stepIdx }),
        state: stepIdx === this.undoStack.length ? "current" : "done",
        groupKey: cmd.groupKey || null,
        groupLabel: cmd.groupLabel || null,
      });
    }
    // redoStack top (end of array) is the next immediate redo step
    for (let r = this.redoStack.length - 1; r >= 0; r--) {
      const stepIdx = this.undoStack.length + (this.redoStack.length - r);
      const cmd = this.redoStack[r];
      entries.push({
        index: stepIdx,
        label: cmd.label || t("editor.history.stepFallback", { step: stepIdx }),
        state: "redo",
        groupKey: cmd.groupKey || null,
        groupLabel: cmd.groupLabel || null,
      });
    }
    return {
      currentIndex: this.undoStack.length,
      totalSteps: this.undoStack.length + this.redoStack.length,
      entries,
    };
  }

  /**
   * Jump directly to any timeline step without discarding later redo steps!
   * Later steps are ONLY overwritten if a new edit is pushed while at an earlier step.
   */
  jumpTo(targetIndex) {
    const total = this.undoStack.length + this.redoStack.length;
    const clamped = Math.max(0, Math.min(total, targetIndex | 0));
    if (clamped === this.undoStack.length) return false;
    let moved = false;
    while (this.undoStack.length > clamped) {
      const cmd = this.undoStack.pop();
      if (!cmd) break;
      if (typeof cmd.undo === "function") cmd.undo();
      this.redoStack.push(cmd);
      if (cmd.journalEntry && this.journal.length > 0) this.journal.pop();
      moved = true;
    }
    while (this.undoStack.length < clamped) {
      const cmd = this.redoStack.pop();
      if (!cmd) break;
      if (typeof cmd.redo === "function") cmd.redo();
      this.undoStack.push(cmd);
      if (cmd.journalEntry) this.journal.push({ ...cmd.journalEntry, label: cmd.label, ts: Date.now() });
      moved = true;
    }
    if (moved) {
      this.persistJournal();
      this._notify();
    }
    return moved;
  }

  clear() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.journal.length = 0;
    this.clearPersistedJournal();
    this._notify();
  }

  exportJournalPayload() {
    return {
      version: 3,
      sessionKey: this.sessionKey,
      maxSteps: this.maxSteps,
      savedAt: Date.now(),
      entries: this.journal.slice(-this.maxSteps),
    };
  }

  persistJournal() {
    if (!this.sessionKey) return;
    const payload = this.exportJournalPayload();
    try {
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota cleanly
    }
    if (typeof this.onPersistCheckpoint === "function") {
      try {
        this.onPersistCheckpoint(payload);
      } catch {
        // Ignore IPC errors
      }
    }
  }

  static loadPersistedJournal(sessionKey) {
    try {
      const raw = localStorage.getItem(LOG_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.sessionKey === sessionKey && Array.isArray(parsed.entries)) {
        return parsed;
      }
    } catch {
      // Ignore corrupt cache
    }
    return null;
  }

  clearPersistedJournal() {
    try {
      localStorage.removeItem(LOG_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  _notify() {
    if (typeof this.onChange === "function") {
      this.onChange({
        undoCount: this.undoStack.length,
        redoCount: this.redoStack.length,
        lastLabel: this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : "",
        nextRedoLabel: this.redoStack.length ? this.redoStack[this.redoStack.length - 1].label : "",
      });
    }
  }
}

export function diffUint8Arrays(before, after) {
  const idx = [];
  const prev = [];
  const next = [];
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i++) {
    if (before[i] !== after[i]) {
      idx.push(i);
      prev.push(before[i]);
      next.push(after[i]);
    }
  }
  return {
    indices: new Uint32Array(idx),
    before: new Uint8Array(prev),
    after: new Uint8Array(next),
    changed: idx.length,
  };
}

export function applyUint8Delta(target, delta, forward) {
  const src = forward ? delta.after : delta.before;
  const idx = delta.indices;
  for (let i = 0; i < idx.length; i++) {
    if (idx[i] < target.length) target[idx[i]] = src[i];
  }
}
