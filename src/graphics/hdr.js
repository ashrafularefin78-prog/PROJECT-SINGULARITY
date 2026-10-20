/**
 * M3 - a measured HDRI probe.
 *
 * The environment lighting in this project was procedural and said so. This
 * module makes a real Radiance `.hdr` probe first-class: it decodes RGBE
 * scanlines (flat and new-style RLE), samples the equirectangular image by
 * direction, projects it onto the same band-2 spherical harmonics the renderer
 * already convolves, and measures how much the SH reconstruction loses.
 *
 * The probe ships with the repo (`assets/probes/singularity-sky.hdr`, generated
 * by `tools/make-probe.py`) so there is no network fetch and no licence
 * question. A different probe is just another file: the loader takes bytes.
 *
 * Deliberately not here: an equirect-to-cube resampler or a GGX prefilter of the
 * probe. The diffuse irradiance cube is probe-driven; the specular path stays
 * on the procedural sky, and the UI says which is which.
 */
import { irradiance, shProject } from './env.js';

const HEADER_END = '\n';

/** Decode RGBE to linear floats. `2^(e-136)` is the classic 128-bias + 8-bit mantissa. */
function rgbeToLinear(r, g, b, e) {
  if (e === 0) return [0, 0, 0];
  const f = 2 ** (e - 136);
  return [r * f, g * f, b * f];
}

/**
 * Parse a Radiance RGBE image. Supports the orientation every probe uses
 * (`-Y height +X width`) and both scanline encodings. Throws on anything it
 * cannot decode rather than returning a plausible-looking wrong image.
 *
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ width: number, height: number, data: Float32Array }}
 */
export function parseRadianceHDR(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const decoder = new TextDecoder('latin1');
  let offset = 0;
  let header = '';

  // Header: lines until a blank one. 1 MB is already absurd for a header.
  while (offset < bytes.length) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0x0a) end += 1;
    const line = decoder.decode(bytes.subarray(offset, end));
    offset = end + 1;
    header += line + HEADER_END;
    if (line.trim() === '') break;
    if (offset > 1024 * 1024) throw new Error('HDR header is unreasonably large');
  }
  if (!/FORMAT=32-bit_rle_rgbe/.test(header)) throw new Error('not a Radiance RGBE file (missing FORMAT line)');

  let width = 0;
  let height = 0;
  while (offset < bytes.length) {
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0x0a) end += 1;
    const line = decoder.decode(bytes.subarray(offset, end)).trim();
    offset = end + 1;
    if (!line) continue;
    const m = /^-Y\s+(\d+)\s+\+X\s+(\d+)$/.exec(line);
    if (!m) throw new Error(`unsupported HDR orientation '${line}' (expected -Y height +X width)`);
    height = Number(m[1]);
    width = Number(m[2]);
    break;
  }
  if (!width || !height) throw new Error('HDR resolution line missing');
  if (width * height > 64 * 1024 * 1024) throw new Error('HDR image is unreasonably large');

  const data = new Float32Array(width * height * 3);
  let out = 0;

  const readFlat = (count) => {
    if (offset + count * 4 > bytes.length) throw new Error('HDR scanline truncated');
    for (let i = 0; i < count; i += 1) {
      const [r, g, b] = rgbeToLinear(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      data[out] = r; data[out + 1] = g; data[out + 2] = b;
      out += 3;
      offset += 4;
    }
  };

  for (let row = 0; row < height; row += 1) {
    if (offset + 4 > bytes.length) throw new Error('HDR image truncated');
    const isRle = width >= 8 && width < 32768
      && bytes[offset] === 2 && bytes[offset + 1] === 2
      && ((bytes[offset + 2] << 8) | bytes[offset + 3]) === width;
    if (!isRle) {
      readFlat(width);
      continue;
    }
    offset += 4;
    const channels = [new Uint8Array(width), new Uint8Array(width), new Uint8Array(width), new Uint8Array(width)];
    for (let c = 0; c < 4; c += 1) {
      let x = 0;
      while (x < width) {
        if (offset >= bytes.length) throw new Error('HDR RLE scanline truncated');
        const count = bytes[offset++];
        if (count > 128) {
          const run = count - 128;
          if (x + run > width || offset >= bytes.length) throw new Error('HDR RLE run overflows the scanline');
          const value = bytes[offset++];
          channels[c].fill(value, x, x + run);
          x += run;
        } else {
          if (count === 0) throw new Error('HDR RLE zero-length literal');
          if (x + count > width || offset + count > bytes.length) throw new Error('HDR RLE literal overflows the scanline');
          channels[c].set(bytes.subarray(offset, offset + count), x);
          offset += count;
          x += count;
        }
      }
    }
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgbeToLinear(channels[0][x], channels[1][x], channels[2][x], channels[3][x]);
      data[out] = r; data[out + 1] = g; data[out + 2] = b;
      out += 3;
    }
  }

  return { width, height, data };
}

