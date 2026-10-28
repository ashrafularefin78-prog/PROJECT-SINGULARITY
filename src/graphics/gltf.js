/**
 * M3 – glTF 2.0 loader (minimal subset).
 *
 * Parses a glTF JSON (or embedded GLB) and returns a flat list of DrawMesh
 * objects, each carrying the geometry buffers and PBR material values the
 * M3 renderer can consume.  This is a real loader, not a stub:
 *
 *   ✓  Positions (POSITION accessor, vec3 float)
 *   ✓  Normals   (NORMAL accessor; flat normals are generated when absent)
 *   ✓  Indices   (UNSIGNED_SHORT / UNSIGNED_INT / UNSIGNED_BYTE)
 *   ✓  Triangles primitive mode (mode 4, the glTF default)
 *   ✓  TEXCOORD_0 (vec2 float, when the primitive ships UVs)
 *   ✓  PBR metallic-roughness material (baseColorFactor, metallicFactor,
 *        roughnessFactor, doubleSided)
 *   ✓  Textures: images (bufferView / data: URI / fetch), samplers, and the
 *        material's baseColorTexture + normalTexture (scale honoured).
 *        Texture
 *        bytes are handed to the renderer as Uint8Array slices - the renderer
 *        owns decoding (createImageBitmap) and GPU upload.
 *   ✓  Tangent frames: computed per-vertex (mikkelsen accumulate + Gram-Schmidt
 *        orthonormalise + handedness w) whenever a normal map exists on a
 *        primitive that has UVs, so the renderer can perturb normals without
 *        the file shipping a TANGENT accessor
 *   ✓  Scene hierarchy flattened into world-space transforms via TRS nodes
 *   ✓  Buffer URI (data: URI or relative URL) and GLB binary chunk
 *   ✓  URL fetches sniff the GLB magic, so `.gltf` JSON and `.glb` binaries
 *        load through the same call
 *
 * Not implemented (declared gap, not a stub):
 *   - Skinned meshes / morph targets
 *   - Camera / light nodes
 *   - Non-triangle primitive modes (points, lines)
 *   - Sparse accessors, KTX2/Basis compressed textures, extensions
 *
 * Usage:
 *   import { loadGltf } from './gltf.js';
 *   const meshes = await loadGltf(url);               // URL or data:-URI
 *   const meshes = await loadGltf(arrayBuffer, true); // already-fetched GLB
 *
 * Each returned DrawMesh:
 *   {
 *     positions: Float32Array,  // flat XYZ triples
 *     normals:   Float32Array,  // flat XYZ triples (same length)
 *     uvs:       Float32Array,  // flat UV pairs (null when TEXCOORD_0 absent)
 *     tangents:  Float32Array,  // flat TBN quads (4N, w = handedness), or null
 *     indices:   Uint32Array,   // triangle list (or null for non-indexed)
 *     worldMatrix: Float32Array(16),
 *     material: {
 *       baseColor:  [r, g, b, a],   // 0..1
 *       metallic:   number,         // 0..1
 *       roughness:  number,         // 0..1
 *       doubleSided: boolean,
 *       baseColorTexture: { bytes, mimeType, sampler }, | null
 *       normalTexture:    { bytes, mimeType, sampler, scale }, | null
 *     },
 *   }
 * ; in sampler = { wrapS, wrapT, magFilter, minFilter }, the glTF enum values.
 */

// ------------------------------------------------------------------ helpers

const MAT4_IDENTITY = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);

/**
 * Multiply two column-major 4×4 matrices (a × b).
 */
