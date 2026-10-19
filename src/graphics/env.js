/**
 * M3 - a procedural environment for image-based lighting, with no images.
 *
 * The renderer used to light its ambient term with a hand-mixed hemispheric
 * hack (two constants blended by the normal's y). This module replaces that
 * with real IBL built from a deterministic procedural sky - no HDRI probe is
 * downloaded, none is bundled, and every number here is reproducible from a
 * seed:
 *
 *   - `skyRadiance(dir)`     the linear-RGB radiance the sky emits toward an
 *                            observer at the origin looking in `dir` (y up).
 *                            Pure: same direction, same light, forever.
 *   - `shProject()`          projects that sky onto the band-2 real spherical
 *                            harmonics (9 coefficients x 3 channels).
 *   - `irradiance()`         the Ramamoorthi cosine-lobe convolution of those
 *                            coefficients - the diffuse ambient a surface with
 *                            normal `n` receives from the whole sky.
 *   - `irradianceCube()`     6 x size^2 face map of `irradiance()`, so the GPU
 *                            answers the same question with one tex() fetch.
 *   - `envCube()`            6 x size^2 face map of the raw sky itself. The
 *                            renderer mip-maps this and fetches `reflect(-V,N)`
 *                            through `textureLod` at a roughness-driven LOD,
 *                            which is a box-filter approximation of the rough
 *                            specular lobe (declared: not a GGX prefilter).
 *   - `ggxPrefilteredCube()` GGX split-sum importance-sampled specular prefilter
 *                            for a given roughness, replacing the earlier box-filter
 *                            approximation (samples the procedural sky with a
 *                            GGX distribution, deterministic via Hammersley).
 *                            detail (sampled by the ground plane; the lattice
 *                            hash wraps on the size modulo so a fetch never
 *                            leaves the lattice).
 *
 * The cube faces are laid out in the GL sampling convention (major axis, then
 * sc/tc per the OpenGL cube-map selection table), so `texture(uEnvCube, R)` in
 * the shader answers for the direction R without any fix-up.
 *
 * What this is not: a measured HDRI, glTF image sampling, or skinned animation.
 * The sky here is a guess about the fiction of this app, rendered deterministically,
 * and it says so. The specular prefilter is now a proper GGX split-sum
 * importance-sampled convolution (ggxPrefilteredCube) rather than a box-filter
 * mip-map of the raw sky.
 */

// Band-2 real SH basis constants, y-up world (Peter-Pike Sloan's table).
const SH = {
  c0: 0.2820948,
  c1: 0.4886025,
  c2: 1.0925484,
  c3: 0.3153916,
  c4: 0.5462742,
};

// Ramamoorthi's cosine-lobe convolution constants: irradiance(n) = A0*L00*Y00 +
// A1*(band 1 terms) + A2*(band 2 terms). For a constant sky of radiance R the
// convolution must return exactly R, which the tests assert.
const IRRADIANCE_A = [Math.PI, (2 * Math.PI) / 3, Math.PI / 4];

/** Basis evaluation at direction d = (x, y, z), |d| = 1, y up. Band order:
 *  [L00, L1-1, L10, L11, L2-2, L2-1, L20, L21, L22]. */
export function shBasis(x, y, z) {
  return [
    SH.c0,
    -SH.c1 * y,
    SH.c1 * z,
    -SH.c1 * x,
    SH.c2 * x * y,
    SH.c2 * y * z,
    SH.c3 * (2 * z * z - x * x - y * y),
    SH.c2 * x * z,
    SH.c4 * (x * x - y * y),
  ];
}

/**
 * The procedural sky. A deep-space fiction that matches the app's own palette:
 * near-black blue overhead, a teal horizon band, two soft nebula glows (violet
 * and cyan, the UI accent hues) and a scatter of hash-bright stars, plus a
 * faint warm bounce from below so objects resting on the ground are not lit
 * from nowhere. Deterministic: no time, no randomness beyond the seeded hash.
 *
 * @param {number[]} d direction, |d| ≈ 1 (the caller normalizes)
 * @returns {[number, number, number]} linear RGB radiance
 */
