// Lyrics track (Phase 2): pure helpers over the `lyrics` part of a per-video record.
//
// lyrics = {
//   offset,                                    // seconds added to every line time when displaying
//   display: { visible, position: 'bottom'|'top', size, showNext, hideYouTubeCaptions },
//   lines: [{ id, t, end, text, marks: [{ id, from, to, typeId, symbol, note }], ink: [stroke], memo }],
// }
// Line `t` is stored WITHOUT the offset (offset is a global shift applied at display time).
// Mark `from`/`to` are inclusive character indexes (Array.from(text), so surrogate pairs count once).
// Ink points are 0..1 of the rendered line box, so they stay on the same characters at any size.

import { newId, normalizeStroke } from './ids.js';
import { looksLikeLrc, parseLrc } from './captions.js';
import { alignLines, remapMarks, lineKey } from './align.js';

export const LAST_LINE_HOLD = 8;
// Handwriting area around a lyric line box, as fractions of the box width (x) / height (top,
// bottom). Line ink is normalised to this enlarged frame, so it scales with the line and there is
// room to write above and below the text.
export const INK_PAD = { x: 0.1, top: 1.2, bottom: 0.8 };
export const INK_FRAME_VERSION = 2;
export const LYRIC_INK_MAX_WIDTH = 0.2; // stroke width limit, relative to the line frame

// v1 line ink was normalised to the bare line box; convert it into the enlarged frame.
export function inkBoxToFrame(stroke) {
  const fw = 1 + 2 * INK_PAD.x;
  const fh = 1 + INK_PAD.top + INK_PAD.bottom;
  return {
    ...stroke,
    width: stroke.width / fh,
    points: stroke.points.map(([x, y]) => [(x + INK_PAD.x) / fw, (y + INK_PAD.top) / fh]),
  };
}

// Frame rect (same coordinate space as `box`) for a line box rect.
export function inkFrameRect(box) {
  return {
    left: box.left - box.width * INK_PAD.x,
    top: box.top - box.height * INK_PAD.top,
    width: box.width * (1 + 2 * INK_PAD.x),
    height: box.height * (1 + INK_PAD.top + INK_PAD.bottom),
  };
} // seconds the last timed line stays when it has no end
export const MIN_SIZE = 0.6;
export const MAX_SIZE = 2.0;

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const round1 = (v) => Math.round(v * 10) / 10;
const round2 = (v) => Math.round(v * 100) / 100;

export function chars(text) {
  return Array.from(text || '');
}

export function emptyLyrics() {
  return {
    offset: 0,
    display: { visible: true, position: 'bottom', size: 1, showNext: true, hideYouTubeCaptions: true },
    region: null, // where burned-in lyrics appear in the picture (0..1), for automatic timing
    lines: [],
  };
}

function normalizeRegion(r) {
  if (!r || typeof r !== 'object') return null;
  const c = (v) => Math.min(1, Math.max(0, Number(v) || 0));
  const x = c(r.x), y = c(r.y), w = Math.min(c(r.w), 1 - x), h = Math.min(c(r.h), 1 - y);
  return w > 0.02 && h > 0.02 ? { x, y, w, h } : null;
}

export function setRegion(lyrics, region) {
  return { ...lyrics, region: normalizeRegion(region) };
}

// Apply absolute media times to lines (null = leave the line's time unchanged).
export function applyTimes(lyrics, times) {
  return {
    ...lyrics,
    lines: lyrics.lines.map((l, i) => (times[i] == null ? l : { ...l, t: round2(Math.max(0, times[i] - lyrics.offset)), end: null })),
  };
}

function normalizeMark(m, len) {
  if (!m || len === 0) return null;
  let from = Math.trunc(num(m.from, -1));
  let to = Math.trunc(num(m.to, from));
  if (from < 0 || from >= len) return null;
  if (to < from) [from, to] = [to, from];
  to = Math.min(len - 1, Math.max(from, to));
  const symbol = str(m.symbol, 4);
  if (!symbol && !m.typeId) return null;
  const placement = m.placement === 'before' ? 'before' : 'ruby';
  // An inserted mark sits before one character: the range collapses to its start.
  if (placement === 'before') to = from;
  return { id: str(m.id, 40) || newId(), from, to, typeId: str(m.typeId, 40), symbol, placement, note: str(m.note, 200) };
}