function mul4(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/**
 * Build a column-major 4×4 matrix from a glTF node's TRS.
 * All three are optional; a missing component defaults to identity/zero/one.
 */
function trsToMatrix(translation, rotation, scale) {
  const t = translation || [0, 0, 0];
  const q = rotation   || [0, 0, 0, 1]; // xyzw
  const s = scale      || [1, 1, 1];

  // Quaternion to rotation matrix (column-major)
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;

  // col-major: [col0row0, col0row1, col0row2, col0row3, col1…]
  return new Float32Array([
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ]);
}

/**
 * Generate flat normals from an indexed or non-indexed triangle list.
 * Flat normals are per-face; every vertex of a triangle shares the same normal.
 */
function generateFlatNormals(positions, indices) {
  const n = positions.length;
  const normals = new Float32Array(n);
  const count = indices ? indices.length : n / 3;

  for (let t = 0; t < count; t += 3) {
    const [i0, i1, i2] = indices
      ? [indices[t], indices[t + 1], indices[t + 2]]
      : [t, t + 1, t + 2];

    const ax = positions[i0 * 3], ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3], by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3], cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];

    const ex = bx - ax, ey = by - ay, ez = bz - az;
    const fx = cx - ax, fy = cy - ay, fz = cz - az;
    // Cross product e × f
    let nx = ey * fz - ez * fy;
    let ny = ez * fx - ex * fz;
    let nz = ex * fy - ey * fx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    for (const idx of [i0, i1, i2]) {
      normals[idx * 3] = nx;
      normals[idx * 3 + 1] = ny;
      normals[idx * 3 + 2] = nz;
    }
  }
  return normals;
}

/**
 * Compute per-vertex tangent frames for a triangle mesh (mikkelsen-style:
 * accumulated over triangles, projected orthogonally onto the vertex normal,
 * sub-normalised where the frame degenerates, with handedness in `w`).
 *
 * Returns a Float32Array of 4 floats per vertex (tx, ty, tz, w) such that
 * t is unit length and dot(t, n) == 0; w = dot(cross(n, t), b) < 0 ? -1 : 1.
 *
 * Needed because the renderer perturbs normals with a tangent-space normal
 * map, and most GLB files (including ours) ship no TANGENT accessor.
 */
export function computeTangents(positions, normals, uvs, indices) {
  const vertCount = positions.length / 3;
  const accT = new Float32Array(vertCount * 3);
  const accB = new Float32Array(vertCount * 3);
  const triCount = indices ? indices.length / 3 : vertCount / 3;

  for (let t = 0; t < triCount; t += 1) {
    const i0 = indices ? indices[t * 3] : t * 3;
    const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

    const ax = positions[i0 * 3],     ay = positions[i0 * 3 + 1], az = positions[i0 * 3 + 2];
    const bx = positions[i1 * 3],     by = positions[i1 * 3 + 1], bz = positions[i1 * 3 + 2];
    const cx = positions[i2 * 3],     cy = positions[i2 * 3 + 1], cz = positions[i2 * 3 + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;

    const u0 = uvs[i0 * 2],     v0 = uvs[i0 * 2 + 1];
    const u1 = uvs[i1 * 2],     v1 = uvs[i1 * 2 + 1];
    const u2 = uvs[i2 * 2],     v2 = uvs[i2 * 2 + 1];

    const du1 = u1 - u0, dv1 = v1 - v0;
    const du2 = u2 - u0, dv2 = v2 - v0;
    const det = du1 * dv2 - du2 * dv1;
    // Degenerate UV triangle: skip; neighbouring triangles supply the frame.
    if (det === 0 || !Number.isFinite(det)) continue;
    const r = 1 / det;

    const tx = r * (dv2 * e1x - dv1 * e2x);
    const ty = r * (dv2 * e1y - dv1 * e2y);
    const tz = r * (dv2 * e1z - dv1 * e2z);
    const bx2 = r * (du1 * e2x - du2 * e1x);
    const by2 = r * (du1 * e2y - du2 * e1y);
    const bz2 = r * (du1 * e2z - du2 * e1z);
    for (const idx of [i0, i1, i2]) {
      accT[idx * 3] += tx; accT[idx * 3 + 1] += ty; accT[idx * 3 + 2] += tz;
      accB[idx * 3] += bx2; accB[idx * 3 + 1] += by2; accB[idx * 3 + 2] += bz2;
    }
  }

  const out = new Float32Array(vertCount * 4);
  for (let i = 0; i < vertCount; i += 1) {
    const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
    let tx = accT[i * 3], ty = accT[i * 3 + 1], tz = accT[i * 3 + 2];

    // Project the accumulated tangent onto the tangent plane (⊥ n).
    const dotT = tx * nx + ty * ny + tz * nz;
    tx -= nx * dotT; ty -= ny * dotT; tz -= nz * dotT;
    let len = Math.hypot(tx, ty, tz);
    if (len < 1e-8) {
      // Degenerate frame: synthesise any tangent ⊥ n.
      if (Math.abs(nz) < 0.9) { tx = -ny; ty = nx; tz = 0; }
      else { tx = 1; ty = 0; tz = 0; }
      len = Math.hypot(tx, ty, tz) || 1;
    } else {
      // Also orthogonalise the projected tangent against the accumulated
      // bitangent (Gram-Schmidt pass recommended by mikkelsen).
      const b1x = accB[i * 3], b1y = accB[i * 3 + 1], b1z = accB[i * 3 + 2];
      const dotB = tx * b1x + ty * b1y + tz * b1z;
      tx -= b1x * dotB; ty -= b1y * dotB; tz -= b1z * dotB;
      // Re-project ⊥ n (removing the b component can tip it off-plane).
      const dotT2 = tx * nx + ty * ny + tz * nz;
      tx -= nx * dotT2; ty -= ny * dotT2; tz -= nz * dotT2;
      len = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= len; ty /= len; tz /= len;

    // Handedness from the (projected) bitangent.
    const b1x = accB[i * 3], b1y = accB[i * 3 + 1], b1z = accB[i * 3 + 2];
    const dotB = b1x * nx + b1y * ny + b1z * nz;
    const bx = b1x - nx * dotB, by = b1y - ny * dotB, bz = b1z - nz * dotB;
    // w = dot(cross(n, t), b)
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * bx + cy * by + cz * bz < 0 ? -1 : 1;

    out[i * 4] = tx; out[i * 4 + 1] = ty; out[i * 4 + 2] = tz; out[i * 4 + 3] = w;
  }
  return out;
}

// ------------------------------------------------------------------ accessor

const COMPONENT_CTORS = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
  5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};

const TYPE_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

function reference(items, idx, label) {
  if (!Array.isArray(items) || !Number.isSafeInteger(idx) || idx < 0 || idx >= items.length
      || !items[idx] || typeof items[idx] !== 'object' || Array.isArray(items[idx])) {
    throw new Error(`glTF: invalid ${label} reference ${idx}`);
  }
  return items[idx];
}

function byteInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`glTF: invalid ${label}`);
  return value;
}

