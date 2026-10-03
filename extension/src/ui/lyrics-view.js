// On-video lyrics display (Phase 2): current line + next line, with marks above characters and
// per-line handwriting. Lives in the annotation overlay, i.e. positioned against the video
// picture, so it never moves when YouTube shows/hides its controls.

import { currentLineIndex, upcomingLineIndex, markSymbol, lineTokens, INK_PAD, inkFrameRect } from '../core/lyrics.js';
import { drawStroke } from './draw.js';

export const LYRICS_CSS = `
.lyrics { position: absolute; left: 0; right: 0; display: flex; flex-direction: column; align-items: center;
  gap: .15em; pointer-events: none; text-align: center; }
.lyrics.bottom { bottom: 3%; }
.lyrics.top { top: 3%; }
.lbox { position: relative; display: inline-block; padding: 1.05em .45em .35em; border-radius: .35em;
  background: rgba(0,0,0,.55); color: #fff; font-weight: 700; line-height: 1.2; white-space: pre; }
.lbox .ch { position: relative; }
.lbox .mk { position: absolute; top: .1em; transform: translateX(-50%); font-size: .62em; line-height: 1;
  text-shadow: 0 0 3px #000, 0 0 2px #000; white-space: nowrap; }
.lbox .ins { font-size: .8em; margin: 0 .08em; text-shadow: 0 0 3px #000, 0 0 2px #000; }
.lbox .ul { position: absolute; height: 2px; bottom: .22em; opacity: .9; border-radius: 1px; }
.lbox canvas { position: absolute; pointer-events: none;
  left: -10%; width: 120%; top: -120%; height: 300%; }
.lbox.editing { outline: 2px dashed #ffd60a; outline-offset: 2px; }
.next { font-size: .68em; color: rgba(255,255,255,.72); background: rgba(0,0,0,.4); padding: .1em .5em;
  border-radius: .3em; white-space: pre; }
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Build a line box: character spans with inserted marks ('before' placement) in between,
// ruby marks positioned later in layoutLineBox, and the ink canvas.
export function buildLineBox(line, markTypes) {
  const box = el('div', 'lbox');
  box.dataset.lineId = line.id;
  const spans = [];
  for (const tk of lineTokens(line, markTypes)) {
    if (tk.kind === 'ins') {
      const s = el('span', 'ins', tk.sym.symbol);
      s.style.color = tk.sym.color;
      if (tk.mark.note) s.title = tk.mark.note;
      box.append(s);
    } else {
      const s = el('span', 'ch', tk.c);
      s.dataset.i = String(tk.i);
      spans[tk.i] = s;
      box.append(s);
    }
  }
  const canvas = document.createElement('canvas');
  box.append(canvas);
  return { box, spans, canvas };
}

// Needs the box attached (uses offsetLeft/offsetWidth of the spans).
export function layoutLineBox({ box, spans, canvas }, line, markTypes, { drawInk = true } = {}) {
  box.querySelectorAll('.mk, .ul').forEach((n) => n.remove());
  for (const m of line.marks) {
    const a = spans[m.from], b = spans[m.to];
    if (!a || !b) continue;
    const { symbol, color, placement } = markSymbol(m, markTypes);
    if (placement === 'before') continue; // rendered inline by buildLineBox
    const left = a.offsetLeft;
    const right = b.offsetLeft + b.offsetWidth;
    const mk = el('span', 'mk', symbol);
    mk.style.left = `${(left + right) / 2}px`;
    mk.style.color = color;
    if (m.note) mk.title = m.note;
    box.append(mk);
    if (m.to > m.from) {
      const ul = el('span', 'ul');
      ul.style.left = `${left}px`;
      ul.style.width = `${right - left}px`;
      ul.style.background = color;
      box.append(ul);
    }
  }
  // The canvas covers the enlarged ink frame around the box (see INK_PAD / CSS above).
  const w = box.offsetWidth * (1 + 2 * INK_PAD.x), h = box.offsetHeight * (1 + INK_PAD.top + INK_PAD.bottom);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (drawInk) for (const s of line.ink) drawStroke(ctx, s, w, h);
}

export class LyricsView {
  constructor(container) {
    this.root = el('div', 'lyrics bottom');
    container.append(this.root);
    this.lyrics = null;
    this.markTypes = [];
    this.forcedLineId = null; // show this line regardless of time (line handwriting)
    this.editingLineId = null; // hide its stored ink while the ink editor draws it
    this._key = '';
    this.current = null;
    // Re-measure marks and repaint line ink whenever the current line box changes size
    // (window/player resize, theater, fullscreen, lyric size, late font loading).
    this._ro = new ResizeObserver(() => this.relayout());
  }

  relayout() {
    const c = this.current;
    if (!c || !c.box.isConnected || !c.box.offsetWidth) return;
    layoutLineBox(c, c.line, this.markTypes, { drawInk: c.line.id !== this.editingLineId });
  }

  set(lyrics, markTypes) {
    this.lyrics = lyrics;
    this.markTypes = markTypes;
    this._key = '';
  }

  invalidate() {
    this._key = '';
  }

  update(t, { hidden = false } = {}) {
    const ly = this.lyrics;
    if (!ly || hidden || !ly.display.visible || !ly.lines.length) {
      if (this._key !== 'none') { this.root.replaceChildren(); this._key = 'none'; this.current = null; }
      return;
    }
    let cur = currentLineIndex(ly, t);
    if (this.forcedLineId) cur = ly.lines.findIndex((l) => l.id === this.forcedLineId);
    const nxt = ly.display.showNext && !this.forcedLineId ? upcomingLineIndex(ly, t, cur) : -1;
    const key = `${cur}|${nxt}|${ly.display.position}|${this.editingLineId}`;
    if (key === this._key) return;
    this._key = key;
    this.root.className = `lyrics ${ly.display.position}`;
    this.root.style.fontSize = `${ly.display.size}em`;
    this.root.replaceChildren();
    this._ro.disconnect();
    this.current = null;
    const parts = [];
    if (cur >= 0) {
      const line = ly.lines[cur];
      const built = buildLineBox(line, this.markTypes);
      built.box.classList.toggle('editing', line.id === this.editingLineId);
      parts.push(built.box);
      this.current = { line, ...built };
    }
    if (nxt >= 0 && nxt !== cur) parts.push(el('div', 'next', ly.lines[nxt].text));
    this.root.append(...parts); // current line first, the upcoming line under it
    if (this.current) {
      this.relayout();
      this._ro.observe(this.current.box);
    }
  }

  // Ink frame of the current line (box enlarged by INK_PAD) relative to `ref`, for the ink editor.
  currentBoxRect(ref) {
    if (!this.current) return null;
    const r = this.current.box.getBoundingClientRect();
    const o = ref.getBoundingClientRect();
    return inkFrameRect({ left: r.left - o.left, top: r.top - o.top, width: r.width, height: r.height });
  }
}
