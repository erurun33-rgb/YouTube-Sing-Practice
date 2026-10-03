// Web Audio graph owner.
//
//   <video> ──MediaElementSource──► [pitch node] ──► analyser ──► destination
//                                    AudioWorkletNode (primary)
//                                    ScriptProcessorNode (fallback, same DSP)
//
// Design rules (see docs/phase0-design.md):
// - Lazy: nothing touches YouTube audio until the user first changes the key.
//   createMediaElementSource() is irreversible per element and a suspended
//   AudioContext would mute the video, so we only do it inside a user gesture.
// - Speed is never changed; the DSP emits exactly one output sample per input sample.
// - "Off" routes source -> destination directly (no DSP, no added latency).
// - One AudioContext for the page lifetime; SPA navigation reuses it. If YouTube
//   swaps the <video> element, the old source is disconnected and a new one created.

import { MultiChannelPitchShifter, clampSemitones } from '../dsp/pitch-shifter.js';

const WORKLET_NAME = 'ysp-pitch-processor';
const RESUME_TIMEOUT_MS = 400;

// Thrown when the browser will not start audio yet (no user activation on this page).
// The source is NOT hijacked in that case, so the video keeps playing normally.
export class NeedsUserGestureError extends Error {
  constructor() {
    super('AudioContext needs a user gesture');
    this.name = 'NeedsUserGestureError';
  }
}

export class AudioEngine {
  constructor({ logger, workletUrl, fftSize = 2048, forceFallback = false, simulateNoActivation = false }) {
    this.logger = logger;
    this.workletUrl = workletUrl;
    this.fftSize = fftSize;
    this.forceFallback = forceFallback;
    // Test hook: behave as if the page had no user activation until markUserGesture().
    this.simulateNoActivation = simulateNoActivation;
    this.ctx = null;
    this.node = null;
    this.mode = 'none'; // none | worklet | scriptprocessor
    this.video = null;
    this.source = null;
    this.sources = new WeakMap(); // element -> MediaElementAudioSourceNode (can only be created once)
    this.semitones = 0;
    this.enabled = true;
    this.lastStats = null;
    this.latencySamples = null;
    this.error = null;
    this._attaching = null;
    this.pendingGesture = false; // a non-zero key is waiting for the first click on the page
    this._onCtxState = () => this.logger.info('AudioContext state', this.ctx.state);
  }

  get attached() {
    return !!this.source;
  }

  // Remember which element to use; does NOT touch audio until ensureAttached().
  setVideo(video) {
    if (video === this.video) return;
    this.video = video;
    if (this.source) {
      // Already hijacked a previous element: move the graph to the new one immediately,
      // otherwise the new element would play unprocessed while the UI shows a key.
      this._connectSource().catch((e) => this._fail(e));
    }
  }

  // Must be called from a user gesture handler the first time.
  async ensureAttached() {
    if (!this.video) throw new Error('no <video> element');
    if (!this._attaching) this._attaching = this._attach();
    try {
      await this._attaching;
    } finally {
      this._attaching = null;
    }
  }

  async _attach() {
    if (!this.ctx) {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx.addEventListener('statechange', this._onCtxState);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 8192;
      this.analyser.connect(this.ctx.destination);
      this.logger.info('AudioContext created', { sampleRate: this.ctx.sampleRate, baseLatency: this.ctx.baseLatency });
    }
    if (this.ctx.state !== 'running') {
      // resume() only succeeds with user activation (or autoplay permission); without it the
      // promise stays pending, so race it. Never create the MediaElementSource on a
      // non-running context: that would silence the video.
      const resumed = this.ctx.resume().catch((e) => this.logger.warn('resume failed', e));
      await Promise.race([resumed, new Promise((r) => setTimeout(r, RESUME_TIMEOUT_MS))]);
    }
    if (this.ctx.state !== 'running' || this.simulateNoActivation) throw new NeedsUserGestureError();
    if (!this.node) await this._createNode();
    await this._connectSource();
  }

