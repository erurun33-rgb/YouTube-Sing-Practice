// Automatic lyric timing without typing the text (pure functions, unit tested):
//  A) burned-in lyrics: detect when the text inside a video region changes
//  B) captions (incl. poor auto-generated ones): take only their timing and map it onto the
//     user's pasted lyrics by aligning the characters.

import { lineKey } from './align.js';

// ---------------------------------------------------------------- A: frame analysis
// Grayscale of an RGBA buffer.
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return g;
}

// Binary edge map (strong horizontal/vertical gradients = text strokes) and its density.
export function edgeFeatures(gray, w, h, threshold = 40) {
  const bits = new Uint8Array(w * h);
  let on = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      const g = Math.abs(gray[i + 1] - gray[i]) + Math.abs(gray[i + w] - gray[i]);
      if (g > threshold) { bits[i] = 1; on++; }
    }
  }
  return { bits, energy: on / (w * h) };
}

// Fraction of edge pixels that differ, relative to the edges present (0 = same, 1 = unrelated).
export function edgeDistance(a, b) {
  let diff = 0, any = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] || b[i]) { any++; if (a[i] !== b[i]) diff++; }
  }
  return any ? diff / any : 0;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
}

// Incremental version for live sampling: memory stays bounded by the number of distinct
// screens (one edge map per finished run + a thinned current run), and each update is O(runs).
// Push samples as they are taken (~every 0.1s while playing); a seek starts a new run.
export class TextChangeDetector {
  constructor({
    changeThreshold = 0.45, // edge distance that counts as different text
    minStable = 0.35, // seconds a screen must stay to count (skips fades/wipes)
    presentRatio = 0.35, // screen has text if its energy >= ratio * p90(energy)
    maxRunItems = 200, // edge maps kept for the current run (thinned beyond that)
  } = {}) {
    Object.assign(this, { changeThreshold, minStable, presentRatio, maxRunItems });
    this.runs = []; // { start, end, energy, rep }
    this.cur = null; // { start, end, items: [bits], energies: [] }
    this.energies = [];
    this.lastT = null;
    this.count = 0;
  }

  push({ t, bits, energy }) {
    this.count++;
    this.energies.push(energy);
    const jumped = this.lastT != null && (t < this.lastT || t - this.lastT > 1);
    this.lastT = t;
    const c = this.cur;
    if (c && !jumped && edgeDistance(c.items[Math.floor(c.items.length / 2)], bits) <= this.changeThreshold) {
      c.end = t;
      c.energies.push(energy);
      c.items.push(bits);
      if (c.items.length > this.maxRunItems) c.items = c.items.filter((_, i) => i % 2 === 0);
      return;
    }
    this._close();
    this.cur = { start: t, end: t, items: [bits], energies: [energy] };
  }

  _summary(c) {
    return { start: c.start, end: c.end, energy: percentile(c.energies, 0.5), rep: c.items[Math.floor(c.items.length / 2)] };
  }

  _close() {
    if (!this.cur) return;
    const r = this._summary(this.cur);
    // Short runs (fades, wipes) can never be kept: don't retain their edge map.
    if (r.end - r.start >= this.minStable) this.runs.push(r);
    this.cur = null;
  }

  // Start times of distinct text "screens" (a new lyric line appearing).
  times() {
    if (this.count < 2) return [];
    const present = Math.max(0.004, this.presentRatio * percentile(this.energies, 0.9));
    const runs = this.cur ? [...this.runs, this._summary(this.cur)] : [...this.runs];
    runs.sort((a, b) => a.start - b.start);
    const times = [];
    let last = null;
    for (const r of runs) {
      if (r.end - r.start < this.minStable) continue;
      if (r.energy < present) { last = null; continue; }
      if (last && edgeDistance(last, r.rep) <= this.changeThreshold) continue;
      times.push(Math.round(r.start * 100) / 100);
      last = r.rep;
    }
    return times;
  }
}

// samples: [{ t, bits, energy }] in time order (every ~0.1s while playing).
export function detectTextChanges(samples, opts = {}) {
  const d = new TextChangeDetector(opts);
  for (const s of samples) d.push(s);
  return d.times();
}

// ---------------------------------------------------------------- B: caption timing
// Character stream of caption lines with a time for every character (linear inside a line).
function captionStream(captions) {
  const chars = [];
  const times = [];
  for (const c of captions) {
    const k = Array.from(lineKey(c.text));
    const end = c.end != null && c.end > c.t ? c.end : c.t + Math.max(1, k.length * 0.25);
    k.forEach((ch, i) => { chars.push(ch); times.push(c.t + ((end - c.t) * i) / Math.max(1, k.length)); });
  }
  return { chars, times };
}

// For each lyric line text, the time of its first character in the captions (or null).
// Character-level LCS tolerates recognition errors of auto-generated captions.
export function timesFromCaptions(lineTexts, captions, { maxChars = 3000, minMatchRatio = 0.3 } = {}) {
  const cap = captionStream(captions);
  const lyr = [];
  const owner = [];
  lineTexts.forEach((t, li) => { for (const ch of lineKey(t)) { lyr.push(ch); owner.push(li); } });
  const A = lyr.slice(0, maxChars), B = cap.chars.slice(0, maxChars);
  const n = A.length, m = B.length;
  const W = m + 1;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const first = new Array(lineTexts.length).fill(null);
  const matched = new Array(lineTexts.length).fill(0);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (A[i] === B[j]) {
      const li = owner[i];
      if (first[li] == null) first[li] = cap.times[j];
      matched[li]++;
      i++; j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  return lineTexts.map((t, li) => {
    const len = Array.from(lineKey(t)).length;
    if (!len || first[li] == null || matched[li] / len < minMatchRatio) return null;
    return Math.round(first[li] * 100) / 100;
  });
}

// ---------------------------------------------------------------- assignment
// Put detected times onto lines in order, starting at `from`. Returns new lines + count used.
export function assignSequential(lines, times, from = 0) {
  const out = lines.map((l) => ({ ...l }));
  let k = 0;
  for (let i = from; i < out.length && k < times.length; i++, k++) {
    out[i].t = times[k];
    out[i].end = null;
  }
  return { lines: out, assigned: k };
}