/** Bilinear equirectangular sample for a unit direction; longitude wraps. */
export function probeRadiance(probe, dir) {
  const [x, y, z] = dir;
  const len = Math.hypot(x, y, z) || 1;
  const ny = Math.max(-1, Math.min(1, y / len));
  const longitude = Math.atan2(x / len, z / len); // -PI..PI, +Z is forward
  const latitude = Math.asin(ny);
  const u = (longitude / (2 * Math.PI) + 0.5) * probe.width - 0.5;
  const v = (0.5 - latitude / Math.PI) * probe.height - 0.5;

  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const fx = u - x0;
  const fy = v - y0;
  const wrapX = (n) => ((n % probe.width) + probe.width) % probe.width;
  const clampY = (n) => Math.max(0, Math.min(probe.height - 1, n));

  const at = (px, py, c) => probe.data[(clampY(py) * probe.width + wrapX(px)) * 3 + c];
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c += 1) {
    const top = at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx;
    const bottom = at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx;
    out[c] = top * (1 - fy) + bottom * fy;
  }
  return out;
}

/** Project the probe onto the renderer's band-2 SH basis. */
export function probeSH(probe, samples = 4096) {
  return shProject(samples, (dir) => probeRadiance(probe, dir));
}

/** Brightest direction, for the UI's one-line probe description. */
export function probePeak(probe) {
  let best = { at: 0, value: -1 };
  for (let i = 0; i < probe.width * probe.height; i += 1) {
    const r = probe.data[i * 3];
    const g = probe.data[i * 3 + 1];
    const b = probe.data[i * 3 + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum > best.value) best = { at: i, value: lum };
  }
  const x = best.at % probe.width;
  const y = Math.floor(best.at / probe.width);
  const longitude = ((x + 0.5) / probe.width - 0.5) * 2 * Math.PI;
  const latitude = (0.5 - (y + 0.5) / probe.height) * Math.PI;
  return {
    luminance: best.value,
    longitude,
    latitude,
    elevationDeg: (latitude * 180) / Math.PI,
    azimuthDeg: (longitude * 180) / Math.PI,
  };
}

/**
 * How much the SH-2 reconstruction loses: for `normals` deterministic
 * directions, compare `irradiance(coeffs, n)` against a direct cosine-weighted
 * integral of the probe. Returns the mean absolute relative error, which the M3
 * panel prints instead of claiming "accurate".
 */
export function probeIrradianceError(probe, coeffs, normals = 96, samples = 64) {
  const golden = 2.39996323;
  let total = 0;
  let counted = 0;
  for (let i = 0; i < normals; i += 1) {
    const y = 1 - ((2 * i + 1) / normals);
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const a = i * golden;
    const n = [Math.cos(a) * r, y, Math.sin(a) * r];
    let direct = [0, 0, 0];
    for (let s = 0; s < samples; s += 1) {
      const sy = 1 - ((2 * s + 1) / samples);
      const sr = Math.sqrt(Math.max(0, 1 - sy * sy));
      const sa = s * golden;
      const d = [Math.cos(sa) * sr, sy, Math.sin(sa) * sr];
      const cos = Math.max(0, n[0] * d[0] + n[1] * d[1] + n[2] * d[2]);
      if (cos <= 0) continue;
      const rad = probeRadiance(probe, d);
      direct[0] += rad[0] * cos;
      direct[1] += rad[1] * cos;
      direct[2] += rad[2] * cos;
    }
    // The same uniform-sphere weights the SH projection uses.
    const w = (4 * Math.PI) / samples;
    const sh = irradiance(coeffs, n);
    for (let c = 0; c < 3; c += 1) {
      const want = direct[c] * w;
      if (want < 1e-6) continue;
      total += Math.abs(sh[c] - want) / want;
      counted += 1;
    }
  }
  return counted ? total / counted : 0;
}