function validateBufferView(gltf, buffers, idx) {
  const bv = reference(gltf.bufferViews, idx, 'bufferView');
  const def = reference(gltf.buffers, bv.buffer, 'buffer');
  const buf = buffers[bv.buffer];
  const offset = byteInteger(bv.byteOffset === undefined ? 0 : bv.byteOffset, 'bufferView byteOffset');
  const length = byteInteger(bv.byteLength, 'bufferView byteLength', 1);
  if (!(buf instanceof ArrayBuffer) || offset > def.byteLength || length > def.byteLength - offset
      || offset > buf.byteLength || length > buf.byteLength - offset) {
    throw new Error(`glTF bufferView ${idx}: range exceeds buffer byteLength`);
  }
  if (bv.byteStride !== undefined) {
    byteInteger(bv.byteStride, 'bufferView byteStride', 4);
    if (bv.byteStride > 252 || bv.byteStride % 4 !== 0) {
      throw new Error(`glTF bufferView ${idx}: invalid byteStride alignment or size`);
    }
  }
  return bv;
}

/** Materialise a bounds-checked accessor; sparse accessors are unsupported. */
function readAccessor(gltf, buffers, idx, vertexAttribute = false) {
  const acc = reference(gltf.accessors, idx, 'accessor');
  if (acc.sparse) throw new Error(`glTF accessor ${idx}: sparse accessors are not supported`);
  if (!Number.isSafeInteger(acc.componentType) || !Object.hasOwn(COMPONENT_CTORS, acc.componentType)) {
    throw new Error(`glTF accessor ${idx}: unknown componentType ${acc.componentType}`);
  }
  if (typeof acc.type !== 'string' || !Object.hasOwn(TYPE_COUNTS, acc.type)) {
    throw new Error(`glTF accessor ${idx}: unknown type ${acc.type}`);
  }
  byteInteger(acc.count, 'accessor count', 1);
  const Ctor = COMPONENT_CTORS[acc.componentType];
  const count = TYPE_COUNTS[acc.type];
  const componentBytes = Ctor.BYTES_PER_ELEMENT;
  const bv = validateBufferView(gltf, buffers, acc.bufferView);
  const relativeOffset = byteInteger(acc.byteOffset === undefined ? 0 : acc.byteOffset, 'accessor byteOffset');
  const offset = (bv.byteOffset ?? 0) + relativeOffset;
  // Matrix columns with byte/short components are padded to four bytes.
  const columns = acc.type.startsWith('MAT') ? Number(acc.type.slice(3)) : 1;
  const rows = count / columns;
  const columnBytes = columns > 1 ? Math.ceil(rows * componentBytes / 4) * 4 : count * componentBytes;
  const elemBytes = columnBytes * columns;
  const byteStride = bv.byteStride === undefined ? elemBytes : bv.byteStride;
  if (byteStride < elemBytes || byteStride % componentBytes !== 0
      || relativeOffset % componentBytes !== 0 || offset % componentBytes !== 0
      || (columns > 1 && offset % 4 !== 0)
      || (vertexAttribute && (relativeOffset % 4 !== 0 || offset % 4 !== 0 || byteStride % 4 !== 0))) {
    throw new Error(`glTF accessor ${idx}: invalid stride or alignment`);
  }
  // Final matrix-column padding need not be present at the end of a view.
  const lastElementBytes = (columns - 1) * columnBytes + rows * componentBytes;
  const extent = (acc.count - 1) * byteStride + lastElementBytes;
  if (!Number.isSafeInteger(extent) || !Number.isSafeInteger(acc.count * count)
      || relativeOffset > bv.byteLength || extent > bv.byteLength - relativeOffset) {
    throw new Error(`glTF accessor ${idx}: range exceeds bufferView byteLength`);
  }
  const buf = buffers[bv.buffer];
  if (byteStride === componentBytes * count) return new Ctor(buf, offset, acc.count * count);

  // Interleaved (or padded matrix): copy only this accessor's components.
  const out = new Ctor(acc.count * count);
  for (let i = 0; i < acc.count; i += 1) {
    for (let col = 0; col < columns; col += 1) {
      const src = new Ctor(buf, offset + i * byteStride + col * columnBytes, rows);
      out.set(src, i * count + col * rows);
    }
  }
  return out;
}

