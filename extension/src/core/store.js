// Per-video practice data (Phase 1). Pure state helpers + a chrome.storage.local adapter.
//
// Schema v1, one record per videoId under key `ysp:v1:video:<videoId>`:
// {
//   schema: 1, videoId, title, updatedAt,
//   pitchSemitones: number,
//   loops: [{ id, a, b, enabled }],                       // Phase 1 uses loops[0] as the active range
//   checkpoints: [{ id, t, label, note, createdAt }],     // "要確認ポイント", kept sorted by t
//   annotations: [                                         // coordinates are 0..1 of the video content rect
//     { id, type: 'text', at, from, to, x, y, text, color },
//     { id, type: 'ink',  at, from, to, strokes: [{ tool, color, width, points: [[x, y], ...] }] },
//   ],
// }
// All helpers return new objects (no mutation) so they are trivially unit-testable.

import { clampSemitones } from '../dsp/pitch-shifter.js';
import { newId, normalizeStroke } from './ids.js';
import { emptyLyrics, normalizeLyrics } from './lyrics.js';
import { isContextInvalidated } from './runtime.js';

export { newId };
export const SCHEMA_VERSION = 2; // v2 adds `lyrics` (v1 records load unchanged)
export const KEY_PREFIX = 'ysp:v1:video:';
export const DEFAULT_LEAD = 1.5; // seconds an annotation appears before its time
export const DEFAULT_HOLD = 4; // seconds it stays after its time
export const CHECKPOINT_LABELS = ['ラスサビ入り', '高音', 'ブレス', '歌詞注意', 'リズム注意'];

