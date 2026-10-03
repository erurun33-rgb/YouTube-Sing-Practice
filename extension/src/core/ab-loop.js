// Minimal A/B loop. Decision logic is pure (unit tested); the controller only wires it to a <video>.
// Data shape mirrors the future loops[] entry so Phase 1 can persist multiple ranges.

export const MIN_LOOP_SECONDS = 0.2;
export const NUDGE_STEP = 0.1;

export function normalizeRange(a, b) {
  if (a == null || b == null) return { a, b };
  return a <= b ? { a, b } : { a: b, b: a };
}

// Returns the time to seek to, or null.
export function loopSeekTarget(t, { a, b, enabled }) {
  if (!enabled || a == null || b == null) return null;
  if (b - a < MIN_LOOP_SECONDS) return null;
  if (t >= b) return a;
  return null;
}

export function roundTenth(t) {
  return Math.round(t * 10) / 10;
}

export class AbLoopController {
  constructor({ logger, isAdShowing = () => false, onChange = () => {} }) {
    this.logger = logger;
    this.isAdShowing = isAdShowing;
    this.onChange = onChange;
    this.state = { a: null, b: null, enabled: false };
    this.loops = 0;
    this.video = null;
    this._onTime = () => this.tick('timeupdate');
    this._onPlay = () => { this._startFrameLoop(); this._schedule(); };
    this._rvfcHandle = null;
    this._timeout = null;
  }

  attach(video) {
    if (this.video === video) return;
    this.detach();
    this.video = video;
    if (!video) return;
    video.addEventListener('timeupdate', this._onTime);
    video.addEventListener('play', this._onPlay);
    video.addEventListener('seeked', this._onPlay);
    video.addEventListener('ratechange', this._onPlay);
    if (!video.paused) this._onPlay();
  }

  detach() {
    const v = this.video;
    if (!v) return;
    v.removeEventListener('timeupdate', this._onTime);
    v.removeEventListener('play', this._onPlay);
    v.removeEventListener('seeked', this._onPlay);
    v.removeEventListener('ratechange', this._onPlay);
    if (this._rvfcHandle != null && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(this._rvfcHandle);
    this._rvfcHandle = null;
    clearTimeout(this._timeout);
    this.video = null;
  }

  // Precise path while the tab is visible: per-frame callback.
  _startFrameLoop() {
    const v = this.video;
    if (!v || !v.requestVideoFrameCallback || this._rvfcHandle != null) return;
    const cb = (_now, meta) => {
      this._rvfcHandle = null;
      if (this.video !== v || v.paused) return;
      this.tick('frame', meta?.mediaTime);
      this._rvfcHandle = v.requestVideoFrameCallback(cb);
    };
    this._rvfcHandle = v.requestVideoFrameCallback(cb);
  }

  // Timer aimed at B (helps audio-only / when frames are not rendered); timeupdate is the last resort.
  _schedule() {
    clearTimeout(this._timeout);
    const v = this.video;
    const { a, b, enabled } = this.state;
    if (!v || v.paused || !enabled || a == null || b == null) return;
    const remaining = (b - v.currentTime) / (v.playbackRate || 1);
    if (remaining < 0) { this.tick('timer'); return; }
    this._timeout = setTimeout(() => { this.tick('timer'); this._schedule(); }, Math.max(10, remaining * 1000));
  }

  tick(source, mediaTime) {
    const v = this.video;
    if (!v) return;
    // A jump is already in flight (rVFC may still report a pre-seek frame time).
    if (v.seeking) return;
    if (this.isAdShowing()) return;
    const t = mediaTime ?? v.currentTime;
    const target = loopSeekTarget(t, this.state);
    if (target == null) return;
    v.currentTime = target;
    this.loops++;
    this.logger?.debug('AB loop jump', { from: +t.toFixed(3), to: target, source, loops: this.loops });
    this.onChange();
  }

  _set(patch) {
    const next = { ...this.state, ...patch };
    const r = normalizeRange(next.a, next.b);
    this.state = { ...next, ...r };
    this.logger?.info('AB state', this.state);
    this._schedule();
    this.onChange();
  }

  // Restore a saved range (e.g. when a video with saved data is opened).
  restore({ a, b, enabled }) {
    this.loops = 0;
    this._set({ a: a ?? null, b: b ?? null, enabled: !!enabled && a != null && b != null });
  }

  setA(t) { this._set({ a: roundTenth(t) }); }
  setB(t) { this._set({ b: roundTenth(t) }); }
  nudge(which, delta) {
    const cur = this.state[which];
    if (cur == null) return;
    this._set({ [which]: Math.max(0, roundTenth(cur + delta)) });
  }
  setEnabled(enabled) { this._set({ enabled: !!enabled }); }
  clear() { this.loops = 0; this._set({ a: null, b: null, enabled: false }); }
}