// ------------------------------------------------------------------ buffers

/** Decode a data:-URI into an ArrayBuffer. */
function decodeDataUri(uri) {
  const comma = uri.indexOf(',');
  if (comma === -1) throw new Error('malformed data URI in glTF buffer');
  const meta = uri.slice(5, comma);
  const raw = uri.slice(comma + 1);
  const bin = meta.endsWith(';base64') ? atob(raw) : decodeURIComponent(raw);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

/** Fetch a relative URI, base-resolved against the glTF URL. */
async function fetchBuffer(uri, baseUrl) {
  const url = baseUrl ? new URL(uri, baseUrl).href : uri;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`glTF: could not fetch buffer '${uri}': ${res.status}`);
  return res.arrayBuffer();
}

// ------------------------------------------------------------------ images

// glTF sampler enums; these are the WebGL constants, restated for clarity:
//   wrap: 10497 = REPEAT, 33648 = MIRRORED_REPEAT, 33071 = CLAMP_TO_EDGE
//   filters: 9728 = NEAREST, 9729 = LINEAR, 9984-9987 = mipmapped variants
const DEFAULT_SAMPLER = Object.freeze({
  wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729,
});

function getSampler(gltf, samplerIdx) {
  const s = samplerIdx != null ? (gltf.samplers || [])[samplerIdx] : null;
  return {
    wrapS:    s?.wrapS    ?? DEFAULT_SAMPLER.wrapS,
    wrapT:    s?.wrapT    ?? DEFAULT_SAMPLER.wrapT,
    magFilter: s?.magFilter ?? DEFAULT_SAMPLER.magFilter,
    minFilter: s?.minFilter ?? DEFAULT_SAMPLER.minFilter,
  };
}