  async _createNode() {
    const ctx = this.ctx;
    if (!this.forceFallback && ctx.audioWorklet && this.workletUrl) {
      try {
        await ctx.audioWorklet.addModule(this.workletUrl);
        const node = new AudioWorkletNode(ctx, WORKLET_NAME, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { fftSize: this.fftSize },
        });
        node.port.onmessage = (e) => this._onWorkletMessage(e.data);
        node.onprocessorerror = (e) => this._fail(new Error(`processorerror: ${e.message || 'unknown'}`));
        this.node = node;
        this.mode = 'worklet';
        this._post({ type: 'setSemitones', value: this.semitones });
        this._post({ type: 'setEnabled', value: this.enabled });
        this.logger.info('pitch node: AudioWorklet');
        return;
      } catch (e) {
        this.logger.warn('AudioWorklet unavailable, falling back to ScriptProcessor', e);
      }
    }
    // Fallback: same DSP on the main thread. Higher latency (+buffer) and jank-sensitive,
    // but keeps the feature working if worklet loading is blocked.
    const bufferSize = 2048;
    const sp = ctx.createScriptProcessor(bufferSize, 2, 2);
    const dsp = new MultiChannelPitchShifter({ fftSize: this.fftSize });
    dsp.setSemitones(this.semitones);
    dsp.setEnabled(this.enabled);
    const blk = 128;
    sp.onaudioprocess = (ev) => {
      const ins = [], outs = [];
      for (let c = 0; c < ev.inputBuffer.numberOfChannels; c++) ins.push(ev.inputBuffer.getChannelData(c));
      for (let c = 0; c < ev.outputBuffer.numberOfChannels; c++) outs.push(ev.outputBuffer.getChannelData(c));
      for (let i = 0; i < bufferSize; i += blk) {
        dsp.process(ins.map((x) => x.subarray(i, i + blk)), outs.map((x) => x.subarray(i, i + blk)));
      }
    };
    this.fallbackDsp = dsp;
    this.node = sp;
    this.mode = 'scriptprocessor';
    this.latencySamples = dsp.latencySamples + bufferSize;
    this.logger.warn('pitch node: ScriptProcessor fallback');
  }

  async _connectSource() {
    const video = this.video;
    if (!video || !this.ctx) return;
    if (this.source && this.source.mediaElement === video) {
      this._route();
      return;
    }
    if (this.source) {
      try { this.source.disconnect(); } catch { /* ignore */ }
      this.logger.info('detached previous <video> source');
    }
    let src = this.sources.get(video);
    if (!src) {
      src = this.ctx.createMediaElementSource(video);
      this.sources.set(video, src);
      this.logger.info('MediaElementSource created');
    }
    this.source = src;
    this.reset();
    this._route();
  }

  // Route according to state: bypass bypasses the node entirely (no latency, no CPU).
  _route() {
    const src = this.source;
    if (!src) return;
    try { src.disconnect(); } catch { /* ignore */ }
    try { this.node?.disconnect(); } catch { /* ignore */ }
    if (this.isProcessing && this.node) {
      src.connect(this.node);
      this.node.connect(this.analyser);
    } else {
      src.connect(this.analyser);
    }
    this.logger.debug('route', { processing: this.isProcessing, mode: this.mode });
  }

  get isProcessing() {
    return this.enabled && this.semitones !== 0;
  }

  async setSemitones(value) {
    const st = clampSemitones(value);
    const wasProcessing = this.isProcessing;
    this.semitones = st;
    if (st === 0) this.pendingGesture = false;
    if (st !== 0 && !this.attached) {
      try {
        await this.ensureAttached();
        this.pendingGesture = false;
      } catch (e) {
        if (!(e instanceof NeedsUserGestureError)) throw e;
        this.pendingGesture = true;
        this.logger.info('key pending until first user gesture', st);
        return st;
      }
    }
    this._post({ type: 'setSemitones', value: st });
    this.fallbackDsp?.setSemitones(st);
    if (wasProcessing !== this.isProcessing) this._route();
    this.logger.info('semitones', st);
    return st;
  }

  // false = plain YouTube audio path (source -> destination), regardless of key.
  setEnabled(enabled) {
    const was = this.isProcessing;
    this.enabled = !!enabled;
    this._post({ type: 'setEnabled', value: this.enabled });
    this.fallbackDsp?.setEnabled(this.enabled);
    if (was !== this.isProcessing) this._route();
    this.logger.info('processing enabled', this.enabled);
  }

  // Flush DSP buffers (seek, source change) so stale audio is not replayed.
  reset() {
    this._post({ type: 'reset' });
    this.fallbackDsp?.reset();
  }

  // Call from a user gesture handler: applies a key that was restored before the page had activation.
  markUserGesture() {
    this.simulateNoActivation = false;
  }

  async applyPending() {
    if (!this.pendingGesture || !this.isProcessing) return false;
    await this.ensureAttached();
    this.pendingGesture = false;
    this._post({ type: 'setSemitones', value: this.semitones });
    this._route();
    this.logger.info('pending key applied', this.semitones);
    return true;
  }

  // Called on user-initiated play when the context was suspended by the browser.
  resumeIfNeeded() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch((e) => this.logger.warn('resume failed', e));
    }
  }

  _post(msg) {
    if (this.mode === 'worklet' && this.node) this.node.port.postMessage(msg);
  }

  _onWorkletMessage(msg) {
    if (msg.type === 'ready') {
      this.latencySamples = msg.latencySamples;
      this.logger.info('worklet ready', msg);
    } else if (msg.type === 'stats') {
      this.lastStats = { ...msg, at: performance.now() };
    }
  }

  _fail(e) {
    this.error = e;
    this.logger.error('audio engine error', e);
    // Safety: never leave the user without sound.
    try {
      this.enabled = false;
      this._route();
    } catch { /* ignore */ }
  }

  // Dominant output frequency from the analyser (debug / automated verification only).
  peakFrequency() {
    if (!this.analyser || !this.ctx) return null;
    const bins = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(bins);
    let best = -Infinity, idx = -1;
    for (let i = 2; i < bins.length; i++) if (bins[i] > best) { best = bins[i]; idx = i; }
    if (idx < 0 || best < -100) return null;
    return (idx * this.ctx.sampleRate) / this.analyser.fftSize;
  }

  status() {
    const ctx = this.ctx;
    const sr = ctx?.sampleRate || 48000;
    const dspLatencyMs = this.isProcessing && this.latencySamples ? (this.latencySamples / sr) * 1000 : 0;
    return {
      attached: this.attached,
      pendingGesture: this.pendingGesture,
      mode: this.mode,
      processing: this.isProcessing,
      enabled: this.enabled,
      semitones: this.semitones,
      ctxState: ctx?.state || 'none',
      sampleRate: ctx?.sampleRate || null,
      baseLatencyMs: ctx ? +((ctx.baseLatency || 0) * 1000).toFixed(1) : null,
      outputLatencyMs: ctx ? +((ctx.outputLatency || 0) * 1000).toFixed(1) : null,
      dspLatencyMs: +dspLatencyMs.toFixed(1),
      stats: this.lastStats,
      error: this.error ? String(this.error.message || this.error) : null,
    };
  }
}
