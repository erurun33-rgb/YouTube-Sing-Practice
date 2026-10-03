// Timed lyrics import/export (Phase 2 follow-ups): YouTube caption tracks, LRC files and the
// "record captions while playing" fallback. Pure functions only (unit tested in Node).
//
// All parsers return timed lines: [{ t, end, text }] with times in seconds (media time).

const round2 = (v) => Math.round(v * 100) / 100;

// Strip caption noise that is not lyrics: music notes, [音楽] / [Music] / (拍手) style tags.
export function cleanCaptionText(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[♪♫♬♩]/g, ' ')
    .replace(/^[\s]*[[(（［【]\s*(音楽|music|拍手|applause|笑|laughter|歓声)\s*[\])）］】][\s]*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function finish(lines) {
  const out = [];
  for (const l of lines) {
    const text = cleanCaptionText(l.text);
    if (!text) continue;
    const prev = out[out.length - 1];
    // YouTube often repeats the same text across consecutive events: merge them.
    if (prev && prev.text === text && l.t != null && prev.t != null && Math.abs(l.t - (prev.end ?? prev.t)) < 0.6) {
      prev.end = l.end ?? prev.end;
      continue;
    }
    out.push({ t: l.t == null ? null : round2(l.t), end: l.end != null ? round2(l.end) : null, text: text.slice(0, 300) });
  }
  return out;
}

// YouTube timedtext "json3": { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
export function parseJson3(body) {
  let j = body;
  if (typeof body === 'string') {
    try { j = JSON.parse(body); } catch { return []; }
  }
  if (!j || !Array.isArray(j.events)) return [];
  const lines = [];
  for (const ev of j.events) {
    if (!Array.isArray(ev.segs) || !Number.isFinite(ev.tStartMs)) continue;
    const text = ev.segs.map((s) => s.utf8 || '').join('');
    if (!text.trim() || text === '\n') continue;
    const t = ev.tStartMs / 1000;
    const end = Number.isFinite(ev.dDurationMs) ? t + ev.dDurationMs / 1000 : null;
    lines.push({ t, end, text });
  }
  return finish(lines);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// YouTube timedtext XML: srv3 (<p t="ms" d="ms"><s>..</s></p>) or legacy (<text start="s" dur="s">).
export function parseTimedTextXml(xml) {
  const src = String(xml || '');
  const lines = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(src))) {
    const t = Number((m[1].match(/\bt="(\d+)"/) || [])[1]);
    const d = Number((m[1].match(/\bd="(\d+)"/) || [])[1]);
    if (!Number.isFinite(t)) continue;
    const text = decodeEntities(m[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ''));
    lines.push({ t: t / 1000, end: Number.isFinite(d) ? (t + d) / 1000 : null, text });
  }
  if (!lines.length) {
    const tRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    while ((m = tRe.exec(src))) {
      const t = Number((m[1].match(/\bstart="([\d.]+)"/) || [])[1]);
      const d = Number((m[1].match(/\bdur="([\d.]+)"/) || [])[1]);
      if (!Number.isFinite(t)) continue;
      lines.push({ t, end: Number.isFinite(d) ? t + d : null, text: decodeEntities(m[2].replace(/<[^>]+>/g, '')) });
    }
  }
  return finish(lines);
}

export function parseTimedText(body) {
  const s = typeof body === 'string' ? body.trim() : body;
  if (s && typeof s === 'object') return parseJson3(s);
  if (!s) return [];
  return s[0] === '{' ? parseJson3(s) : parseTimedTextXml(s);
}

// ---- LRC ----
export function looksLikeLrc(text) {
  return /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/m.test(String(text || ''));
}

function lrcSeconds(mm, ss, frac) {
  const f = frac ? Number(frac) / 10 ** frac.length : 0;
  return Number(mm) * 60 + Number(ss) + f;
}

// Supports multiple time tags per line, [offset:+/-ms], metadata tags and enhanced
// word timings (<mm:ss.xx>, stripped). Untimed text lines (e.g. lines not tap-synced yet,
// exported by toLrc) are kept with t = null, right after the timed line they follow in the file.
export function parseLrc(text) {
  let offset = 0;
  const entries = []; // { key, seq, t, text }
  let anchor = -Infinity; // sort key of untimed lines: time of the previous timed line
  let seq = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const times = [];
    let m;
    let rest = raw;
    while ((m = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(rest))) {
      times.push(lrcSeconds(m[1], m[2], m[3]));
      rest = rest.slice(m[0].length);
    }
    const body = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim();
    if (!times.length) {
      // Metadata tags ([ti:], [ar:] ...) and blank lines are not lyrics.
      if (body && !/^\[[a-z#]+:[^\]]*\]$/i.test(body)) entries.push({ key: anchor, seq: seq++, t: null, text: body });
      continue;
    }
    if (!body) continue;
    const ts = times.map((t) => Math.max(0, t + offset));
    for (const t of ts) entries.push({ key: t, seq: seq++, t, text: body });
    anchor = ts[0];
  }
  entries.sort((a, b) => a.key - b.key || a.seq - b.seq);
  return finish(entries.map(({ t, text: body }) => ({ t, end: null, text: body })));
}

function lrcTime(t) {
  const cs = Math.round(Math.max(0, t) * 100);
  const m = Math.floor(cs / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `[${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}]`;
}

// Export: timed lines with the global offset applied; untimed lines as plain text.
export function toLrc(lyrics, { title = '' } = {}) {
  const head = title ? [`[ti:${title.replace(/[\[\]]/g, '')}]`] : [];
  const body = lyrics.lines.map((l) => (l.t == null ? l.text : `${lrcTime(l.t + lyrics.offset)}${l.text}`));
  return [...head, ...body].join('\n') + '\n';
}

// ---- recording fallback ----
// Feed (media time, caption text currently on screen) samples while the video plays.
// Growing captions (auto-generated, word by word) update the current line instead of
// creating a new one per word.
export function recordSample(state, t, rawText) {
  const text = cleanCaptionText(rawText);
  const lines = state.lines.slice();
  const last = lines[lines.length - 1];
  if (!text) {
    if (last && last.end == null) lines[lines.length - 1] = { ...last, end: round2(t) };
    return { lines, current: '' };
  }
  if (text === state.current) return state;
  if (last && last.end == null && state.current && text.startsWith(state.current)) {
    lines[lines.length - 1] = { ...last, text };
    return { lines, current: text };
  }
  if (last && last.end == null) lines[lines.length - 1] = { ...last, end: round2(t) };
  // Ignore re-showing the line we just recorded (e.g. after a small seek back).
  if (last && last.text === text && Math.abs(t - last.t) < 1) return { lines, current: text };
  lines.push({ t: round2(t), end: null, text });
  return { lines, current: text };
}

export function emptyRecording() {
  return { lines: [], current: '' };
}

export function finishRecording(state) {
  return finish([...state.lines].sort((a, b) => a.t - b.t));
}