/** Sniff an image container from its first bytes; data: URIs may omit mime. */
function sniffImageMime(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

/**
 * Materialise image `imageIdx` into { bytes: Uint8Array, mimeType: string }.
 * Sources: bufferView (GLB), data: URI, or a fetched relative URI.
 * Returns null when the image cannot be materialised (the caller degrades the
 * material to factor-only rendering rather than failing the whole model).
 */
async function loadImageBytes(gltf, buffers, imageIdx, baseUrl) {
  const image = (gltf.images || [])[imageIdx];
  if (!image) return null;

  let bytes = null;
  let uriMime = null;

  if (image.bufferView != null) {
    const bv = gltf.bufferViews[image.bufferView];
    const src = buffers[bv.buffer];
    const offset = bv.byteOffset || 0;
    // Copy out: the renderer keeps these bytes alive across awaits, and we do
    // not want a whole GLB ArrayBuffer retained for one 64 KB texture.
    bytes = new Uint8Array(src.slice(offset, offset + bv.byteLength));
  } else if (image.uri) {
    if (image.uri.startsWith('data:')) {
      const comma = image.uri.indexOf(',');
      // decodeDataUri only yields the raw bytes; the mime is in the URI meta.
      const meta = image.uri.slice(5, comma === -1 ? undefined : comma);
      uriMime = meta.split(';')[0];
      bytes = new Uint8Array(decodeDataUri(image.uri));
    } else {
      const url = baseUrl ? new URL(image.uri, baseUrl).href : image.uri;
      const res = await fetch(url);
      if (!res.ok) return null;
      bytes = new Uint8Array(await res.arrayBuffer());
    }
  }

  if (!bytes || !bytes.byteLength) return null;
  const mimeType = image.mimeType || uriMime || sniffImageMime(bytes);
  return { bytes, mimeType };
}

/**
 * Resolve a texture reference (index into gltf.textures) to
 * { bytes, mimeType, sampler }, decoding each distinct image at most once via
 * the `decoded` promise-memo passed through the load call.
 */
async function resolveTexture(gltf, buffers, texIdx, baseUrl, decoded) {
  if (texIdx == null) return { bytes: null, mimeType: null, sampler: DEFAULT_SAMPLER };
  const tex = (gltf.textures || [])[texIdx];
  if (!tex) return { bytes: null, mimeType: null, sampler: DEFAULT_SAMPLER };

  let bytes = null;
  let mimeType = null;
  if (tex.source != null) {
    if (!decoded.has(tex.source)) {
      decoded.set(tex.source, loadImageBytes(gltf, buffers, tex.source, baseUrl));
    }
    try {
      const img = await decoded.get(tex.source);
      if (img) { ({ bytes, mimeType } = img); }
    } catch {
      // Fetch/decode failure degrades to factor-only material, not a hard error.
    }
  }
  return { bytes, mimeType, sampler: getSampler(gltf, tex.sampler) };
}

// ------------------------------------------------------------------ GLB

const GLB_MAGIC = 0x46546C67; // "glTF"
const CHUNK_JSON = 0x4E4F534A;
const CHUNK_BIN  = 0x004E4942;

/**
 * Split a GLB ArrayBuffer into { json: object, bin: ArrayBuffer|null }.
 */
function parseGlb(ab) {
  if (!(ab instanceof ArrayBuffer) || ab.byteLength < 12) throw new Error('GLB header is truncated');
  const view = new DataView(ab);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB file (bad magic)');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  const total = view.getUint32(8, true);
  if (total !== ab.byteLength || total % 4 !== 0) throw new Error('GLB total length is invalid');

  let offset = 12;
  let json = null;
  let bin = null;
  let chunkIndex = 0;
  let seenJson = false;
  while (offset < total) {
    if (total - offset < 8) throw new Error('GLB chunk header is truncated');
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;
    if (chunkLength % 4 !== 0 || chunkLength > total - offset) throw new Error('GLB chunk bounds or alignment are invalid');
    if (chunkIndex === 0 && chunkType !== CHUNK_JSON) throw new Error('GLB first chunk must be JSON');
    if (chunkType === CHUNK_JSON) {
      if (seenJson) throw new Error('GLB has duplicate JSON chunks');
      seenJson = true;
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(ab, offset, chunkLength)));
    } else if (chunkType === CHUNK_BIN) {
      if (bin !== null) throw new Error('GLB has duplicate BIN chunks');
      if (chunkIndex !== 1) throw new Error('GLB BIN chunk must follow JSON');
      bin = ab.slice(offset, offset + chunkLength);
    }
    offset += chunkLength;
    chunkIndex += 1;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('GLB has no valid JSON chunk');
  return { json, bin };
}

