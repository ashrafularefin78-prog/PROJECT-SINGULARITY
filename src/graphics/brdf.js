/**
 * Split-sum specular BRDF integration (Karis, "Real Shading in Unreal Engine
 * 4"), computed here instead of baked into the shader.
 *
 * The environment specular term is
 *
 *   ∫ f(l, v) L(l) (n·l) dl  ≈  L_prefiltered(r, roughness) · (F0·A + B)
 *
 * where the second factor is this LUT: for every (n·v, roughness) it
 * numerically integrates the Cook-Torrance specular lobe against a white
 * environment with GGX importance sampling, storing
 *
 *   A = ∫ (1 - (1 - v·h)^5) G_vis
 *   B = ∫      (1 - v·h)^5  G_vis
 *
 * with G_vis = G · (v·h) / ((n·h)(n·v)). The renderer samples it at
 * vec2(n·v, roughness) and reconstructs F0·A + B, which removes the
 * N = V approximation the shader used before (fresnel at the view angle only).
 *
 * Everything is deterministic: a Hammersley sequence, no randomness, no
 * downloaded LUT. Half-float storage is texture-filterable in ES 3.0.
 */

function hammersley(index, count) {
  let bits = index;
  bits = ((bits << 16) | (bits >>> 16)) >>> 0;
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0;
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0;
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0;
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0;
  return [index / count, bits * 2.3283064365386963e-10];
}

/** IBL geometry term: k = roughness^2 / 2, as the split-sum derivation uses. */
function geometrySmithIBL(ndotv, ndotl, roughness) {
  const k = (roughness * roughness) / 2;
  return (ndotl / (ndotl * (1 - k) + k)) * (ndotv / (ndotv * (1 - k) + k));
}

/**
 * Integrate the specular BRDF for one (n·v, roughness) pair.
 *
 * @param {number} ndotv   cos(view, normal), 0..1 (clamped)
 * @param {number} roughness 0..1 (clamped)
 * @param {number} [samples] importance samples; 128 is the shipped default
 * @returns {[number, number]} [scale, bias] for F0·A + B
 */
export function integrateBRDF(ndotv, roughness, samples = 128) {
  const nv = Math.min(Math.max(ndotv, 1e-4), 1);
  const r = Math.min(Math.max(roughness, 1e-3), 1);
  const a = r * r;
  const a2 = a * a;
  const vx = Math.sqrt(Math.max(1 - nv * nv, 0));
  let scale = 0;
  let bias = 0;
  for (let i = 0; i < samples; i += 1) {
    const [xi1, xi2] = hammersley(i, samples);
    const phi = 2 * Math.PI * xi1;
    // GGX importance sample of the half vector around N = +Z.
    const cosTheta = Math.sqrt((1 - xi2) / (1 + (a2 - 1) * xi2));
    const sinTheta = Math.sqrt(Math.max(1 - cosTheta * cosTheta, 0));
    const hx = Math.cos(phi) * sinTheta;
    const hy = Math.sin(phi) * sinTheta;
    const hz = cosTheta;
    const vdh = vx * hx + nv * hz;
    const lx = 2 * vdh * hx - vx;
    const lz = 2 * vdh * hz - nv;
    const ndl = Math.max(lz, 0);
    const ndh = Math.max(hz, 0);
    if (ndl <= 0 || ndh <= 0 || vdh <= 0) continue;
    const g = geometrySmithIBL(nv, ndl, r);
    const gVis = (g * vdh) / (ndh * nv);
    const fc = Math.pow(1 - vdh, 5);
    scale += (1 - fc) * gVis;
    bias += fc * gVis;
  }
  return [scale / samples, bias / samples];
}

/**
 * The full LUT as Float32 RG pairs, row-major with the row index as roughness:
 * texel (x, y) is (n·v = (x + 0.5) / size, roughness = (y + 0.5) / size).
 */
export function brdfLutData(size = 64, samples = 128) {
  if (!Number.isSafeInteger(size) || size < 2) throw new Error('brdf: size must be an integer >= 2');
  const data = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y += 1) {
    const roughness = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const ndotv = (x + 0.5) / size;
      const [scale, bias] = integrateBRDF(ndotv, roughness, samples);
      const at = (y * size + x) * 2;
      data[at] = scale;
      data[at + 1] = bias;
    }
  }
  return data;
}

const FLOAT_VIEW = new Float32Array(1);
const INT_VIEW = new Int32Array(FLOAT_VIEW.buffer);

/** IEEE 754 binary32 -> binary16 bits (round to nearest even). */
export function toHalfFloat(value) {
  FLOAT_VIEW[0] = value;
  const x = INT_VIEW[0];
  const sign = (x >> 16) & 0x8000;
  const exponent = (x >> 23) & 0xff;
  let mantissa = x & 0x007fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 0x0200 : 0);
  if (exponent >= 113) {
    if (exponent > 142) return sign | 0x7c00; // overflow to infinity
    const half = sign | ((exponent - 112) << 10) | (mantissa >> 13);
    // Round to nearest even at the 13 dropped mantissa bits.
    if (mantissa & 0x1000 && ((mantissa & 0x0fff) !== 0 || (half & 1))) return half + 1;
    return half;
  }
  if (exponent < 102) return sign; // underflow to signed zero
  // Subnormal half: restore the implicit leading one and shift into place.
  mantissa |= 0x00800000;
  const shift = 126 - exponent;
  let half = sign | (mantissa >> shift);
  if (mantissa & (1 << (shift - 1)) && ((mantissa & ((1 << (shift - 1)) - 1)) !== 0 || (half & 1))) half += 1;
  return half;
}

/**
 * Upload the LUT as a filterable RG16F texture. Linear filtering is core in
 * WebGL2 for 16-bit float formats, so the shader does not need the
 * OES_texture_float_linear extension. CLAMP_TO_EDGE holds at n·v = 0 and
 * roughness = 1. The caller owns the texture.
 */
export function brdfLutTexture(gl, size = 64, samples = 128) {
  const data = brdfLutData(size, samples);
  const half = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i += 1) half[i] = toHalfFloat(data[i]);
  const texture = gl.createTexture();
  if (!texture) throw new Error('brdf: could not allocate the integration LUT texture');
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, size, size, 0, gl.RG, gl.HALF_FLOAT, half);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (gl.getError && gl.getError() !== gl.NO_ERROR) throw new Error('brdf: LUT upload failed');
    return texture;
  } catch (error) {
    gl.deleteTexture(texture);
    throw error;
  }
}