export function skyRadiance(d) {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  const x = d[0] / len;
  const y = d[1] / len;
  const z = d[2] / len;

  // Deep space floor, lifted toward a soft teal horizon band.
  let r = 0.012;
  let g = 0.018;
  let b = 0.033;
  const horizon = Math.exp(-Math.abs(y + 0.06) / 0.34);
  r += 0.020 * horizon;
  g += 0.062 * horizon;
  b += 0.086 * horizon;

  // Two nebula glows around fixed anchor directions, the app's accents.
  const anchors = [
    { dir: [0.38, 0.52, -0.76], tint: [0.115, 0.082, 0.240] },
    { dir: [-0.63, 0.18, 0.75], tint: [0.030, 0.118, 0.165] },
  ];
  for (const a of anchors) {
    const cos = x * a.dir[0] + y * a.dir[1] + z * a.dir[2];
    const glow = Math.exp(-3.4 * (1 - Math.max(cos, 0)));
    r += a.tint[0] * glow;
    g += a.tint[1] * glow;
    b += a.tint[2] * glow;
  }

  // Stars: a hash over a quantised direction shell, brighter than everything
  // around them but capped so the ambient measurement barely sees them.
  const ix = Math.floor(x * 71);
  const iy = Math.floor(y * 71);
  const iz = Math.floor(z * 71);
  let h = (ix * 374761393 + iy * 668265263 + iz * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) | 0;
  const u = (h >>> 0) / 4294967295;
  if (u > 0.9955) {
    const star = ((u - 0.9955) / 0.0045) * 0.42;
    r += star * 0.92;
    g += star * 0.97;
    b += star * 1.0;
  }

  // Floor bounce from below: warm, dim, only where there is ground to bounce.
  const below = Math.max(0, -y);
  r += below * 0.040;
  g += below * 0.038;
  b += below * 0.042;

  return [r, g, b];
}

/**
 * Project `skyRadiance` onto the band-2 SH with N quasi-uniform (Fibonacci)
 * sphere samples. Returns a Float32Array(27): nine coefficients, RGB interleaved
 * per coefficient (channel-major per band).
 */
export function shProject(samples = 4096) {
  const coeffs = new Float32Array(27);
  const weight = (4 * Math.PI) / samples;
  const golden = 2.39996323;
  for (let i = 0; i < samples; i += 1) {
    const y = 1 - ((2 * i + 1) / samples) * 1; // uniform in cos(elevation)
    const yr = Math.max(-1, Math.min(1, y));
    const r = Math.sqrt(1 - yr * yr);
    const ang = i * golden;
    const d = [Math.cos(ang) * r, yr, Math.sin(ang) * r];
    const rad = skyRadiance(d);
    const basis = shBasis(d[0], d[1], d[2]);
    for (let k = 0; k < 9; k += 1) {
      coeffs[k * 3] += rad[0] * basis[k] * weight;
      coeffs[k * 3 + 1] += rad[1] * basis[k] * weight;
      coeffs[k * 3 + 2] += rad[2] * basis[k] * weight;
    }
  }
  return coeffs;
}

/** The cosine-lobe convolution of projected coefficients: the irradiance a
 *  surface with normal n (|n| = 1) receives from the projected sky. */
export function irradiance(coeffs, n) {
  const basis = shBasis(n[0], n[1], n[2]);
  const out = [0, 0, 0];
  for (let k = 0; k < 9; k += 1) {
    const band = k === 0 ? 0 : k <= 3 ? 1 : 2;
    const a = IRRADIANCE_A[band];
    out[0] += a * basis[k] * coeffs[k * 3];
    out[1] += a * basis[k] * coeffs[k * 3 + 1];
    out[2] += a * basis[k] * coeffs[k * 3 + 2];
  }
  return out;
}

/** GL cube-face direction table: for face f (0..5 in +X,-X,+Y,-Y,+Z,-Z order)
 *  and texel-centre coordinates sc, tc in [-1, 1], the direction that texel
 *  samples from, per the OpenGL cube-map selection convention. */
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

