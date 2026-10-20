/**
 * M3 measured HDRI probe.
 *
 * The decoder is the part that can be wrong silently: RGBE exponents, the two
 * scanline encodings, and row orientation. These tests build real Radiance
 * buffers byte by byte, so the parser is checked against the format rather than
 * against its own output. The SH test uses a constant sky, whose irradiance has
 * a closed form (pi * L), which is a much stronger check than "it returned
 * numbers".
 */
import { test, assert, assertEquals } from './harness.js';
import { parseRadianceHDR, probeIrradianceError, probePeak, probeRadiance, probeSH } from '../src/graphics/hdr.js';
import { irradiance } from '../src/graphics/env.js';

const encoder = new TextEncoder();

function header(width, height) {
  return encoder.encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);
}

function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Flat RGBE rows. */
function flatHdr(width, height, px) {
  const body = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, e] = px(x, y);
      const o = (y * width + x) * 4;
      body[o] = r; body[o + 1] = g; body[o + 2] = b; body[o + 3] = e;
    }
  }
  return concatBytes([header(width, height), body]);
}

/** New-style RLE with one run per channel per row. */
function rleHdr(width, height, rgba) {
  const parts = [header(width, height)];
  for (let y = 0; y < height; y += 1) {
    parts.push(new Uint8Array([2, 2, (width >> 8) & 0xff, width & 0xff]));
    for (const value of rgba) parts.push(new Uint8Array([128 + width, value]));
  }
  return concatBytes(parts);
}

test('M3 HDR: flat RGBE decodes with the 128-bias exponent', () => {
  const bytes = flatHdr(4, 2, (x, y) => (y === 0 ? [128, 64, 32, 129] : [0, 0, 0, 0]));
  const probe = parseRadianceHDR(bytes);
  assertEquals(probe.width, 4);
  assertEquals(probe.height, 2);
  // e=129 -> 2^(129-136) = 1/128, so 128 -> 1.0, 64 -> 0.5, 32 -> 0.25.
  assertEquals(probe.data[0].toFixed(4), '1.0000');
  assertEquals(probe.data[1].toFixed(4), '0.5000');
  assertEquals(probe.data[2].toFixed(4), '0.2500');
  assertEquals(probe.data[12], 0, 'e=0 is black, not 2^-136');
});

test('M3 HDR: new-style RLE scanlines decode exactly', () => {
  const probe = parseRadianceHDR(rleHdr(8, 1, [128, 64, 32, 129]));
  assertEquals(probe.width, 8);
  assertEquals(probe.height, 1);
  for (let x = 0; x < 8; x += 1) {
    assertEquals(probe.data[x * 3].toFixed(4), '1.0000', `texel ${x} red`);
    assertEquals(probe.data[x * 3 + 1].toFixed(4), '0.5000', `texel ${x} green`);
  }
});

test('M3 HDR: a malformed or truncated file is rejected, never half-read', () => {
  let failed = 0;
  try {
    parseRadianceHDR(encoder.encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n\x01\x02'));
  } catch {
    failed += 1;
  }
  try {
    parseRadianceHDR(encoder.encode('not a probe'));
  } catch {
    failed += 1;
  }
  assertEquals(failed, 2, 'both the truncated image and the wrong header throw');
});

test('M3 HDR: directions sample the equirectangular image where expected', () => {
  // 8x4, bright only where longitude is positive (x = 6,7) and above the horizon.
  const probe = parseRadianceHDR(flatHdr(8, 4, (x) => (x >= 6 ? [128, 128, 128, 129] : [0, 0, 0, 0])));
  const front = probeRadiance(probe, [0, 0, 1]);
  assertEquals(front[0], 0, 'the front is dark');
  const side = probeRadiance(probe, [0.7071, 0, -0.7071]);
  assert(side[0] > 0.9, 'the 135-degree direction lands in the bright half');
  assertEquals(Math.round(probePeak(probe).azimuthDeg / 45), 3, 'peak is in the expected quadrant');
});

test('M3 HDR: a constant probe projects to irradiance pi * L within 2 percent', () => {
  const L = 1.0;
  const probe = parseRadianceHDR(flatHdr(4, 2, () => [128, 128, 128, 129]));
  const coeffs = probeSH(probe, 4096);
  for (const n of [[0, 1, 0], [1, 0, 0], [0, -1, 0], [0.577, 0.577, 0.577]]) {
    const e = irradiance(coeffs, n);
    const want = Math.PI * L;
    for (const channel of e) {
      assert(Math.abs(channel - want) / want < 0.02, `irradiance ${channel} vs ${want}`);
    }
  }
  const error = probeIrradianceError(probe, coeffs, 24, 48);
  assert(error < 0.02, `mean relative error ${error}`);
});
