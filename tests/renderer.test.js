import { test, assert, assertEquals } from './harness.js';
import {
  cross3,
  identity,
  lookAt,
  mat4,
  mulberry32,
  multiply,
  normalize3,
  ortho,
  perspective,
  transformPoint,
} from '../src/graphics/math.js';
import { MAX_INSTANCES, MAX_PARTICLES, Renderer } from '../src/graphics/renderer.js';

test('M3: identity leaves a point untouched and multiply respects order', () => {
  const id = identity();
  const p = transformPoint(id, [1, 2, 3]);
  assertEquals(p.join(','), '1,2,3');

  const scale2 = mat4();
  scale2[0] = 2;
  scale2[5] = 2;
  scale2[10] = 2;
  const translate = identity();
  translate[12] = 5;
  const both = multiply(mat4(), scale2, translate); // a * b: b applies first
  assertEquals(transformPoint(both, [1, 0, 0]).join(','), '12,0,0', 'translate first, then scale');
  const swapped = multiply(mat4(), translate, scale2);
  assertEquals(transformPoint(swapped, [1, 0, 0]).join(','), '7,0,0', 'scale first, then translate');
});

test('M3: perspective maps the near and far planes onto the clip range', () => {
  const proj = perspective(mat4(), Math.PI / 2, 1, 1, 101);
  const near = transformPoint(proj, [0, 0, -1]);
  const far = transformPoint(proj, [0, 0, -101]);
  assert(Math.abs(near[2] + 1) < 1e-5, `near should map to -1, got ${near[2]}`);
  assert(Math.abs(far[2] - 1) < 1e-5, `far should map to +1, got ${far[2]}`);
});

test('M3: lookAt places the eye at the origin looking down -Z', () => {
  const view = lookAt(mat4(), [0, 0, 5], [0, 0, 0], [0, 1, 0]);
  const origin = transformPoint(view, [0, 0, 0]);
  assertEquals(origin.map((v) => Math.round(v)).join(','), '0,0,-5');
  const up = transformPoint(view, [0, 1, 0]);
  assertEquals(up.map((v) => Math.round(v)).join(','), '0,1,-5', 'Y must stay up');
});

test('M3: the orthographic light matrix maps the scene into the 0..1 shadow range', () => {
  const lightProj = ortho(mat4(), -60, 60, -60, 60, 1, 200);
  const lightView = lookAt(mat4(), [0, 50, 40], [0, 0, 0], [0, 1, 0]);
  const lightViewProj = multiply(mat4(), lightProj, lightView);
  const centre = transformPoint(lightViewProj, [0, 0, 0]);
  const uv = [centre[0] * 0.5 + 0.5, centre[1] * 0.5 + 0.5];
  assert(Math.abs(uv[0] - 0.5) < 1e-5, `shadow u should be 0.5, got ${uv[0]}`);
  assert(Math.abs(uv[1] - 0.5) < 1e-5, `shadow v should be 0.5, got ${uv[1]}`);
});

test('M3: vector helpers are correct', () => {
  assertEquals(normalize3([0, 3, 4]).join(','), '0,0.6,0.8');
  assertEquals(cross3([1, 0, 0], [0, 1, 0]).join(','), '0,0,1');
});

test('M3: the scene layout generator is deterministic', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 5; i += 1) assertEquals(a(), b(), 'same seed must give same sequence');
  const c = mulberry32(43);
  assert(mulberry32(42)() !== c(), 'different seeds should diverge');
});

// The four tests below need a real canvas and a real WebGL2 context; they are
// skipped (not failed) under bare Node and always run in the browser suite.
const NEEDS_GL = { needs: ['dom', 'webgl2'] };

test('M3: WebGL2 is available in this browser', () => {
  assert(Renderer.isSupported(), 'WebGL2 context could not be created');
}, NEEDS_GL);

test('M3: the renderer initialises, instances and describes the scene', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  const renderer = new Renderer(canvas, { instances: 500, particles: 1024, shadows: true });
  const info = renderer.init();
  assertEquals(info.api, 'WebGL2');
  assertEquals(info.instances, 500);
  assert(info.maxTextureSize > 0, 'should report GPU limits');
  assert(/WebGL/i.test(info.glVersion), info.glVersion);

  renderer.resize();
  renderer.frame(16);
  renderer.frame(32);
  const stats = renderer.stats();
  assertEquals(stats.instances, 500);
  assertEquals(stats.particles, 1024);
  assert(stats.drawCalls >= 3, 'shadow + ground + objects + particles: ' + stats.drawCalls);
  assert(stats.triangles > 500 * 12, 'triangle count should reflect instancing');

  const description = renderer.describeScene();
  assert(/500 instanced cubes/.test(description.summary), description.summary);
  assertEquals(description.objects.length, 3);
  assert(description.camera.includes('distance'), description.camera);
}, NEEDS_GL);

test('M3: instance and particle counts are clamped to the engine limits', () => {
  const canvas = document.createElement('canvas');
  const renderer = new Renderer(canvas, {});
  assertEquals(renderer.setInstances(10 ** 9), MAX_INSTANCES);
  assertEquals(renderer.setInstances(-5), 0);
  assertEquals(renderer.setParticles(10 ** 9), MAX_PARTICLES);
  assertEquals(renderer.setParticles(-1), 0);
}, { needs: 'dom' });

test('M3: shadows can be toggled and the camera orbits within limits', () => {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const renderer = new Renderer(canvas, { instances: 0, particles: 0 });
  renderer.init();
  assertEquals(renderer.setShadows(false), false);
  renderer.orbit(1, 99, -9999);
  const stats = renderer.stats();
  assert(stats.camera.elevation <= 1.35, 'elevation must clamp');
  assert(stats.camera.distance >= 14, 'distance must clamp');
}, NEEDS_GL);

test('M3: a missing WebGL2 context fails loudly instead of silently', () => {
  const fake = {
    getContext: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    width: 10,
    height: 10,
  };
  const renderer = new Renderer(fake, {});
  let message = '';
  try {
    renderer.init();
  } catch (err) {
    message = err.message;
  }
  assert(/WebGL2 is not available/.test(message), message || 'expected init to throw');
});
