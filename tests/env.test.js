/**
 * The procedural sky behind the M3 image-based lighting, proven without a GPU:
 * src/graphics/env.js is pure math until the renderer uploads its output, so
 * these tests pin the contract the shaders consume:
 *
 *   - the band-2 SH basis keeps L00 constant and the convolution constant is
 *     exactly the one env.js documents (constant sky of radiance R -> R)
 *   - the projected L00 equals the sky's mean radiance, and the projection is
 *     deterministic
 *   - the cube layouts follow the GL cube-map selection table, so a face flip
 *     breaks the test instead of quietly mirroring the scene
 *   - the irradiance cube reproduces irradiance() and the env cube reproduces
 *     skyRadiance() at face centres, within one 8-bit step
 *   - noiseTexture is deterministic, opaque, bounded and seeded (and calling it
 *     must not throw: it used to reference an undefined `lerp` variable)
 */
import { test, assert, assertEquals } from './harness.js';
import {
  envCube,
  irradiance,
  irradianceCube,
  noiseTexture,
  shBasis,
  shProject,
  skyRadiance,
} from '../src/graphics/env.js';

const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);
const norm = (d) => {
  const len = Math.hypot(...d) || 1;
  return d.map((v) => v / len);
};

/** The GL cube-map selection table, duplicated deliberately: a layout change
 *  in env.js must break these tests rather than be absorbed by them. */
function faceDirection(face, sc, tc) {
  switch (face) {
    case 0: return [1, -tc, -sc];
    case 1: return [-1, -tc, sc];
    case 2: return [sc, 1, tc];
    case 3: return [sc, -1, tc];
    case 4: return [sc, -tc, 1];
    case 5: return [-sc, -tc, -1];
    default: throw new Error(`cube face ${face} out of range`);
  }
}

const texel = (cube, face, row, col, channel) =>
  cube.data[(face * cube.size * cube.size + row * cube.size + col) * 4 + channel];

test('env: skyRadiance is deterministic, finite and never negative', () => {
  const first = skyRadiance([0.3, 0.7, -0.2]);
  const second = skyRadiance([0.3, 0.7, -0.2]);
  assertEquals(first.join(','), second.join(','), 'same direction, same light');
  for (const d of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.6, 0.1, 0.8], [-1, 1, 1]]) {
    for (const v of skyRadiance(d)) {
      assert(Number.isFinite(v) && v >= 0, `radiance ${v} for ${d.join(',')}`);
    }
  }
});

test('env: shBasis keeps the L00 band constant and every band finite', () => {
  for (const d of [[0, 1, 0], [0.577, 0.577, 0.577], [-0.8, 0.2, 0.566]]) {
    const b = shBasis(...norm(d));
    assertEquals(b.length, 9);
    assertEquals(b[0].toFixed(6), '0.282095', 'L00 is the constant band');
    for (const v of b) assert(Number.isFinite(v), 'basis value finite');
  }
});

test('env: a constant sky of radiance R convolves to exactly R', () => {
  // The documented normalisation: L00 = R / (A0 * c0), all higher bands zero.
  // This is the invariant env.js's own header promises ("must return exactly
  // R, which the tests assert").
  const A0 = Math.PI;
  const c0 = 0.2820948;
  const R = 0.37;
  const coeffs = new Float32Array(27);
  coeffs[0] = coeffs[1] = coeffs[2] = R / (A0 * c0);
  for (const n of [[0, 1, 0], [0, -1, 0], [0.577, 0.577, 0.577], [0.2, -0.9, 0.38]]) {
    const out = irradiance(coeffs, norm(n));
    for (let c = 0; c < 3; c += 1) near(out[c], R, 1e-5, `irradiance[${c}] at ${n.join(',')}`);
  }
});

test('env: shProject returns 27 finite coefficients and is deterministic', () => {
  const a = shProject();
  const b = shProject();
  assertEquals(a.length, 27);
  for (let i = 0; i < 27; i += 1) {
    assert(Number.isFinite(a[i]), `coefficient ${i} finite`);
    assertEquals(a[i], b[i], `coefficient ${i} deterministic`);
  }
  assert(a.some((v) => v !== 0), 'the projected sky is not the zero function');
});

