// Annotation overlay drawn exactly over the picture area of the YouTube <video>.
// - Lives inside #movie_player, so it follows normal / theater / fullscreen automatically.
// - Positions are stored normalised (0..1) and rendered with % / canvas scaling, so any resize
//   keeps annotations on the same spot of the picture.
// - Built with DOM APIs only (YouTube enforces Trusted Types).

import { containRect, toNormalized, simplify, roundPoints, strokeHit } from '../core/geometry.js';
import { visibleAnnotations } from '../core/store.js';
import { drawStroke } from './draw.js';
import { LyricsView, LYRICS_CSS } from './lyrics-view.js';

export { drawStroke };

export const INK_COLORS = ['#ff3b30', '#ffd60a', '#64d2ff', '#ffffff'];
export const TEXT_COLORS = ['#ffffff', '#ffd60a', '#ff6b6b', '#64d2ff'];
const INK_WIDTH = 0.006; // fraction of picture height

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.root { position: absolute; inset: 0; font-family: system-ui, "Hiragino Sans", "Yu Gothic UI", sans-serif; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.texts { position: absolute; inset: 0; }
.t { position: absolute; transform: translate(-50%, -50%); padding: .15em .45em; border-radius: .35em;
  background: rgba(0,0,0,.55); font-weight: 700; line-height: 1.25; white-space: pre; text-align: center;
  text-shadow: 0 0 3px #000, 0 0 2px #000; pointer-events: none; user-select: none; }
.editable .t { pointer-events: auto; cursor: move; outline: 1px dashed rgba(255,255,255,.6); }
.hint { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); background: rgba(20,20,24,.9);
  color: #fff; font-size: 13px; padding: 6px 10px; border-radius: 6px; pointer-events: none; white-space: nowrap; }
.catcher { position: absolute; inset: 0; cursor: crosshair; }
.region { position: absolute; border: 2px dashed #ffd60a; background: rgba(255,214,10,.12); pointer-events: none; }
.region.saved { border-color: #64d2ff; background: rgba(100,210,255,.1); }
.editor { position: absolute; transform: translate(-50%, -50%); display: flex; flex-direction: column; gap: 4px;
  background: rgba(20,20,24,.95); padding: 6px; border-radius: 6px; border: 1px solid #666; }
.editor textarea { font: inherit; font-size: 14px; line-height: 1.3; width: 220px; min-height: 44px; resize: vertical; color: #fff;
  background: #222; border: 1px solid #555; border-radius: 4px; padding: 4px; }
.row { display: flex; gap: 4px; align-items: center; }
button { font: inherit; font-size: 12px; color: #eee; background: #333; border: 1px solid #666; border-radius: 4px;
  padding: 3px 8px; cursor: pointer; }
button.on { background: #1a73e8; border-color: #1a73e8; }
button.sw { width: 20px; height: 20px; padding: 0; border-radius: 50%; }
button.sw.on { outline: 2px solid #fff; outline-offset: 1px; }
.toolbar { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); display: flex; gap: 4px;
  flex-wrap: wrap; justify-content: center; background: rgba(20,20,24,.92); padding: 6px; border-radius: 8px;
  border: 1px solid #666; z-index: 2; }
`;

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'style') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c);
  return e;
}

export class AnnotationOverlay {
  constructor({ logger, onMoveText, onEditText }) {
    this.logger = logger;
    this.onMoveText = onMoveText;
    this.onEditText = onEditText;
    this.annotations = [];
    this.visible = true;
    this.editable = false;
    this.player = null;
    this.video = null;
    this.rect = { width: 0, height: 0 };
    this._visibleKey = '';
    this._session = null;

    this.host = el('div', { id: 'ysp-overlay-host' });
    Object.assign(this.host.style, { position: 'absolute', zIndex: '45', pointerEvents: 'none', left: '0', top: '0' });
    const shadow = this.host.attachShadow({ mode: 'open' });
    shadow.append(el('style', { text: CSS + LYRICS_CSS }));
    this.root = el('div', { class: 'root' });
    this.canvas = el('canvas');
    this.texts = el('div', { class: 'texts' });
    this.sessionLayer = el('div', { class: 'root', style: { pointerEvents: 'none' } });
    this.lyricsLayer = el('div', { class: 'root', style: { pointerEvents: 'none' } });
    this.root.append(this.canvas, this.texts, this.lyricsLayer, this.sessionLayer);
    this.lyricsView = new LyricsView(this.lyricsLayer);
    shadow.append(this.root);

    // While interactive, keep clicks/keys away from the YouTube player (play/pause, fullscreen, shortcuts).
    for (const type of ['keydown', 'keyup', 'keypress', 'click', 'dblclick', 'mousedown', 'pointerdown', 'contextmenu', 'wheel']) {
      this.host.addEventListener(type, (e) => { if (this._interactive()) e.stopPropagation(); });
    }

    this._layout = this.layout.bind(this);
    this._ro = new ResizeObserver(this._layout);
    this._mo = new MutationObserver(this._layout);
    document.addEventListener('fullscreenchange', this._layout);
    window.addEventListener('resize', this._layout);
  }

  _interactive() {
    return !!this._session || this.editable;
  }

  mount(player, video) {
    if (this.player !== player && player) {
      this._ro.disconnect();
      player.append(this.host);
      this._ro.observe(player);
    }
    if (this.video !== video) {
      this._mo.disconnect();
      if (video) {
        this._ro.observe(video);
        this._mo.observe(video, { attributes: true, attributeFilter: ['style', 'class'] });
        video.addEventListener('loadedmetadata', this._layout);
      }
    }
    this.player = player;
    this.video = video;
    this.layout();
  }

  layout() {
    const p = this.player, v = this.video;
    if (!p || !v) return;
    const pr = p.getBoundingClientRect();
    const r = containRect(v.getBoundingClientRect(), { width: v.videoWidth, height: v.videoHeight });
    const s = this.host.style;
    s.left = `${r.left - pr.left}px`;
    s.top = `${r.top - pr.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    this.root.style.fontSize = `${Math.max(12, Math.min(48, r.height * 0.042))}px`;
    const changed = Math.round(r.width) !== Math.round(this.rect.width) || Math.round(r.height) !== Math.round(this.rect.height);
    this.rect = r;
    if (changed) {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.max(1, Math.round(r.width * dpr));
      this.canvas.height = Math.max(1, Math.round(r.height * dpr));
      this._visibleKey = ''; // force redraw
      this.lyricsView.invalidate();
      this._session?.redraw();
      // Resizing the canvas cleared it: redraw now (the video may be paused, so no frame
      // update would come to repaint it).
      if (this._last) this.update(this._last.t, { hidden: this._last.hidden });
    }
  }

  setAnnotations(list) {
    this.annotations = list;
    this._visibleKey = '';
  }

  setVisible(v) {
    this.visible = !!v;
    this._visibleKey = '';
  }

  // Editable: text annotations become draggable (only the labels take pointer events,
  // the rest of the picture still reaches the player).
  setEditable(v) {
    if (this.editable === !!v) return;
    this.editable = !!v;
    this.root.classList.toggle('editable', this.editable);
    if (!this._session) this.host.style.zIndex = this.editable ? '75' : '45';
  }

  // Called every frame while playing and on seek; cheap when nothing changed.
  update(t, { hidden = false } = {}) {
    this._last = { t, hidden };
    this.lyricsView.update(t, { hidden });
    const list = this.visible && !hidden ? visibleAnnotations(this.annotations, t) : [];
    const key = list.map((a) => a.id).join(',');
    if (key === this._visibleKey) return;
    this._visibleKey = key;
    this._render(list);
  }

  _render(list) {
    this.texts.replaceChildren();
    for (const a of list.filter((x) => x.type === 'text')) {
      const d = el('div', { class: 't', text: a.text, 'data-id': a.id });
      d.style.left = `${a.x * 100}%`;
      d.style.top = `${a.y * 100}%`;
      d.style.color = a.color;
      d.addEventListener('pointerdown', (e) => this._dragText(e, a, d));
      d.addEventListener('dblclick', (e) => { e.stopPropagation(); this.onEditText?.(a.id); });
      this.texts.append(d);
    }
    const ctx = this.canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.rect.width, this.rect.height);
    for (const a of list.filter((x) => x.type === 'ink')) {
      for (const s of a.strokes) drawStroke(ctx, s, this.rect.width, this.rect.height);
    }
  }

  _dragText(e, a, d) {
    if (!this.editable || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    d.setPointerCapture(e.pointerId);
    let pos = [a.x, a.y];
    const move = (ev) => {
      pos = toNormalized(ev.clientX, ev.clientY, this.host.getBoundingClientRect());
      d.style.left = `${pos[0] * 100}%`;
      d.style.top = `${pos[1] * 100}%`;
    };
    const up = () => {
      d.removeEventListener('pointermove', move);
      d.removeEventListener('pointerup', up);
      if (pos[0] !== a.x || pos[1] !== a.y) this.onMoveText?.(a.id, pos[0], pos[1]);
    };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  }

  _beginSession(session) {
    this.cancelSession();
    this._session = session;
    this.host.style.pointerEvents = 'auto';
    this.host.style.zIndex = '75';
    this.sessionLayer.style.pointerEvents = 'auto';
    this.sessionLayer.replaceChildren(...session.nodes);
  }

  _endSession() {
    this._session = null;
    this.sessionLayer.replaceChildren();
    this.sessionLayer.style.pointerEvents = 'none';
    this.host.style.pointerEvents = 'none';
    this.host.style.zIndex = this.editable ? '75' : '45';
  }

  get busy() {
    return !!this._session;
  }

  cancelSession() {
    this._session?.cancel();
  }

  // Drag a rectangle on the picture. Resolves { x, y, w, h } (0..1) or null (Esc / too small).
  // `initial` is shown as a hint (e.g. the region used last time).
  selectRegion(initial = null) {
    return new Promise((resolve) => {
      let done = false;
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
      const finish = (v) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey, true);
        this._endSession();
        resolve(v);
      };
      const catcher = el('div', { class: 'catcher' });
      const box = el('div', { class: 'region' });
      const hint = el('div', { class: 'hint', text: '歌詞が表示される範囲をドラッグで囲んでください（Escで取消）' });
      const place = (b, r) => Object.assign(b.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
      const nodes = [catcher, hint];
      if (initial) {
        const prev = el('div', { class: 'region saved' });
        place(prev, initial);
        nodes.push(prev);
      }
      let start = null;
      catcher.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        catcher.setPointerCapture(e.pointerId);
        start = toNormalized(e.clientX, e.clientY, this.host.getBoundingClientRect());
        this.sessionLayer.append(box);
        place(box, { x: start[0], y: start[1], w: 0, h: 0 });
      });
      const rectTo = (e) => {
        const p = toNormalized(e.clientX, e.clientY, this.host.getBoundingClientRect());
        return { x: Math.min(start[0], p[0]), y: Math.min(start[1], p[1]), w: Math.abs(p[0] - start[0]), h: Math.abs(p[1] - start[1]) };
      };
      catcher.addEventListener('pointermove', (e) => { if (start) place(box, rectTo(e)); });
      catcher.addEventListener('pointerup', (e) => {
        if (!start) return;
        const r = rectTo(e);
        start = null;
        if (r.w < 0.03 || r.h < 0.02) { box.remove(); return; } // a click, not a drag: try again
        finish(r);
      });
      window.addEventListener('keydown', onKey, true);
      this._beginSession({ nodes, cancel: () => finish(null), redraw: () => {} });
    });
  }

  // Text: click a spot, type, Enter. Resolves {x, y, text, color} or null. `initial` edits an existing one.
  placeText(initial = null) {
    return new Promise((resolve) => {
      let done = false;
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
      const finish = (v) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey, true);
        this._endSession();
        resolve(v);
      };
      const nodes = [];
      let color = initial?.color || TEXT_COLORS[0];
      const openEditor = (x, y) => {
        catcher.remove();
        hint.textContent = 'Enterで確定 / Shift+Enterで改行 / Escで取消';
        const ta = el('textarea', { placeholder: '例: ブレス / 走らない / 高音注意' });
        ta.value = initial?.text || '';
        const swatches = TEXT_COLORS.map((c) => {
          const b = el('button', { class: `sw${c === color ? ' on' : ''}`, title: c, style: { background: c },
            onclick: () => { color = c; swatches.forEach((s) => s.classList.toggle('on', s === b)); ta.focus(); } });
          return b;
        });
        const ok = () => { const text = ta.value.trim(); finish(text ? { x, y, text, color } : null); };
        const box = el('div', { class: 'editor' }, [ta, el('div', { class: 'row' }, [
          ...swatches, el('button', { text: 'OK', onclick: ok }), el('button', { text: '取消', onclick: () => finish(null) }),
        ])]);
        box.style.left = `${Math.min(80, Math.max(20, x * 100))}%`;
        box.style.top = `${Math.min(80, Math.max(20, y * 100))}%`;
        ta.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); ok(); }
          if (e.key === 'Escape') finish(null);
        });
        this.sessionLayer.append(box);
        setTimeout(() => ta.focus(), 0);
      };
      const hint = el('div', { class: 'hint', text: '注釈を置く位置をクリック（Escで取消）' });
      const catcher = el('div', { class: 'catcher' });
      catcher.addEventListener('click', (e) => {
        e.stopPropagation();
        const [x, y] = toNormalized(e.clientX, e.clientY, this.host.getBoundingClientRect());
        openEditor(x, y);
      });
      nodes.push(catcher, hint);
      window.addEventListener('keydown', onKey, true);
      this._beginSession({ nodes, cancel: () => finish(null), redraw: () => {} });
      if (initial) openEditor(initial.x, initial.y);
    });
  }

  // Handwriting: pen / circle / arrow / eraser / undo. Resolves strokes[] (normalised) or null.
  // options.frame(): rect {left, top, width, height} relative to the overlay that the strokes are
  //   normalised against (default: the whole picture; lyrics pass the current line box).
  // options.initial: strokes to start from (editing existing ink); options.allowEmpty: resolve []
  //   instead of null when everything was erased (so "clear" can be saved).
  drawInk({ frame = null, initial = [], widthRatio = INK_WIDTH, allowEmpty = false } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const strokes = initial.map((s) => ({ ...s, points: s.points.map((p) => [...p]) }));
      const undo = [];
      const getFrame = () => (frame && frame()) || { left: 0, top: 0, width: this.rect.width, height: this.rect.height };
      let tool = 'pen';
      let color = INK_COLORS[0];
      let current = null;
      const canvas = el('canvas', { style: { cursor: 'crosshair', touchAction: 'none' } });
      const size = () => {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(this.rect.width * dpr));
        canvas.height = Math.max(1, Math.round(this.rect.height * dpr));
      };
      const redraw = () => {
        size();
        const ctx = canvas.getContext('2d');
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, this.rect.width, this.rect.height);
        const f = getFrame();
        if (frame) {
          ctx.save();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = 'rgba(255,214,10,.9)';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(f.left - 2, f.top - 2, f.width + 4, f.height + 4);
          ctx.restore();
        }
        ctx.translate(f.left, f.top);
        for (const s of strokes) drawStroke(ctx, s, f.width, f.height);
        if (current) drawStroke(ctx, current, f.width, f.height);
      };
      const finish = (v) => {
        if (done) return;
        done = true;
        window.removeEventListener('keydown', onKey, true);
        this._endSession();
        resolve(v);
      };
      const absFrame = () => {
        const h = this.host.getBoundingClientRect();
        const f = getFrame();
        return { left: h.left + f.left, top: h.top + f.top, width: f.width, height: f.height };
      };
      const norm = (e) => toNormalized(e.clientX, e.clientY, absFrame());
      const eraseAt = (e) => {
        const r = absFrame();
        const px = e.clientX - r.left, py = e.clientY - r.top;
        for (let i = strokes.length - 1; i >= 0; i--) {
          if (strokeHit(strokes[i], px, py, r.width, r.height, 10)) {
            undo.push({ type: 'erase', stroke: strokes[i], index: i });
            strokes.splice(i, 1);
            redraw();
          }
        }
      };
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        canvas.setPointerCapture(e.pointerId);
        if (tool === 'eraser') { eraseAt(e); return; }
        const p = norm(e);
        current = { tool, color, width: widthRatio, points: tool === 'pen' ? [p] : [p, p] };
        redraw();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!(e.buttons & 1)) return;
        if (tool === 'eraser') { eraseAt(e); return; }
        if (!current) return;
        const p = norm(e);
        if (current.tool === 'pen') current.points.push(p); else current.points[1] = p;
        redraw();
      });
      canvas.addEventListener('pointerup', () => {
        if (!current) return;
        const s = current;
        current = null;
        s.points = roundPoints(s.tool === 'pen' ? simplify(s.points, 0.0015) : s.points);
        strokes.push(s);
        undo.push({ type: 'add' });
        redraw();
        refresh();
      });
      const doUndo = () => {
        const last = undo.pop();
        if (!last) return;
        if (last.type === 'add') strokes.pop();
        else strokes.splice(last.index, 0, last.stroke);
        redraw();
        refresh();
      };
      const toolBtn = (id, label) => el('button', { text: label, 'data-tool': id, onclick: () => { tool = id; refresh(); } });
      const tools = [toolBtn('pen', 'ペン'), toolBtn('circle', '○'), toolBtn('arrow', '→'), toolBtn('eraser', '消しゴム')];
      const swatches = INK_COLORS.map((c) => el('button', { class: 'sw', title: c, style: { background: c },
        onclick: () => { color = c; refresh(); } }));
      const undoBtn = el('button', { text: 'Undo', onclick: doUndo });
      const okBtn = el('button', { text: '完了', onclick: () => finish(strokes.length || allowEmpty ? strokes.slice() : null) });
      const cancelBtn = el('button', { text: '取消', onclick: () => finish(null) });
      const refresh = () => {
        tools.forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
        swatches.forEach((b, i) => b.classList.toggle('on', INK_COLORS[i] === color));
        undoBtn.disabled = !undo.length;
      };
      const bar = el('div', { class: 'toolbar' }, [...tools, ...swatches, undoBtn, okBtn, cancelBtn]);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); finish(null); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); doUndo(); }
      };
      window.addEventListener('keydown', onKey, true);
      this._beginSession({ nodes: [canvas, bar], cancel: () => finish(null), redraw });
      refresh();
      redraw();
    });
  }
}