const encode = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * Build one RGBA8 cube map from a per-direction radiance function. Returns
 * { size, data } with data laid out as textImage2D wants it: six faces in
 * +X,-X,+Y,-Y,+Z,-Z order, each `size*size*4` bytes row-major, t downward.
 */
export function radianceCube(fn, size = 64) {
  const data = new Uint8Array(6 * size * size * 4);
  for (let face = 0; face < 6; face += 1) {
    const base = face * size * size * 4;
    for (let row = 0; row < size; row += 1) {
      const tc = (2 * (row + 0.5)) / size - 1;
      for (let col = 0; col < size; col += 1) {
        const sc = (2 * (col + 0.5)) / size - 1;
        const d = faceDirection(face, sc, tc);
        const rad = fn(d);
        const o = base + (row * size + col) * 4;
        data[o] = encode(rad[0]);
        data[o + 1] = encode(rad[1]);
        data[o + 2] = encode(rad[2]);
        data[o + 3] = 255;
      }
    }
  }
  return { size, data };
}

/** The irradiance cube: `irradiance()` over the projected sky, 16^2 per face -
 *  low frequency by design (diffuse ambient is smooth). */
export function irradianceCube(coeffs, size = 16) {
  return radianceCube((d) => irradiance(coeffs, d), size);
}

/** The specular environment cube: the raw procedural sky. */
/** The specular environment cube: the raw procedural sky. */
export function envCube(size = 64) {
  return radianceCube((d) => skyRadiance(d), size);
}

/**
 * GGX specular prefilter: convolve the procedural sky with a GGX normal
 * distribution for a given roughness, producing a cube map that the renderer
 * samples directly (no runtime LOD box-filter). Uses the split-sum
 * importance-sampling formulation with a deterministic Hammersley sequence so
 * the result is reproducible from the seed.
 */