function normalizeLine(l) {
  if (!l || typeof l.text !== 'string') return null;
  const text = l.text.replace(/[\r\n]+/g, ' ').slice(0, 300);
  if (!text.trim()) return null;
  const len = chars(text).length;
  const t = l.t == null || !Number.isFinite(Number(l.t)) ? null : Math.max(0, Number(l.t));
  const end = l.end == null || !Number.isFinite(Number(l.end)) ? null : Math.max(0, Number(l.end));
  return {
    id: str(l.id, 40) || newId(),
    t,
    end,
    text,
    marks: (Array.isArray(l.marks) ? l.marks : []).map((m) => normalizeMark(m, len)).filter(Boolean)
      .sort((a, b) => a.from - b.from || a.to - b.to),
    ink: (Array.isArray(l.ink) ? l.ink : []).map((s) => normalizeStroke(s, LYRIC_INK_MAX_WIDTH)).filter(Boolean)
      .map((s) => (l.inkFrame === INK_FRAME_VERSION ? s : inkBoxToFrame(s))),
    inkFrame: INK_FRAME_VERSION,
    memo: str(l.memo, 300),
  };
}

export function normalizeLyrics(raw) {
  const d = emptyLyrics();
  if (!raw || typeof raw !== 'object') return d;
  d.offset = Math.max(-30, Math.min(30, round2(num(raw.offset, 0))));
  const disp = raw.display || {};
  d.display = {
    visible: disp.visible !== false,
    position: disp.position === 'top' ? 'top' : 'bottom',
    size: Math.max(MIN_SIZE, Math.min(MAX_SIZE, round1(num(disp.size, 1)))),
    showNext: disp.showNext !== false,
    hideYouTubeCaptions: disp.hideYouTubeCaptions !== false,
  };
  d.region = normalizeRegion(raw.region);
  d.lines = (Array.isArray(raw.lines) ? raw.lines : []).map(normalizeLine).filter(Boolean);
  return d;
}

// ---- text import ----
export function parseLyricsText(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean).slice(0, 500);
}

// Replace the lines with pasted text, keeping timing / marks / ink of lines whose text is
// unchanged (matched in order, so repeated choruses keep their own data).
export function applyLyricsText(lyrics, text) {
  // Pasted LRC ([mm:ss.xx]text) brings its own timing.
  if (looksLikeLrc(text)) {
    const timed = parseLrc(text);
    if (timed.length) return setTimedLines(lyrics, timed);
  }
  const next = parseLyricsText(text);
  const map = alignLines(lyrics.lines.map((l) => l.text), next);
  const lines = next.map((lineText, i) => (map[i] >= 0
    ? carryOver(lyrics.lines[map[i]], lineText, {})
    : normalizeLine({ text: lineText }))).filter(Boolean);
  return { ...lyrics, lines };
}

// Merge two consecutive lines into one virtual line (marks of the second shifted by the length of
// the first; ink/id of the first; memos joined).
function joinLines(a, b) {
  const shift = chars(a.text).length;
  return {
    ...a,
    text: a.text + b.text,
    marks: [...a.marks, ...b.marks.map((m) => ({ ...m, from: m.from + shift, to: m.to + shift }))],
    memo: [a.memo, b.memo].filter(Boolean).join(' / '),
  };
}

// Split one line's marks between two new lines by character position (texts must add up,
// ignoring spacing/punctuation). The first part keeps id / ink / memo.
function splitLine(o, textA, textB) {
  const combined = textA + textB;
  const moved = remapMarks(o.marks, o.text, combined);
  const lenA = chars(textA).length;
  return [
    { ...o, text: combined, marks: moved.filter((m) => m.from < lenA).map((m) => ({ ...m, to: Math.min(m.to, lenA - 1) })) },
    { ...o, id: newId(), ink: [], memo: '', text: combined,
      marks: moved.filter((m) => m.from >= lenA).map((m) => ({ ...m, from: m.from - lenA, to: m.to - lenA })) },
  ].map((x, idx) => ({ ...x, text: idx === 0 ? textA : textB }));
}

// Keep id / marks / ink / memo (and timing unless overridden) of an old line for new text.
function carryOver(old, text, patch) {
  if (old.text === text) return { ...old, ...patch };
  return normalizeLine({ ...old, ...patch, text, marks: remapMarks(old.marks, old.text, text), inkFrame: old.inkFrame }) || { ...old, ...patch };
}

