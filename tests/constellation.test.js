/**
 * The system constellation, proven without a browser.
 *
 * The point of splitting the module into pure geometry, a pure state model and
 * a `paint` that takes any context-shaped object is exactly this file: the
 * picture is checked by numbers and by recorded draw calls, not by looking at
 * it once and hoping.
 *
 *   - the ring is equidistant, starts at 12 o'clock and honours its radius
 *   - the active panel wins over the scorecard's status word
 *   - a model never invents a reading it was not given (fps/heap stay null)
 *   - throughput saturates instead of running off the end of the scale
 *   - the text alternative says the same thing the picture does
 *   - paint draws every node, labels each one, and stays silent on a zero-size
 *     canvas (which is what a hidden panel hands it)
 */
import { test, assert, assertEquals } from './harness.js';
import {
  ring,
  buildModel,
  modelNodes,
  describe,
  paint,
  mountConstellation,
  PANEL_MODULE,
  STATES,
} from '../src/ui/constellation.js';

const MODULES = [
  { id: 'M1', status: 'ok', points: 87 },
  { id: 'M2', status: 'partial', points: 74 },
  { id: 'M3', status: 'ok', points: 87 },
];

/** A 2D context that records what was asked of it, so paint can be asserted. */
function recordingContext() {
  const calls = [];
  const ctx = { calls };
  for (const name of [
    'clearRect',
    'save',
    'restore',
    'translate',
    'beginPath',
    'arc',
    'ellipse',
    'moveTo',
    'lineTo',
    'stroke',
    'fill',
    'fillText',
    'setTransform',
  ]) {
    ctx[name] = (...args) => calls.push({ name, args });
  }
  return ctx;
}

test('constellation: the ring is equidistant, starts at the top and honours its radius', () => {
  const points = ring(8, 100);
  assertEquals(points.length, 8);
  const first = points[0];
  assert(Math.abs(first.x) < 1e-9, `first point sits on the vertical axis: x=${first.x}`);
  assert(Math.abs(first.y + 100) < 1e-9, `first point is 12 o'clock: y=${first.y}`);
  // Every point is the same distance from the centre, which is what "ring" means.
  for (const p of points) {
    assert(Math.abs(Math.hypot(p.x, p.y) - 100) < 1e-9, `radius preserved: ${Math.hypot(p.x, p.y)}`);
  }
  // Even spacing: consecutive gaps are all one eighth of a turn.
  for (let i = 1; i < points.length; i += 1) {
    const gap = points[i].angle - points[i - 1].angle;
    assert(Math.abs(gap - (Math.PI * 2) / 8) < 1e-9, `even spacing: ${gap}`);
  }
});

test('constellation: a ring of zero or a nonsense count draws nothing at all', () => {
  assertEquals(ring(0, 10).length, 0);
  assertEquals(ring(-3, 10).length, 0);
  assertEquals(ring(Number.NaN, 10).length, 0);
});

test('constellation: the open panel wins over the scorecard status word', () => {
  const idle = modelNodes('dashboard', MODULES);
  assertEquals(idle.map((n) => n.state).join(','), 'ok,partial,ok');
  const open = modelNodes('compiler', MODULES);
  assertEquals(open[1].state, 'active', 'M2 is drawn as active while its panel is open');
  assertEquals(open[0].state, 'ok', 'the others keep their own status');
  // Every panel id in the table maps to a real scorecard row or to the shell.
  assertEquals(PANEL_MODULE.engine, 'M3');
  assertEquals(PANEL_MODULE.dashboard, null);
});

test('constellation: a model never invents a reading it was not given', () => {
  const model = buildModel({ activePanel: 'editor', modules: MODULES });
  assertEquals(model.fps, null, 'no renderer means no frame rate, not zero');
  assertEquals(model.heapMiB, null, 'no performance.memory means no heap, not zero');
  assert(STATES.active && STATES.ok && STATES.partial, 'every state has a colour');
});

test('constellation: throughput saturates and a large peer count is reported, not drawn', () => {
  assertEquals(buildModel({ modules: MODULES, opsDelta: 0 }).activity, 0);
  assertEquals(buildModel({ modules: MODULES, opsDelta: 10 }).activity, 0.5);
  assertEquals(buildModel({ modules: MODULES, opsDelta: 20 }).activity, 1);
  assertEquals(buildModel({ modules: MODULES, opsDelta: 500 }).activity, 1, 'clamped, never > 1');

  const crowd = buildModel({ modules: MODULES, peers: 40 });
  assertEquals(crowd.peers, 12, 'the ring caps at twelve drawable peers');
  assertEquals(crowd.peerCount, 40, 'the real count survives in the text alternative');
});

test('constellation: the text alternative says what the picture says', () => {
  const text = describe(
    buildModel({ activePanel: 'editor', modules: MODULES, peers: 2, opsDelta: 4, fps: 60, heapMiB: 2.44 }),
  );
  assert(text.includes('M1 is open'), `names the open module: ${text}`);
  assert(text.includes('2 of 3 modules report full'), `counts the full modules: ${text}`);
  assert(text.includes('1 report partial'), `counts the partial ones: ${text}`);
  assert(text.includes('2 peers'), `reports the peer count: ${text}`);
  assert(text.includes('60 frames per second'), `reports the frame rate: ${text}`);
  assert(text.includes('2.4 mebibytes'), `reports the heap to one decimal: ${text}`);
  assert(text.includes('4 document operations'), `reports throughput: ${text}`);
  // Singular/plural must not read as a bug.
  assert(describe(buildModel({ modules: MODULES, peers: 1, opsDelta: 1 })).includes('1 peer on the mesh'));
});

test('constellation: paint draws an arc per node and labels each one', () => {
  const ctx = recordingContext();
  paint(ctx, buildModel({ activePanel: 'editor', modules: MODULES, peers: 2, opsDelta: 5 }), 1234, {
    width: 640,
    height: 320,
  });
  const names = ctx.calls.map((c) => c.name);
  assert(names.includes('clearRect'), 'the frame starts by clearing');
  assert(names.includes('translate'), 'the drawing is centred on the canvas');
  const labels = ctx.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
  assertEquals(labels.sort().join(','), 'M1,M2,M3', 'every node is labelled with its module id');
  // Three edges plus the core, two orbits and the satellites: arcs are abundant.
  assert(ctx.calls.filter((c) => c.name === 'arc').length >= 7, 'arcs were drawn');
});

test(
  'constellation: the mounted canvas names itself and survives teardown',
  () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    document.body.append(canvas);
    const view = mountConstellation(canvas, { reducedMotion: true });
    assert(view, 'mount returns a controller against a real 2D context');
    view.update({ activePanel: 'editor', modules: MODULES, peers: 3 });
    const label = canvas.getAttribute('aria-label');
    assert(label.includes('M1 is open'), `the text alternative is live: ${label}`);
    assert(label.includes('3 peers'), 'the peer count reaches assistive technology');
    // start() under reduced motion must paint once and schedule no loop.
    view.start();
    assertEquals(view.model.peers, 3);
    view.destroy();
    canvas.remove();
  },
  { needs: 'dom' },
);

test('constellation: a zero-size canvas (a hidden panel) paints nothing and cannot throw', () => {
  const ctx = recordingContext();
  paint(ctx, buildModel({ modules: MODULES }), 0, { width: 0, height: 0 });
  assertEquals(ctx.calls.length, 0, 'no draw calls against a canvas with no area');
  // And the model with no modules at all must not divide by zero.
  paint(ctx, buildModel({ modules: [] }), 0, { width: 100, height: 100 });
  assert(ctx.calls.length > 0, 'an empty module list still paints the core');
});