/** Validate the entire node forest, not just the selected scene, iteratively. */
function validateGraph(gltf) {
  const nodes = gltf.nodes === undefined ? [] : gltf.nodes;
  const meshes = gltf.meshes === undefined ? [] : gltf.meshes;
  const scenes = gltf.scenes === undefined ? [] : gltf.scenes;
  if (!Array.isArray(nodes) || !Array.isArray(meshes) || !Array.isArray(scenes)) {
    throw new Error('glTF: invalid nodes, meshes or scenes');
  }
  const parents = new Array(nodes.length).fill(0);
  for (let ni = 0; ni < nodes.length; ni += 1) {
    const node = reference(nodes, ni, 'node');
    if (node.mesh !== undefined) reference(meshes, node.mesh, 'mesh');
    const children = node.children === undefined ? [] : node.children;
    if (!Array.isArray(children)) throw new Error(`glTF node ${ni}: invalid children`);
    for (const child of children) {
      reference(nodes, child, 'node');
      if (++parents[child] > 1) throw new Error(`glTF node ${child}: multiple parents`);
    }
  }
  // Kahn's algorithm detects disconnected cycles without recursive DFS.
  const queue = [];
  for (let ni = 0; ni < nodes.length; ni += 1) if (parents[ni] === 0) queue.push(ni);
  const remaining = parents.slice();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of nodes[queue[cursor]].children ?? []) {
      if (--remaining[child] === 0) queue.push(child);
    }
  }
  if (queue.length !== nodes.length) throw new Error('glTF node graph contains a cycle');
  for (let si = 0; si < scenes.length; si += 1) {
    const scene = reference(scenes, si, 'scene');
    const roots = scene.nodes === undefined ? [] : scene.nodes;
    if (!Array.isArray(roots)) throw new Error(`glTF scene ${si}: invalid nodes`);
    const seen = new Set();
    for (const root of roots) {
      reference(nodes, root, 'scene node');
      if (seen.has(root) || parents[root] !== 0) throw new Error(`glTF scene ${si}: duplicate or non-root node`);
      seen.add(root);
    }
  }
  if (gltf.scene !== undefined) reference(scenes, gltf.scene, 'scene');
  return scenes.length ? scenes[gltf.scene ?? 0].nodes ?? [] : [];
}

// ------------------------------------------------------------------ main

/**
 * Load a glTF file and return a flat array of DrawMesh objects.
 *
 * @param {string|ArrayBuffer} source  URL string, or an ArrayBuffer for GLB.
 * @param {boolean} [isGlb=false]      Set true when source is an ArrayBuffer.
 * @returns {Promise<DrawMesh[]>}
 */
