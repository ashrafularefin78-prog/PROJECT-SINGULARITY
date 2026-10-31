/**
 * The split-sum BRDF integration (src/graphics/brdf.js), proven without a GPU.
 * These tests pin the numbers the PBR shaders rely on:
 *
 *   - the integral is bounded (energy conservation) and deterministic
 *   - the smooth, head-on case converges to (1, 0), as the analytic limit says
 *   - the LUT has the documented (n·v, roughness) layout and finite texels
 *   - half-float encoding round-trips and rounds ties to even
 */
import { test, assert, assertEquals } from './harness.js';
import { brdfLutData, integrateBRDF, toHalfFloat } from '../src/graphics/brdf.js';

const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

test('brdf: the split-sum integral stays in its physical bounds', () => {
  for (const ndotv of [0.05, 0.25, 0.5, 0.75, 1]) {
    for (const roughness of [0.05, 0.25, 0.5, 0.75, 1]) {
      const [scale, bias] = integrateBRDF(ndotv, roughness);
      assert(Number.isFinite(scale) && Number.isFinite(bias), `finite at ${ndotv}/${roughness}`);
      assert(scale >= -1e-6 && scale <= 1.000001, `scale in [0,1] at ${ndotv}/${roughness}: ${scale}`);
      assert(bias >= -1e-6 && bias <= 1.000001, `bias in [0,1] at ${ndotv}/${roughness}: ${bias}`);
      assert(scale + bias <= 1.000001, `energy conserved at ${ndotv}/${roughness}: ${scale + bias}`);
    }
  }
});

test('brdf: the mirror-smooth head-on case converges to scale 1 and bias 0', () => {
  const [scale, bias] = integrateBRDF(1, 0.001, 512);
  near(scale, 1, 2e-3, 'scale approaches one');
  near(bias, 0, 2e-3, 'bias approaches zero');
});

test('brdf: the integral is deterministic and rises with the view angle', () => {
  const a = integrateBRDF(0.35, 0.6);
  const b = integrateBRDF(0.35, 0.6);
  assertEquals(a.join(','), b.join(','), 'same input, same output');
  const grazing = integrateBRDF(0.2, 0.5)[0];
  const headOn = integrateBRDF(0.95, 0.5)[0];
  assert(grazing < headOn, `scale rises with n·v: ${grazing} < ${headOn}`);
});

test('brdf: LUT data uses the documented row-major (n·v, roughness) layout', () => {
  const size = 8;
  const data = brdfLutData(size, 32);
  assertEquals(data.length, size * size * 2, 'two floats per texel');
  for (const value of data) assert(Number.isFinite(value) && value >= 0 && value <= 1, `finite texel ${value}`);
  // The first texel corresponds to the lowest n·v and lowest roughness, the
  // last one to the highest n·v at full roughness.
  const [lowScale, lowBias] = integrateBRDF(0.5 / size, 0.5 / size, 32);
  near(data[0], lowScale, 1e-7, 'first scale');
  near(data[1], lowBias, 1e-7, 'first bias');
  const at = (size * size - 1) * 2;
  const [highScale] = integrateBRDF((size - 0.5) / size, (size - 0.5) / size, 32);
  near(data[at], highScale, 1e-7, 'last scale');
});

test('brdf: half-float encoding matches IEEE 754 binary16', () => {
  assertEquals(toHalfFloat(0), 0x0000);
  assertEquals(toHalfFloat(1), 0x3c00);
  assertEquals(toHalfFloat(-0.5), 0xb800);
  assertEquals(toHalfFloat(2), 0x4000);
  assertEquals(toHalfFloat(65504), 0x7bff);
  assertEquals(toHalfFloat(100000), 0x7c00, 'overflow becomes infinity');
  assertEquals(toHalfFloat(1e-8), 0, 'underflow becomes zero');
  assertEquals(toHalfFloat(0.0999755859375), 0x2e66, 'normal value');
  assertEquals(toHalfFloat(2 ** -24), 0x0001, 'smallest subnormal');
  assertEquals(toHalfFloat(1.00048828125), 0x3c00, 'tie rounds to even (down)');
  assertEquals(toHalfFloat(1.00146484375), 0x3c02, 'tie rounds to even (up)');
});
