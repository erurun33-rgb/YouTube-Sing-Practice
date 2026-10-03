// Streaming phase-vocoder pitch shifter (single channel).
//
// Algorithm: STFT analysis -> spectral peak picking -> "peak shifting" with
// identity phase locking (Laroche & Dolson, 1999) -> ISTFT overlap-add.
// Each spectral peak and its region of influence is moved rigidly to
// round(peak * ratio); the peak phase is propagated from the previous frame
// using its instantaneous frequency, and the other bins in the region keep
// their phase offset relative to the peak. This keeps partials coherent and
// reduces the "phasiness" of a plain bin-by-bin vocoder.
//
// Duration / playback speed is never changed: one output sample per input sample.
// Fixed end-to-end latency = fftSize samples (2048 ≈ 43ms @48kHz by default).
//
// Written from scratch for this project (no third-party code), so there is no
// licence constraint on distribution.

import { FFT } from './fft.js';

export const MIN_SEMITONES = -12;
export const MAX_SEMITONES = 12;

export function clampSemitones(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_SEMITONES, Math.max(MIN_SEMITONES, n));
}

export function semitonesToRatio(semitones) {
  return Math.pow(2, semitones / 12);
}

const TWO_PI = 2 * Math.PI;

function wrapPhase(p) {
  return p - TWO_PI * Math.round(p / TWO_PI);
}

export class PitchShifter {
  constructor({ fftSize = 2048, overlap = 4 } = {}) {
    this.fftSize = fftSize;
    this.overlap = overlap;
    this.hop = fftSize / overlap;
    this.fifoLatency = fftSize - this.hop; // internal FIFO offset
    this.latency = fftSize; // measured end-to-end delay in samples
    this.half = fftSize / 2;
    this.fft = new FFT(fftSize);

    const n = fftSize;
    const h = this.half;
    this.window = new Float64Array(n);
    for (let i = 0; i < n; i++) this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / n);
    // Normalisation so that analysis*synthesis (Hann^2) windows overlap-add to unity.
    let acc = 0;
    for (let i = 0; i < n; i++) acc += this.window[i] * this.window[i];
    this.olaGain = this.hop / acc;

    this.inFifo = new Float64Array(n);
    this.outFifo = new Float64Array(n);
    this.outAccum = new Float64Array(2 * n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.mag = new Float64Array(h + 1);
    this.phase = new Float64Array(h + 1);
    this.freq = new Float64Array(h + 1);
    this.prevAnaPhase = new Float64Array(h + 1);
    this.prevSynPhase = new Float64Array(h + 1);
    this.synMag = new Float64Array(h + 1);
    this.synPhase = new Float64Array(h + 1);
    this.synOwner = new Float64Array(h + 1); // magnitude of the contribution that set synPhase
    this.peaks = new Int32Array(h + 1);
    this.expct = (TWO_PI * this.hop) / n;

    this.ratio = 1;
    this.rover = this.fifoLatency;
    this.framesProcessed = 0;
  }

  setRatio(ratio) {
    if (!(ratio > 0) || !Number.isFinite(ratio)) throw new Error(`invalid ratio ${ratio}`);
    this.ratio = ratio;
  }

  setSemitones(semitones) {
    this.setRatio(semitonesToRatio(clampSemitones(semitones)));
  }

  // Drop all buffered audio (used after seek / source change so stale audio does not leak).
  reset() {
    this.inFifo.fill(0);
    this.outFifo.fill(0);
    this.outAccum.fill(0);
    this.prevAnaPhase.fill(0);
    this.prevSynPhase.fill(0);
    this.rover = this.fifoLatency;
  }

  // Process `input` into `output` (same length, may be the same array).
  process(input, output) {
    const len = input.length;
    const lat = this.fifoLatency;
    for (let i = 0; i < len; i++) {
      this.inFifo[this.rover] = input[i];
      output[i] = this.outFifo[this.rover - lat];
      this.rover++;
      if (this.rover >= this.fftSize) {
        this.rover = lat;
        this._frame();
      }
    }
  }