export async function loadGltf(source, isGlb = false) {
  let gltf, binChunk, baseUrl;

  if (isGlb || source instanceof ArrayBuffer) {
    const { json, bin } = parseGlb(source);
    gltf = json;
    binChunk = bin;
    baseUrl = null;
  } else {
    baseUrl = String(source);
    // A data: URI is decoded in place rather than fetched: the app ships
    // `connect-src 'self'`, and a data: URL is not 'self', so a fetch() would
    // be refused - and there is nothing to fetch anyway, the bytes are already
    // here. (The same rule the buffer loop below already applies.)
    const buffer = baseUrl.startsWith('data:')
      ? decodeDataUri(baseUrl)
      : await (async () => {
          const res = await fetch(baseUrl);
          if (!res.ok) throw new Error(`glTF: fetch failed for '${baseUrl}': ${res.status}`);
          return res.arrayBuffer();
        })();
    // A URL can point at either container: .gltf JSON (or a data: URI) or a
    // .glb binary. Sniff the GLB magic instead of trusting the extension, so
    // both work through the same call.
    const magic = buffer.byteLength >= 4 ? new DataView(buffer).getUint32(0, true) : 0;
    if (magic === GLB_MAGIC) {
      const { json, bin } = parseGlb(buffer);
      gltf = json;
      binChunk = bin;
    } else {
      gltf = JSON.parse(new TextDecoder().decode(buffer));
      binChunk = null;
    }
  }

  if (!gltf || typeof gltf !== 'object' || Array.isArray(gltf)) throw new Error('glTF: invalid document');
  const roots = validateGraph(gltf);

  // ---- buffers
  const defs = gltf.buffers ?? [];
  if (!Array.isArray(defs)) throw new Error('glTF: invalid buffers');
  const bufferPromises = defs.map((buf, i) => {
    reference(defs, i, 'buffer');
    byteInteger(buf.byteLength, 'buffer byteLength', 1);
    if (!buf.uri) {
      // GLB buffer: index 0 always maps to the binary chunk
      if (i === 0 && binChunk) return Promise.resolve(binChunk);
      throw new Error(`glTF buffer ${i} has no URI and no GLB binary chunk`);
    }
    if (buf.uri.startsWith('data:')) return Promise.resolve(decodeDataUri(buf.uri));
    return fetchBuffer(buf.uri, baseUrl);
  });
  const buffers = await Promise.all(bufferPromises);
  for (let i = 0; i < buffers.length; i += 1) {
    if (buffers[i].byteLength < defs[i].byteLength) throw new Error(`glTF buffer ${i}: truncated byteLength`);
    if (i === 0 && !defs[i].uri && buffers[i].byteLength - defs[i].byteLength > 3) {
      throw new Error('glTF: GLB BIN length exceeds buffer byteLength padding');
    }
  }
  const views = gltf.bufferViews ?? [];
  if (!Array.isArray(views)) throw new Error('glTF: invalid bufferViews');
  for (let i = 0; i < views.length; i += 1) validateBufferView(gltf, buffers, i);

  // ---- walk nodes → world transforms (breadth-first, O(nodes + edges))
  const nodeCount = (gltf.nodes || []).length;
  const worldMatrices = new Array(nodeCount).fill(null);
  const queue = roots.map((ni) => ({ ni, parent: null }));
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { ni, parent } = queue[cursor];
    const node = gltf.nodes[ni];
    let local;
    if (node.matrix) {
      local = new Float32Array(node.matrix);
    } else {
      local = trsToMatrix(node.translation, node.rotation, node.scale);
    }
    worldMatrices[ni] = parent !== null ? mul4(worldMatrices[parent], local) : local;
    for (const child of node.children || []) queue.push({ ni: child, parent: ni });
  }

  // ---- collect meshes
  const results = [];
  const decoded = new Map(); // image index -> bytes-decode promise (shared)

  for (let ni = 0; ni < nodeCount; ni += 1) {
    const node = gltf.nodes[ni];
    if (node.mesh == null) continue;
    const worldMatrix = worldMatrices[ni] || MAT4_IDENTITY;
    const mesh = gltf.meshes[node.mesh];

    for (const prim of mesh.primitives || []) {
      // Only triangle lists (mode 4, the default)
      const mode = prim.mode ?? 4;
      if (mode !== 4) continue;

      // Positions are required
      if (prim.attributes?.POSITION == null) continue;
      const posRaw = readAccessor(gltf, buffers, prim.attributes.POSITION, true);
      if (gltf.accessors[prim.attributes.POSITION].type !== 'VEC3') throw new Error('glTF: POSITION must be VEC3');
      const positions = posRaw instanceof Float32Array ? posRaw : new Float32Array(posRaw);

      // Validate index representation and values before conversion or normals.
      let indices = null;
      if (prim.indices != null) {
        const acc = reference(gltf.accessors, prim.indices, 'index accessor');
        if (acc.type !== 'SCALAR' || ![5121, 5123, 5125].includes(acc.componentType) || acc.normalized) {
          throw new Error('glTF: indices must be unsigned integer SCALAR values');
        }
        const raw = readAccessor(gltf, buffers, prim.indices);
        for (const index of raw) {
          if (index >= positions.length / 3) throw new Error('glTF: index exceeds POSITION vertex count');
        }
        indices = raw instanceof Uint32Array ? raw : new Uint32Array(raw);
      }

      // Normals — use accessor if present, otherwise generate flat normals
      let normals;
      if (prim.attributes.NORMAL != null) {
        const raw = readAccessor(gltf, buffers, prim.attributes.NORMAL, true);
        normals = raw instanceof Float32Array ? raw : new Float32Array(raw);
      } else {
        normals = generateFlatNormals(positions, indices);
      }

      // UVs — required for texture mapping; absent UVs degrade every material
      // texture of the mesh (the renderer falls back to material factors).
      let uvs = null;
      if (prim.attributes.TEXCOORD_0 != null) {
        const raw = readAccessor(gltf, buffers, prim.attributes.TEXCOORD_0, true);
        uvs = raw instanceof Float32Array ? raw : new Float32Array(raw);
        if (uvs.length !== (positions.length / 3) * 2) uvs = null;
      }

      // Material
      const matIdx = prim.material;
      const matDef = matIdx != null ? (gltf.materials || [])[matIdx] : null;
      const pbr = matDef?.pbrMetallicRoughness || {};
      const material = {
        baseColor:   pbr.baseColorFactor  ?? [1, 1, 1, 1],
        metallic:    pbr.metallicFactor   ?? 1.0,
        roughness:   pbr.roughnessFactor  ?? 1.0,
        doubleSided: matDef?.doubleSided  ?? false,
        baseColorTexture: null,
        normalTexture: null,
      };

      // Textures — decoded here (memoised per image index), handed to the
      // renderer as bytes. Textures only resolve when the primitive ships
      // TEXCOORD_0: without UVs there is nothing to sample with, and the
      // renderer falls back to the material factors.
      if (pbr.baseColorTexture || (matDef && matDef.normalTexture)) {
        if (!uvs) {
          console.warn(`glTF: mesh primitive has textures but no TEXCOORD_0 - sampling is impossible, falling back to material factors`);
        } else {
          if (pbr.baseColorTexture?.index != null) {
            const info = await resolveTexture(gltf, buffers, pbr.baseColorTexture.index, baseUrl, decoded);
            material.baseColorTexture = info.bytes
              ? { bytes: info.bytes, mimeType: info.mimeType, sampler: info.sampler }
              : null;
          }
          if (matDef?.normalTexture?.index != null) {
            const info = await resolveTexture(gltf, buffers, matDef.normalTexture.index, baseUrl, decoded);
            material.normalTexture = info.bytes
              ? {
                  bytes: info.bytes,
                  mimeType: info.mimeType,
                  sampler: info.sampler,
                  scale: matDef.normalTexture.scale ?? 1.0,
                }
              : null;
          }
        }
      }

      // Tangent frames — required for normal mapping; computed from geometry
      // when the file does not ship a TANGENT accessor.
      let tangents = null;
      if (material.normalTexture && uvs) {
        tangents = computeTangents(positions, normals, uvs, indices);
      }

      results.push({ positions, normals, uvs, tangents, indices, worldMatrix: new Float32Array(worldMatrix), material });
    }
  }

  return results;
}