export function storageKey(videoId) {
  return KEY_PREFIX + videoId;
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp01 = (v) => Math.min(1, Math.max(0, num(v, 0.5)));
const round = (v, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

export function createEmpty(videoId) {
  return {
    schema: SCHEMA_VERSION,
    videoId,
    title: '',
    updatedAt: 0,
    pitchSemitones: 0,
    loops: [],
    checkpoints: [],
    annotations: [],
    lyrics: emptyLyrics(),
  };
}

export function isEmpty(d) {
  return d.pitchSemitones === 0 && d.loops.length === 0 && d.checkpoints.length === 0 && d.annotations.length === 0
    && d.lyrics.lines.length === 0;
}

// Accepts anything read from storage and returns a valid v1 record (drops malformed entries).
export function normalize(raw, videoId) {
  const d = createEmpty(videoId);
  if (!raw || typeof raw !== 'object') return d;
  d.title = str(raw.title, 200);
  d.updatedAt = num(raw.updatedAt, 0);
  d.pitchSemitones = clampSemitones(raw.pitchSemitones);
  if (Array.isArray(raw.loops)) {
    d.loops = raw.loops
      .filter((l) => l && Number.isFinite(l.a) && Number.isFinite(l.b))
      .map((l) => ({ id: str(l.id, 40) || newId(), a: Math.max(0, l.a), b: Math.max(0, l.b), enabled: !!l.enabled }));
  }
  if (Array.isArray(raw.checkpoints)) {
    d.checkpoints = sortByTime(raw.checkpoints
      .filter((c) => c && Number.isFinite(c.t))
      .map((c) => ({
        id: str(c.id, 40) || newId(), t: Math.max(0, c.t), label: str(c.label, 40), note: str(c.note, 500),
        createdAt: num(c.createdAt, 0),
      })), 't');
  }
  if (Array.isArray(raw.annotations)) {
    d.annotations = sortByTime(raw.annotations.map(normalizeAnnotation).filter(Boolean), 'at');
  }
  d.lyrics = normalizeLyrics(raw.lyrics);
  return d;
}

function normalizeAnnotation(a) {
  if (!a || !Number.isFinite(a.at)) return null;
  const base = {
    id: str(a.id, 40) || newId(),
    at: Math.max(0, a.at),
    from: Math.max(0, num(a.from, a.at - DEFAULT_LEAD)),
    to: Math.max(0, num(a.to, a.at + DEFAULT_HOLD)),
  };
  if (base.to < base.from) [base.from, base.to] = [base.to, base.from];
  if (a.type === 'text') {
    const text = str(a.text, 500);
    if (!text) return null;
    return { ...base, type: 'text', x: clamp01(a.x), y: clamp01(a.y), text, color: str(a.color, 20) || '#ffffff' };
  }
  if (a.type === 'ink' && Array.isArray(a.strokes)) {
    const strokes = a.strokes.map((st) => normalizeStroke(st, 0.05)).filter(Boolean);
    if (!strokes.length) return null;
    return { ...base, type: 'ink', strokes };
  }
  return null;
}

function sortByTime(list, key) {
  return [...list].sort((x, y) => x[key] - y[key]);
}

function touch(d) {
  return { ...d, updatedAt: Date.now() };
}

// ---- pitch ----
export function setPitch(d, semitones) {
  return touch({ ...d, pitchSemitones: clampSemitones(semitones) });
}

// ---- loop (Phase 1: a single active range stored as loops[0]) ----
export function setLoop(d, { a, b, enabled }) {
  if (a == null || b == null) return touch({ ...d, loops: [] });
  const prev = d.loops[0];
  return touch({ ...d, loops: [{ id: prev?.id || newId(), a: round(a, 1), b: round(b, 1), enabled: !!enabled }] });
}

// ---- checkpoints ----
export function addCheckpoint(d, t, label = '', note = '') {
  const c = { id: newId(), t: round(Math.max(0, t), 1), label: str(label, 40), note: str(note, 500), createdAt: Date.now() };
  return { data: touch({ ...d, checkpoints: sortByTime([...d.checkpoints, c], 't') }), item: c };
}

export function updateCheckpoint(d, id, patch) {
  const checkpoints = d.checkpoints.map((c) => (c.id === id
    ? { ...c,
      ...(patch.label != null ? { label: str(patch.label, 40) } : {}),
      ...(patch.note != null ? { note: str(patch.note, 500) } : {}),
      ...(patch.t != null && Number.isFinite(patch.t) ? { t: round(Math.max(0, patch.t), 1) } : {}) }
    : c));
  return touch({ ...d, checkpoints: sortByTime(checkpoints, 't') });
}

export function removeCheckpoint(d, id) {
  return touch({ ...d, checkpoints: d.checkpoints.filter((c) => c.id !== id) });
}

// ---- annotations ----
export function addTextAnnotation(d, { at, x, y, text, color, lead = DEFAULT_LEAD, hold = DEFAULT_HOLD }) {
  const a = normalizeAnnotation({ type: 'text', at, from: at - lead, to: at + hold, x, y, text, color });
  if (!a) return { data: d, item: null };
  return { data: touch({ ...d, annotations: sortByTime([...d.annotations, a], 'at') }), item: a };
}

export function addInkAnnotation(d, { at, strokes, lead = DEFAULT_LEAD, hold = DEFAULT_HOLD }) {
  const a = normalizeAnnotation({ type: 'ink', at, from: at - lead, to: at + hold, strokes });
  if (!a) return { data: d, item: null };
  return { data: touch({ ...d, annotations: sortByTime([...d.annotations, a], 'at') }), item: a };
}

export function updateAnnotation(d, id, patch) {
  const annotations = d.annotations.map((a) => {
    if (a.id !== id) return a;
    const merged = { ...a, ...patch };
    // Changing lead/hold is expressed relative to `at`.
    if (patch.lead != null) merged.from = merged.at - Math.max(0, num(patch.lead, DEFAULT_LEAD));
    if (patch.hold != null) merged.to = merged.at + Math.max(0, num(patch.hold, DEFAULT_HOLD));
    delete merged.lead;
    delete merged.hold;
    return normalizeAnnotation(merged) || a;
  });
  return touch({ ...d, annotations: sortByTime(annotations, 'at') });
}

// ---- lyrics (Phase 2): fn receives and returns the lyrics object ----
export function updateLyrics(d, fn) {
  return touch({ ...d, lyrics: fn(d.lyrics) });
}

export function removeAnnotation(d, id) {
  return touch({ ...d, annotations: d.annotations.filter((a) => a.id !== id) });
}

export function visibleAnnotations(annotations, t) {
  return annotations.filter((a) => t >= a.from && t <= a.to);
}

// ---- persistence ----
// Debounced writer around chrome.storage.local (or any {get,set,remove} async area for tests).
export class PracticeStore {
  constructor({ area, logger, debounceMs = 300, onContextLost = null, isInvalidated = isContextInvalidated }) {
    this.area = area;
    this.logger = logger;
    this.debounceMs = debounceMs;
    this.onContextLost = onContextLost;
    this.isInvalidated = isInvalidated;
    this._timer = null;
    this._pending = null;
    // Videos whose stored record could not be read: never overwrite them with a partial record.
    this._unreadable = new Set();
  }

  _failed(what, e) {
    if (this.isInvalidated(e)) {
      this.logger?.warn(`${what}: extension was updated or reloaded; reload this tab`);
      this.onContextLost?.();
    } else {
      this.logger?.error(what, e);
    }
  }

  async load(videoId) {
    const key = storageKey(videoId);
    try {
      const res = await this.area.get(key);
      this._unreadable.delete(videoId);
      return normalize(res ? res[key] : null, videoId);
    } catch (e) {
      this._unreadable.add(videoId);
      this._failed('storage load failed', e);
      return createEmpty(videoId);
    }
  }

  save(data) {
    this._pending = data;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  async flush() {
    clearTimeout(this._timer);
    const d = this._pending;
    this._pending = null;
    if (!d) return;
    if (this._unreadable.has(d.videoId)) {
      this.logger?.warn('not saving: stored data for this video could not be read (kept as is)');
      return;
    }
    const key = storageKey(d.videoId);
    try {
      if (isEmpty(d)) await this.area.remove(key);
      else await this.area.set({ [key]: d });
    } catch (e) {
      this._failed('storage save failed', e);
    }
  }
}