// Replace all lines with imported timed lines (captions / LRC). The global offset is reset
// because imported times are already absolute media times.
// Marks / ink / memo of corresponding existing lines are kept (see align.js: tolerant to
// spacing / punctuation / width differences and small text changes).
export function setTimedLines(lyrics, timed) {
  const fresh = timed.slice(0, 500).map((l) => normalizeLine({ text: l.text, t: l.t, end: l.end })).filter(Boolean);
  const oldLines = lyrics.lines;
  const map = alignLines(oldLines.map((l) => l.text), fresh.map((l) => l.text));
  const used = new Set(map.filter((x) => x >= 0));
  const lines = [];
  for (let i = 0; i < fresh.length; i++) {
    const f = fresh[i];
    const k = lineKey(f.text);
    const exact = map[i] >= 0 && lineKey(oldLines[map[i]].text) === k;
    // A fuzzy match may really be a merge/split: those exact explanations win.
    if (map[i] >= 0 && !exact) {
      const j = map[i];
      const nextOld = oldLines[j + 1];
      if (nextOld && !used.has(j + 1) && lineKey(oldLines[j].text) + lineKey(nextOld.text) === k) {
        used.add(j + 1);
        lines.push(carryOver(joinLines(oldLines[j], nextOld), f.text, { t: f.t, end: f.end }));
        continue;
      }
      const g = fresh[i + 1];
      if (g && map[i + 1] < 0 && lineKey(oldLines[j].text) === k + lineKey(g.text)) {
        const [a, b] = splitLine(oldLines[j], f.text, g.text);
        lines.push(carryOver(a, f.text, { t: f.t, end: f.end }), carryOver(b, g.text, { t: g.t, end: g.end }));
        i++;
        continue;
      }
    }
    if (map[i] >= 0) { lines.push(carryOver(oldLines[map[i]], f.text, { t: f.t, end: f.end })); continue; }
    // Two old lines shown as one caption line ("A" + "B" -> "A B").
    let merged = null;
    for (let j = 0; j + 1 < oldLines.length && !merged; j++) {
      if (used.has(j) || used.has(j + 1)) continue;
      if (lineKey(oldLines[j].text) + lineKey(oldLines[j + 1].text) === k && k) {
        used.add(j); used.add(j + 1);
        merged = carryOver(joinLines(oldLines[j], oldLines[j + 1]), f.text, { t: f.t, end: f.end });
      }
    }
    if (merged) { lines.push(merged); continue; }
    // One old line split into two caption lines ("A B" -> "A", "B").
    const g = fresh[i + 1];
    if (g && map[i + 1] < 0) {
      const k2 = k + lineKey(g.text);
      const j = oldLines.findIndex((o, idx) => !used.has(idx) && k2 && lineKey(o.text) === k2);
      if (j >= 0) {
        used.add(j);
        const [a, b] = splitLine(oldLines[j], f.text, g.text);
        lines.push(carryOver(a, f.text, { t: f.t, end: f.end }), carryOver(b, g.text, { t: g.t, end: g.end }));
        i++;
        continue;
      }
    }
    lines.push(f);
  }
  return { ...lyrics, offset: 0, lines };
}

export function lyricsText(lyrics) {
  return lyrics.lines.map((l) => l.text).join('\n');
}

// ---- timing ----
const mapLine = (lyrics, id, fn) => ({ ...lyrics, lines: lyrics.lines.map((l) => (l.id === id ? fn(l) : l)) });

export function setLineTime(lyrics, id, mediaTime) {
  return mapLine(lyrics, id, (l) => ({ ...l, t: mediaTime == null ? null : round2(Math.max(0, mediaTime - lyrics.offset)) }));
}

export function nudgeLineTime(lyrics, id, delta) {
  return mapLine(lyrics, id, (l) => (l.t == null ? l : { ...l, t: round2(Math.max(0, l.t + delta)) }));
}

// Tap sync: stamp line at `index` with the current media time.
export function tapLine(lyrics, index, mediaTime) {
  const l = lyrics.lines[index];
  return l ? setLineTime(lyrics, l.id, mediaTime) : lyrics;
}

export function setOffset(lyrics, offset) {
  return { ...lyrics, offset: Math.max(-30, Math.min(30, round2(num(offset, 0)))) };
}

export function setDisplay(lyrics, patch) {
  return normalizeLyrics({ ...lyrics, display: { ...lyrics.display, ...patch } });
}

export function setLineMemo(lyrics, id, memo) {
  return mapLine(lyrics, id, (l) => ({ ...l, memo: str(memo, 300) }));
}