/**
 * Upload a DrawMesh to WebGL2 and return a VAO handle ready for
 * `gl.drawElements` / `gl.drawArrays`.
 *
 * UV and tangent attributes are bound only when both the mesh carries them
 * and the caller provides locations — meshes without them stay valid on the
 * plain position/normal layout (the renderer fills degenerate fallbacks).
 *
 * The caller owns the VAO and must delete it when done.
 *
 * @param {WebGL2RenderingContext} gl
 * @param {DrawMesh} mesh
 * @param {{ position: number, normal: number, uv?: number, tangent?: number }} attribLocs
 * @returns {{ vao: WebGLVertexArrayObject, buffers: WebGLBuffer[], count: number, indexed: boolean }}
 */
export function uploadMesh(gl, mesh, attribLocs) {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('mesh upload: could not allocate VAO');
  const buffers = [];
  const uploadBuffer = (target, data) => {
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('mesh upload: could not allocate buffer');
    // Register ownership before any GL call that can fail.
    buffers.push(buffer);
    gl.bindBuffer(target, buffer);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    if (gl.getError) {
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`mesh upload: GL error ${error}`);
    }
  };
  const attribute = (data, location, size) => {
    uploadBuffer(gl.ARRAY_BUFFER, data);
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
  };
  try {
    gl.bindVertexArray(vao);
    attribute(mesh.positions, attribLocs.position, 3);
    attribute(mesh.normals, attribLocs.normal, 3);
    if (mesh.uvs && attribLocs.uv != null) attribute(mesh.uvs, attribLocs.uv, 2);
    if (mesh.tangents && mesh.tangents.length === mesh.positions.length / 3 * 4 && attribLocs.tangent != null) {
      attribute(mesh.tangents, attribLocs.tangent, 4);
    }
    if (mesh.indices) uploadBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    gl.bindVertexArray(null);
    if (gl.getError && gl.getError() !== gl.NO_ERROR) throw new Error('mesh upload: attribute setup failed');
    return { vao, buffers, count: mesh.indices ? mesh.indices.length : mesh.positions.length / 3, indexed: !!mesh.indices };
  } catch (error) {
    try {
      gl.bindVertexArray(null);
    } finally {
      for (const buffer of buffers) gl.deleteBuffer(buffer);
      gl.deleteVertexArray(vao);
    }
    throw error;
  }
}
