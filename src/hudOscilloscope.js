/**
 * @module hudOscilloscope
 * @description Synthesized audio oscilloscope for the Intel HUD's top-right
 * corner. Radio streams are cross-origin, so a real Web Audio analyser would
 * taint the media element and mute playback; instead this renders a composed
 * waveform whose amplitude is gated by playback activity and scaled by the
 * effective volume. Idle playback settles the trace to a near-flat baseline.
 *
 * The draw loop only runs while the HUD is visible and the trace is active or
 * still settling, so an idle HUD costs a single frame rather than a standing
 * `requestAnimationFrame` loop.
 */

/** Faint baseline shimmer so an idle trace reads as "powered", not dead. */
const IDLE_RIPPLE = 0.05;
/** Per-frame easing toward the target amplitude (smooths start/stop). */
const LEVEL_EASE = 0.14;
/** Floor amplitude while active so a quiet station still shows motion. */
const ACTIVE_FLOOR = 0.3;
const DEFAULT_COLOR = 'rgba(0, 255, 255, 0.85)';
const DEFAULT_GLOW = 'rgba(0, 255, 255, 0.45)';

export class HudOscilloscope {
  /**
   * @param {object} options
   * @param {HTMLCanvasElement} options.canvas - Target canvas element.
   * @param {() => number} [options.now] - Monotonic clock in milliseconds.
   * @param {(cb: FrameRequestCallback) => number} [options.requestFrame]
   * @param {(id: number) => void} [options.cancelFrame]
   */
  constructor({
    canvas,
    now = () =>
      typeof performance !== 'undefined' ? performance.now() : Date.now(),
    requestFrame = typeof requestAnimationFrame !== 'undefined'
      ? (cb) => requestAnimationFrame(cb)
      : null,
    cancelFrame = typeof cancelAnimationFrame !== 'undefined'
      ? (id) => cancelAnimationFrame(id)
      : null,
  } = {}) {
    this._canvas = canvas || null;
    this._ctx =
      this._canvas && typeof this._canvas.getContext === 'function'
        ? this._canvas.getContext('2d')
        : null;
    this._now = now;
    this._requestFrame = requestFrame;
    this._cancelFrame = cancelFrame;
    this._active = false;
    this._targetLevel = 0;
    this._level = 0;
    this._visible = false;
    this._color = DEFAULT_COLOR;
    this._glow = DEFAULT_GLOW;
    this._rafId = null;
    this._cssW = 0;
    this._cssH = 0;
    this._dpr = 1;
    this._loop = this._loop.bind(this);
  }

  /**
   * Theme the trace to the active HUD color scheme.
   * @param {string} main - Stroke color.
   * @param {string} [glow] - Shadow/glow color (defaults to `main`).
   */
  setColor(main, glow) {
    if (main) this._color = main;
    this._glow = glow || main || this._glow;
    return this;
  }

  /**
   * Gate the loop on HUD visibility so a hidden HUD never animates.
   * @param {boolean} visible
   */
  setVisible(visible) {
    const next = Boolean(visible);
    if (next === this._visible) return this;
    this._visible = next;
    if (next) this._start();
    else this._stop();
    return this;
  }

  /**
   * Drive the trace from playback state.
   * @param {{active?: boolean, level?: number}} activity - `active` gates the
   *   waveform; `level` (0..1, typically the effective volume) scales it.
   */
  setAudioActivity({ active = false, level = 0 } = {}) {
    this._active = Boolean(active);
    const clamped = Math.max(0, Math.min(1, Number(level) || 0));
    this._targetLevel = this._active ? Math.max(ACTIVE_FLOOR, clamped) : 0;
    if (this._visible) this._start();
    return this;
  }

  _start() {
    if (!this._ctx || !this._requestFrame || this._rafId != null) return;
    this._rafId = this._requestFrame(this._loop);
  }

  _stop() {
    if (this._rafId != null && this._cancelFrame)
      this._cancelFrame(this._rafId);
    this._rafId = null;
  }

  _resize() {
    const canvas = this._canvas;
    const cssW = canvas.clientWidth || canvas.width || 140;
    const cssH = canvas.clientHeight || canvas.height || 34;
    const dpr =
      (typeof devicePixelRatio !== 'undefined' && devicePixelRatio) || 1;
    if (cssW === this._cssW && cssH === this._cssH && dpr === this._dpr) return;
    this._cssW = cssW;
    this._cssH = cssH;
    this._dpr = dpr;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }

  _loop() {
    this._rafId = null;
    if (!this._ctx || !this._visible) return;
    this._resize();
    this._level += (this._targetLevel - this._level) * LEVEL_EASE;
    if (this._level < 0.001) this._level = 0;
    this.draw();
    // Keep animating while visible AND active or still easing to the baseline.
    if (this._requestFrame && (this._active || this._level > 0)) {
      this._rafId = this._requestFrame(this._loop);
    }
  }

  /** Render one frame of the composed waveform. */
  draw() {
    const ctx = this._ctx;
    if (!ctx) return;
    const w = this._canvas.width;
    const h = this._canvas.height;
    const dpr = this._dpr;
    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const amp = this._level * (h / 2 - 2 * dpr) + IDLE_RIPPLE * dpr;
    const t = this._now() / 1000;
    const steps = Math.max(24, Math.floor(this._cssW || w));
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeStyle = this._color;
    ctx.shadowColor = this._glow;
    ctx.shadowBlur = 6 * dpr * (0.4 + this._level);
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const x = u * w;
      const phase = u * Math.PI * 2 * 3;
      let s = Math.sin(phase + t * 6);
      s += 0.5 * Math.sin(phase * 2.3 + t * 9.1);
      s += 0.25 * Math.sin(phase * 5.3 + t * 15.7);
      s *= 0.5;
      s += (this._noise(i, t) - 0.5) * 0.3 * this._level;
      const y = mid - s * amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /** Deterministic pseudo-noise so the trace jitters without a PRNG. */
  _noise(i, t) {
    const n = Math.sin(i * 12.9898 + t * 78.233) * 43758.5453;
    return n - Math.floor(n);
  }

  /** Stop the loop and release the canvas. */
  destroy() {
    this._stop();
    this._visible = false;
    this._active = false;
    if (this._ctx && this._canvas) {
      try {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
      } catch {
        /* a detached canvas can throw; teardown continues regardless */
      }
    }
    this._ctx = null;
    this._canvas = null;
  }
}