test('env: the projected L00 equals the sky mean radiance', () => {
  // L00 = sqrt(4*pi) * mean(skyRadiance). Both sides are estimated on
  // independent Fibonacci grids of the same deterministic function, so they
  // agree up to the sampling error of the smoother of the two.
  const l00 = shProject()[0];
  const samples = 16384;
  const golden = 2.39996323;
  let sum = 0;
  for (let i = 0; i < samples; i += 1) {
    const y = 1 - ((2 * i + 1) / samples);
    const r = Math.sqrt(1 - y * y);
    const ang = i * golden;
    sum += skyRadiance([Math.cos(ang) * r, y, Math.sin(ang) * r])[0];
  }
  const mean = sum / samples;
  const implied = l00 / Math.sqrt(4 * Math.PI);
  near(implied, mean, mean * 0.05, 'L00/sqrt(4pi) vs brute-force mean red channel');
});

test('env: the env cube reproduces skyRadiance at its face centres', () => {
  const cube = envCube(16);
  assertEquals(cube.data.length, 6 * 16 * 16 * 4);
  const centre = Math.floor(16 / 2);
  const sc = (2 * (centre + 0.5)) / 16 - 1;
  for (const face of [0, 2, 4, 5]) {
    const d = norm(faceDirection(face, sc, sc));
    const expected = skyRadiance(d);
    const r = texel(cube, face, centre, centre, 0) / 255;
    const g = texel(cube, face, centre, centre, 1) / 255;
    const b = texel(cube, face, centre, centre, 2) / 255;
    near(r, expected[0], 1 / 255 + 0.002, `face ${face} red`);
    near(g, expected[1], 1 / 255 + 0.002, `face ${face} green`);
    near(b, expected[2], 1 / 255 + 0.002, `face ${face} blue`);
    assertEquals(texel(cube, face, centre, centre, 3), 255, `face ${face} alpha opaque`);
  }
});

test('env: the irradiance cube reproduces irradiance() at its face centres', () => {
  const coeffs = shProject();
  const cube = irradianceCube(coeffs, 8);
  assertEquals(cube.data.length, 6 * 8 * 8 * 4);
  const centre = 4;
  const sc = (2 * (centre + 0.5)) / 8 - 1;
  for (const face of [0, 2, 4]) {
    const d = norm(faceDirection(face, sc, sc));
    const expected = irradiance(coeffs, d);
    near(texel(cube, face, centre, centre, 0) / 255, expected[0], 1 / 255 + 0.002, `face ${face} red`);
    near(texel(cube, face, centre, centre, 1) / 255, expected[1], 1 / 255 + 0.002, `face ${face} green`);
    near(texel(cube, face, centre, centre, 2) / 255, expected[2], 1 / 255 + 0.002, `face ${face} blue`);
  }
});

test('env: projected irradiance is finite, non-negative and direction-dependent', () => {
  const coeffs = shProject();
  const up = irradiance(coeffs, [0, 1, 0]);
  const down = irradiance(coeffs, [0, -1, 0]);
  const side = irradiance(coeffs, [1, 0, 0]);
  for (const out of [up, down, side]) {
    for (const v of out) {
      assert(Number.isFinite(v) && v >= 0, `irradiance ${v} must be finite and non-negative`);
    }
  }
  const spread = Math.max(up[0], down[0], side[0]) - Math.min(up[0], down[0], side[0]);
  assert(spread > 1e-4, `the sky is not a constant: up=${up[0].toFixed(4)} down=${down[0].toFixed(4)} side=${side[0].toFixed(4)}`);
});

test('env: noiseTexture is deterministic, opaque, bounded and seeded', () => {
  // Regression: this used to throw ReferenceError on an undefined `lerp`.
  const a = noiseTexture(64, 0x5eed);
  const b = noiseTexture(64, 0x5eed);
  assertEquals(a.size, 64);
  assertEquals(a.data.length, 64 * 64 * 4);
  for (let i = 0; i < a.data.length; i += 4) {
    assertEquals(a.data[i + 3], 255, 'alpha opaque');
    assert(a.data[i] >= 0 && a.data[i] <= 255, 'byte in range');
  }
  assertEquals(Array.from(a.data).join(','), Array.from(b.data).join(','), 'same seed, same noise');
  const c = noiseTexture(64, 0xbeef);
  let different = 0;
  for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== c.data[i]) different += 1;
  assert(different > 1000, `different seeds must differ (${different} differing bytes)`);
});