  _frame() {
    const n = this.fftSize;
    const h = this.half;
    const hop = this.hop;
    const { re, im, mag, phase, freq, window: win } = this;

    for (let i = 0; i < n; i++) {
      re[i] = this.inFifo[i] * win[i];
      im[i] = 0;
    }
    this.fft.transform(re, im, false);

    let maxMag = 0;
    for (let k = 0; k <= h; k++) {
      const m = Math.hypot(re[k], im[k]);
      const p = Math.atan2(im[k], re[k]);
      mag[k] = m;
      phase[k] = p;
      const dev = wrapPhase(p - this.prevAnaPhase[k] - k * this.expct);
      this.prevAnaPhase[k] = p;
      // Instantaneous frequency in bins: k + dev * n / (2π * hop).
      freq[k] = k + dev / this.expct;
      if (m > maxMag) maxMag = m;
    }

    // Peak picking (local maxima over ±2 bins, above a relative floor).
    const floor = maxMag * 1e-5 + 1e-12;
    let np = 0;
    for (let k = 1; k < h; k++) {
      const m = mag[k];
      if (m < floor) continue;
      if (m > mag[k - 1] && m >= mag[k + 1] &&
          (k < 2 || m > mag[k - 2]) && (k + 2 > h || m >= mag[k + 2])) {
        this.peaks[np++] = k;
      }
    }

    const synMag = this.synMag;
    const synPhase = this.synPhase;
    const synOwner = this.synOwner;
    synMag.fill(0);
    synOwner.fill(-1);

    const ratio = this.ratio;
    for (let pi = 0; pi < np; pi++) {
      const p = this.peaks[pi];
      const lo = pi === 0 ? 0 : ((this.peaks[pi - 1] + p) >> 1) + 1;
      const hi = pi === np - 1 ? h : (p + this.peaks[pi + 1]) >> 1;
      const q = Math.round(p * ratio);
      if (q > h) continue;
      const shift = q - p;
      const peakSynPhase = this.prevSynPhase[q] + freq[p] * ratio * this.expct;
      const peakAnaPhase = phase[p];
      for (let k = lo; k <= hi; k++) {
        const j = k + shift;
        if (j < 0 || j > h) continue;
        const m = mag[k];
        synMag[j] += m;
        if (m > synOwner[j]) {
          synOwner[j] = m;
          synPhase[j] = peakSynPhase + (phase[k] - peakAnaPhase);
        }
      }
    }

    for (let k = 0; k <= h; k++) {
      if (synOwner[k] >= 0) {
        this.prevSynPhase[k] = wrapPhase(synPhase[k]);
      } else {
        this.prevSynPhase[k] = wrapPhase(this.prevSynPhase[k] + k * this.expct);
      }
      const m = synMag[k];
      const p = this.prevSynPhase[k];
      re[k] = m * Math.cos(p);
      im[k] = m * Math.sin(p);
    }
    // DC / Nyquist must be real for a real output signal.
    im[0] = 0;
    im[h] = 0;
    for (let k = 1; k < h; k++) {
      re[n - k] = re[k];
      im[n - k] = -im[k];
    }
    this.fft.transform(re, im, true);

    const g = this.olaGain;
    const acc = this.outAccum;
    for (let i = 0; i < n; i++) acc[i] += re[i] * win[i] * g;

    for (let i = 0; i < hop; i++) this.outFifo[i] = acc[i];
    acc.copyWithin(0, hop, 2 * n);
    acc.fill(0, 2 * n - hop);
    this.inFifo.copyWithin(0, hop, n);
    this.framesProcessed++;
  }
}

// Multi-channel wrapper with bypass / idle handling, shared by the AudioWorklet
// processor and the ScriptProcessor fallback.
export class MultiChannelPitchShifter {
  constructor(options = {}) {
    this.options = options;
    this.channels = [];
    this.semitones = 0;
    this.enabled = true;
    this.idleBlocks = 0;
    this.activeBlocks = 0;
    this.bypassBlocks = 0;
    this.resets = 0;
    this._silentRun = 0;
    this._processing = false;
  }

  get latencySamples() {
    return this._ensure(1)[0].latency;
  }

  _ensure(count) {
    while (this.channels.length < count) {
      const s = new PitchShifter(this.options);
      s.setSemitones(this.semitones);
      this.channels.push(s);
    }
    return this.channels;
  }

  setSemitones(semitones) {
    const st = clampSemitones(semitones);
    if (st !== this.semitones) {
      // Entering / leaving processing: flush so we never replay stale buffered audio.
      if ((st === 0) !== (this.semitones === 0)) this.reset();
      this.semitones = st;
    }
    for (const ch of this.channels) ch.setSemitones(st);
  }

  setEnabled(enabled) {
    if (enabled !== this.enabled) this.reset();
    this.enabled = !!enabled;
  }

  get isProcessing() {
    return this.enabled && this.semitones !== 0;
  }

  reset() {
    for (const ch of this.channels) ch.reset();
    this._silentRun = 0;
    this.resets++;
  }

  // inputs/outputs: arrays of Float32Array (one per channel).
  process(inputs, outputs) {
    const nOut = outputs.length;
    if (!this.isProcessing) {
      for (let c = 0; c < nOut; c++) {
        const src = inputs[Math.min(c, inputs.length - 1)];
        if (src) outputs[c].set(src); else outputs[c].fill(0);
      }
      this.bypassBlocks++;
      return;
    }

    let silent = inputs.length === 0;
    if (!silent) {
      silent = true;
      outer: for (const ch of inputs) {
        for (let i = 0; i < ch.length; i++) {
          if (ch[i] !== 0) { silent = false; break outer; }
        }
      }
    }
    // After enough silence to flush the pipeline, skip DSP entirely (paused video => ~0 CPU).
    if (silent) {
      this._silentRun += outputs[0] ? outputs[0].length : 128;
      const flushLen = this._ensure(1)[0].fftSize * 2;
      if (this._silentRun > flushLen) {
        for (const o of outputs) o.fill(0);
        this.idleBlocks++;
        return;
      }
    } else {
      this._silentRun = 0;
    }

    const shifters = this._ensure(nOut);
    for (let c = 0; c < nOut; c++) {
      const src = inputs.length ? inputs[Math.min(c, inputs.length - 1)] : null;
      if (src) shifters[c].process(src, outputs[c]);
      else {
        outputs[c].fill(0);
        shifters[c].process(outputs[c], outputs[c]);
      }
    }
    this.activeBlocks++;
  }
}