export function setLineInk(lyrics, id, strokes) {
  return mapLine(lyrics, id, (l) => ({
    ...l, inkFrame: INK_FRAME_VERSION, ink: (strokes || []).map((s) => normalizeStroke(s, LYRIC_INK_MAX_WIDTH)).filter(Boolean),
  }));
}

// ---- marks ----
export function addMark(lyrics, lineId, { from, to, typeId, symbol, placement = 'ruby', note = '' }) {
  let added = null;
  const next = mapLine(lyrics, lineId, (l) => {
    const m = normalizeMark({ from, to, typeId, symbol, placement, note }, chars(l.text).length);
    if (!m) return l;
    added = m;
    return { ...l, marks: [...l.marks, m].sort((a, b) => a.from - b.from || a.to - b.to) };
  });
  return { lyrics: next, mark: added };
}

export function updateMark(lyrics, lineId, markId, patch) {
  return mapLine(lyrics, lineId, (l) => ({
    ...l,
    marks: l.marks.map((m) => (m.id === markId ? (normalizeMark({ ...m, ...patch }, chars(l.text).length) || m) : m)),
  }));
}

export function removeMark(lyrics, lineId, markId) {
  return mapLine(lyrics, lineId, (l) => ({ ...l, marks: l.marks.filter((m) => m.id !== markId) }));
}

// How a mark is shown: live definition if the type still exists, otherwise the snapshot taken
// when the mark was added. Placement follows the live definition too (a type switched to
// 'before' shows its existing marks before their first character).
export function markSymbol(mark, markTypes) {
  const def = markTypes.find((m) => m.id === mark.typeId);
  return def
    ? { symbol: def.symbol, color: def.color, name: def.name, placement: def.placement || 'ruby' }
    : { symbol: mark.symbol, color: '#cccccc', name: '', placement: mark.placement || 'ruby' };
}

// Split a line into render tokens: inserted symbols ('before' marks) and characters.
// Returns [{ kind: 'ins', mark, sym } | { kind: 'ch', i, c }].
export function lineTokens(line, markTypes) {
  const before = new Map();
  for (const m of line.marks) {
    const sym = markSymbol(m, markTypes);
    if (sym.placement !== 'before') continue;
    before.set(m.from, [...(before.get(m.from) || []), { mark: m, sym }]);
  }
  const out = [];
  chars(line.text).forEach((c, i) => {
    for (const b of before.get(i) || []) out.push({ kind: 'ins', ...b });
    out.push({ kind: 'ch', i, c });
  });
  return out;
}

// ---- lookup ----
// End of line i (media time without offset): explicit end, else next later timed line, else hold.
export function lineEnd(lyrics, i) {
  const l = lyrics.lines[i];
  if (!l || l.t == null) return null;
  if (l.end != null && l.end > l.t) return l.end;
  let next = Infinity;
  for (const o of lyrics.lines) if (o.t != null && o.t > l.t && o.t < next) next = o.t;
  return Number.isFinite(next) ? next : l.t + LAST_LINE_HOLD;
}

// Index of the line to show at media time t (offset applied), or -1.
export function currentLineIndex(lyrics, t) {
  const tt = t - lyrics.offset;
  let best = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    const l = lyrics.lines[i];
    if (l.t != null && l.t <= tt && (best < 0 || l.t >= lyrics.lines[best].t)) best = i;
  }
  if (best < 0) return -1;
  return tt < lineEnd(lyrics, best) ? best : -1;
}

// The upcoming line (for "次の行"): the first timed line starting after t, else the next line in order.
export function upcomingLineIndex(lyrics, t, current) {
  const tt = t - lyrics.offset;
  let best = -1;
  for (let i = 0; i < lyrics.lines.length; i++) {
    const l = lyrics.lines[i];
    if (l.t != null && l.t > tt && (best < 0 || l.t < lyrics.lines[best].t)) best = i;
  }
  if (best >= 0) return best;
  return current >= 0 && current + 1 < lyrics.lines.length ? current + 1 : -1;
}

// A/B range (media time, offset applied) covering lines [i..j] in list order.
export function linesRange(lyrics, i, j) {
  const [from, to] = i <= j ? [i, j] : [j, i];
  const a = lyrics.lines[from]?.t;
  const b = lineEnd(lyrics, to);
  if (a == null || b == null || b <= a) return null;
  return { a: round1(a + lyrics.offset), b: round1(b + lyrics.offset) };
}
