// The HUD oscilloscope renders a synthesized waveform rather than tapping the
// radio's media element (the streams are cross-origin, so a real analyser would
// taint the element and mute playback). These tests pin the observable
// contract: the trace stays flat while idle, swells under active playback, only
// animates while visible, and stops cleanly on teardown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HudOscilloscope } from './hudOscilloscope.js';

/** A hand-cranked rAF scheduler so frames advance deterministically. */
function scheduler() {
  let id = 0;
  const pending = new Map();
  return {
    request(cb) {
      const i = ++id;
      pending.set(i, cb);
      return i;
    },
    cancel(i) {
      pending.delete(i);
    },
    flush(n = 1) {
      for (let k = 0; k < n; k++) {
        const entries = [...pending.values()];
        pending.clear();
        for (const cb of entries) cb();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

/** A canvas/context stub that records the y of every traced point. */
function fakeCanvas() {
  const ys = [];
  const ctx = {
    strokeStyle: null,
    lineWidth: 0,
    shadowColor: null,
    shadowBlur: 0,
    clearRect() {},
    beginPath() {
      ys.length = 0;
    },
    moveTo(_x, y) {
      ys.push(y);
    },
    lineTo(_x, y) {
      ys.push(y);
    },
    stroke() {},
  };
  const canvas = {
    width: 0,
    height: 0,
    clientWidth: 140,
    clientHeight: 30,
    getContext: () => ctx,
  };
  return { canvas, ctx, ys };
}

const spread = (ys) => Math.max(...ys) - Math.min(...ys);

function build() {
  const sched = scheduler();
  const { canvas, ctx, ys } = fakeCanvas();
  const scope = new HudOscilloscope({
    canvas,
    now: () => 0,
    requestFrame: (cb) => sched.request(cb),
    cancelFrame: (id) => sched.cancel(id),
  });
  return { scope, sched, ctx, ys };
}

test('an idle, visible trace settles flat and stops animating', () => {
  const { scope, sched, ys } = build();
  scope.setVisible(true);
  sched.flush(1);
  assert.ok(spread(ys) < 1, 'idle trace is essentially a flat line');
  assert.equal(sched.size, 0, 'an idle trace must not hold an rAF loop open');
});

test('active playback swells the trace and keeps the loop running', () => {
  const { scope, sched, ys } = build();
  scope.setVisible(true);
  scope.setAudioActivity({ active: true, level: 1 });
  sched.flush(30);
  assert.ok(spread(ys) > 5, 'an active trace draws a tall waveform');
  assert.ok(sched.size >= 1, 'active playback keeps requesting frames');
});

test('clearing playback eases the trace back to flat', () => {
  const { scope, sched, ys } = build();
  scope.setVisible(true);
  scope.setAudioActivity({ active: true, level: 1 });
  sched.flush(30);
  scope.setAudioActivity({ active: false });
  sched.flush(60);
  assert.ok(spread(ys) < 1, 'the trace flatlines after playback stops');
  assert.equal(sched.size, 0, 'a settled idle trace releases the loop');
});

test('a hidden HUD never animates even while audio plays', () => {
  const { scope, sched } = build();
  scope.setAudioActivity({ active: true, level: 1 });
  assert.equal(sched.size, 0, 'no frame is scheduled while hidden');
  scope.setVisible(false);
  assert.equal(sched.size, 0, 'hiding again schedules nothing');
});

test('setColor themes the stroke used by the next frame', () => {
  const { scope, sched, ctx } = build();
  scope.setColor('rgba(255, 170, 0, 0.8)');
  scope.setVisible(true);
  sched.flush(1);
  assert.equal(ctx.strokeStyle, 'rgba(255, 170, 0, 0.8)');
});

test('destroy stops the loop and releases the canvas', () => {
  const { scope, sched } = build();
  scope.setVisible(true);
  scope.setAudioActivity({ active: true, level: 1 });
  sched.flush(3);
  assert.ok(sched.size >= 1, 'loop is live before teardown');
  scope.destroy();
  assert.equal(sched.size, 0, 'destroy cancels the pending frame');
  sched.flush(3);
  assert.equal(sched.size, 0, 'a destroyed scope never reschedules');
});
