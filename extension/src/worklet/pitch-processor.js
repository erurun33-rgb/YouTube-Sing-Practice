// AudioWorkletProcessor wrapping the shared DSP core.
// Loaded via audioWorklet.addModule(chrome.runtime.getURL(...)); relative imports
// resolve against the extension URL, so the DSP code ships inside the package
// (no remote code, Chrome Web Store compliant).
import { MultiChannelPitchShifter } from '../dsp/pitch-shifter.js';

const STATS_INTERVAL_FRAMES = sampleRate; // ~1s

class YspPitchProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.dsp = new MultiChannelPitchShifter({ fftSize: opts.fftSize || 2048 });
    this.framesSinceStats = 0;
    this.maxBlockMs = 0;
    this.hasClock = typeof globalThis.performance !== 'undefined' && typeof performance.now === 'function';
    this.port.onmessage = (e) => this.onMessage(e.data || {});
    this.port.postMessage({ type: 'ready', latencySamples: this.dsp.latencySamples, sampleRate });
  }

  onMessage(msg) {
    switch (msg.type) {
      case 'setSemitones': this.dsp.setSemitones(msg.value); break;
      case 'setEnabled': this.dsp.setEnabled(!!msg.value); break;
      case 'reset': this.dsp.reset(); break;
      default: break;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0];
    const t0 = this.hasClock ? performance.now() : 0;
    this.dsp.process(input, output);
    if (this.hasClock) {
      const dt = performance.now() - t0;
      if (dt > this.maxBlockMs) this.maxBlockMs = dt;
    }
    this.framesSinceStats += output[0] ? output[0].length : 128;
    if (this.framesSinceStats >= STATS_INTERVAL_FRAMES) {
      const d = this.dsp;
      this.port.postMessage({
        type: 'stats',
        activeBlocks: d.activeBlocks,
        idleBlocks: d.idleBlocks,
        bypassBlocks: d.bypassBlocks,
        resets: d.resets,
        semitones: d.semitones,
        enabled: d.enabled,
        channels: output.length,
        maxBlockMs: this.hasClock ? this.maxBlockMs : null,
      });
      this.framesSinceStats = 0;
      this.maxBlockMs = 0;
    }
    return true;
  }
}

registerProcessor('ysp-pitch-processor', YspPitchProcessor);
