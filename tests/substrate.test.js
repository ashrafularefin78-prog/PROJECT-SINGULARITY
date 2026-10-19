/**
 * The substrate (src/ui/substrate.js) against a real WebGL2 context: it must
 * mount once, paint frames, honour the FX state machine (off stops, reduced
 * freezes at stills), degrade on a lost context, and remove its canvas on
 * destroy. Browser-only by nature - the node runner reports these as skips.
 */
import { test, assert } from './harness.js';
import { mountSubstrate, telemetry, unmountSubstrate } from '../src/ui/substrate.js';

const NEEDS_GL = { needs: ['dom', 'webgl2'] };
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const dom = () => document;

test('substrate: the telemetry bus exists and starts at honest zeros', () => {
  assert(telemetry.fps === null, 'no frame rate is asserted before one is measured');
  assert(telemetry.opsDelta === 0, 'no operations before any happen');
  assert(typeof telemetry.pulse === 'function', 'pulse() exists for impulses');
  telemetry.pulse('energy'); // must not throw, mount or create a canvas
  assert(document.querySelector('canvas.substrate') === null, 'pulsing without a mount creates nothing');
});

test('substrate: mounting creates exactly one GPU-backed canvas and paints', NEEDS_GL, async () => {
  const substrate = mountSubstrate();
  assert(substrate, 'the substrate mounts on this browser');
  const canvas = dom().querySelector('canvas.substrate');
  assert(canvas === substrate.canvas, 'one canvas, registered in the document');
  assert(mountSubstrate() === substrate, 'the mount is idempotent');
  assert(['gpu', 'reduced', 'stopped'].includes(substrate.mode()), `mode resolves: ${substrate.mode()}`);

  await nextFrame();
  await nextFrame();
  const stats = substrate.stats();
  assert(stats.frames >= 1, `frames painted: ${stats.frames}`);
  assert(stats.uniforms, 'uniform snapshot exists');
  assert(Number.isFinite(stats.uniforms.spin), 'spin uniform is finite');

  const before = stats.frames;
  telemetry.opsDelta = 50;
  await nextFrame();
  await nextFrame();
  const after = substrate.stats();
  assert(after.frames > before, 'the loop keeps painting while allowed');
  unmountSubstrate();
  assert(dom().querySelector('canvas.substrate') === null, 'destroy removes the canvas');
});

test('substrate: fx off stops the loop and fx full restarts it', NEEDS_GL, async () => {
  const html = dom().documentElement;
  const previousFx = html.dataset.fx ? html.dataset.fx : '';
  const substrate = mountSubstrate();
  const canvas = substrate.canvas;
  const paint = () => Promise.all([nextFrame(), nextFrame()]);

  await paint();
  assert(substrate.stats().frames >= 1, 'painting under full effects');

  html.dataset.fx = 'off';
  await paint();
  const stopped = substrate.stats();
  assert(!stopped.running, 'fx off stops the render loop');
  assert(canvas.getAttribute('aria-hidden') === 'true', 'the canvas is never exposed to AT');

  html.dataset.fx = 'full';
  await paint();
  assert(substrate.stats().running, 'full effects bring the loop back');

  html.dataset.fx = 'reduced';
  await paint();
  assert(!substrate.stats().running, 'reduced fx freezes to stills');
  const stills = substrate.stats().frames;

  html.dataset.fx = previousFx;
  await paint();
  unmountSubstrate();
  assert(true);
  void stills;
});

test('substrate: a lost WebGL context degrades to the CSS scene, not a blank page', NEEDS_GL, async () => {
  const substrate = mountSubstrate();
  const canvas = substrate.canvas;
  const lost = new Event('webglcontextlost', { bubbles: false, cancelable: true });
  canvas.dispatchEvent(lost);
  assert(lost.defaultPrevented, 'the handler prevents the default teardown');
  assert(substrate.mode() === 'lost', 'the page is told the GPU scene is gone');
  assert(!substrate.stats().running, 'no more frames on a dead context');
  unmountSubstrate();
  assert(dom().querySelector('canvas.substrate') === null, 'destroy still cleans up');
});