export function ggxPrefilteredCube(size = 32, roughness = 0.5, samples = 64) {
  const alpha = Math.max(roughness * roughness, 1e-4);
  const data = new Uint8Array(6 * size * size * 4);
  // Hammersley sequence for deterministic sampling.
  const hammersley = (i, n) => {
    let bits = i;
    bits = (bits << 16) | (bits >>> 16);
    bits = ((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1);
    bits = ((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2);
    bits = ((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4);
    bits = ((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8);
    return bits / 4294967296;
  };
  const ggxSample = (xi1, xi2, nrm) => {
    const a2 = alpha * alpha;
    const phi = 2 * Math.PI * xi1;
    const cosTheta = Math.sqrt((1 - xi2) / (1 + (a2 - 1) * xi2));
    const sinTheta = Math.sqrt(1 - cosTheta * cosTheta);
    // tangent space
    const hx = sinTheta * Math.cos(phi);
    const hy = sinTheta * Math.sin(phi);
    const hz = cosTheta;
    // transform to world space (nrm as z-axis)
    const up = Math.abs(nrm[1]) < 0.999 ? [0, 1, 0] : [1, 0, 0];
    const tx = [up[1] * nrm[2] - up[2] * nrm[1],
                 up[2] * nrm[0] - up[0] * nrm[2],
                 up[0] * nrm[1] - up[1] * nrm[0]];
    const tl = Math.sqrt(tx[0] * tx[0] + tx[1] * tx[1] + tx[2] * tx[2]);
    tx[0] /= tl; tx[1] /= tl; tx[2] /= tl;
    const ty = [nrm[1] * tx[2] - nrm[2] * tx[1],
                 nrm[2] * tx[0] - nrm[0] * tx[2],
                 nrm[0] * tx[1] - nrm[1] * tx[0]];
    const h = [
      tx[0] * hx + ty[0] * hy + nrm[0] * hz,
      tx[1] * hx + ty[1] * hy + nrm[1] * hz,
      tx[2] * hx + ty[2] * hy + nrm[2] * hz,
    ];
    return h;
  };
  for (let face = 0; face < 6; face += 1) {
    const base = face * size * size * 4;
    for (let row = 0; row < size; row += 1) {
      const tc = (2 * (row + 0.5)) / size - 1;
      for (let col = 0; col < size; col += 1) {
        const sc = (2 * (col + 0.5)) / size - 1;
        const n = faceDirection(face, sc, tc);
        const nl = Math.sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        n[0] /= nl; n[1] /= nl; n[2] /= nl;
        // view = normal for prefilter
        const v = [n[0], n[1], n[2]];
        let accR = 0, accG = 0, accB = 0, accW = 0;
        for (let s = 0; s < samples; s += 1) {
          const xi1 = hammersley(s, samples);
          const xi2 = hammersley(s + samples, samples);
          const h = ggxSample(xi1, xi2, n);
          const hl = Math.sqrt(h[0] * h[0] + h[1] * h[1] + h[2] * h[2]);
          h[0] /= hl; h[1] /= hl; h[2] /= hl;
          // reflect v over h
          const vd = v[0] * h[0] + v[1] * h[1] + v[2] * h[2];
          const l = [2 * vd * h[0] - v[0], 2 * vd * h[1] - v[1], 2 * vd * h[2] - v[2]];
          const ndl = n[0] * l[0] + n[1] * l[1] + n[2] * l[2];
          if (ndl > 0) {
            const rad = skyRadiance(l);
            accR += rad[0] * ndl;
            accG += rad[1] * ndl;
            accB += rad[2] * ndl;
            accW += ndl;
          }
        }
        const o = base + (row * size + col) * 4;
        if (accW > 0) {
          data[o] = Math.max(0, Math.min(255, Math.round((accR / accW) * 255)));
          data[o + 1] = Math.max(0, Math.min(255, Math.round((accG / accW) * 255)));
          data[o + 2] = Math.max(0, Math.min(255, Math.round((accB / accW) * 255)));
        } else {
          data[o] = 0; data[o + 1] = 0; data[o + 2] = 0;
        }
        data[o + 3] = 255;
      }
    }
  }
  return { size, data };
}

/**
 * A tilable seeded value-noise RGBA texture for albedo detail. The lattice hash
 * wraps on the size modulo, so every cell of the lattice is complete and a
 * fetch never reads past the lattice's edge - the value function has no
 * boundary, which is what makes the result tile cleanly at the texture's own
 * edges.
 */
export function noiseTexture(size = 128, seed = 0x5eed) {
  const lattice = new Float32Array(size * size);
  let h = seed | 0;
  for (let i = 0; i < lattice.length; i += 1) {
    h = Math.imul(h ^ (h >>> 15), 2654435761);
    h = (h ^ (h >>> 13)) | 0;
    lattice[i] = ((h >>> 0) / 4294967295) * 2 - 1; // [-1, 1]
  }
  const at = (x, y) => lattice[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const smooth = (t) => t * t * (3 - 2 * t);
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      // Bilinear value noise over the wrapped lattice, two octaves.
      const fx = col / 8;
      const fy = row / 8;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const sx = smooth(fx - x0);
      const sy = smooth(fy - y0);
      const n0 = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
      const n1 = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
      const coarse = n0 * (1 - sy) + n1 * sy;
      const fx2 = col / 3;
      const fy2 = row / 3;
      const x20 = Math.floor(fx2);
      const y20 = Math.floor(fy2);
      const s2x = smooth(fx2 - x20);
      const s2y = smooth(fy2 - y20);
      const m0 = at(x20, y20) * (1 - s2x) + at(x20 + 1, y20) * s2x;
      const m1 = at(x20, y20 + 1) * (1 - s2x) + at(x20 + 1, y20 + 1) * s2x;
      const fine = m0 * (1 - s2y) + m1 * s2y;
      const v = Math.max(-1, Math.min(1, coarse * 0.72 + fine * 0.28));
      const q = ((v + 1) / 2) * 255; // already 0..255; encode() would square it
      const o = (row * size + col) * 4;
      data[o] = Math.max(0, Math.min(255, Math.round(q)));
      data[o + 1] = encode(q);
      data[o + 2] = encode(q);
      data[o + 3] = 255;
    }
  }
  return { size, data };
}
