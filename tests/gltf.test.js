/**
 * M3 – glTF 2.0 loader tests.
 *
 * All tests run in bare Node (no WebGL2 needed): we test the parsing,
 * accessor materialisation, flat-normal generation, TRS matrix composition and
 * GLB header parsing.  The uploadMesh helper is WebGL2-only; that path is
 * covered by the renderer's browser-only skip tests.
 */
import { loadGltf, computeTangents } from '../src/graphics/gltf.js';
import { test, assert, assertEquals } from './harness.js';

// ------------------------------------------------------------------ helpers

/**
 * Build the smallest legal glTF that contains one triangle and return it as a
 * data:-URI so loadGltf can fetch it without a network.
 *
 * Triangle vertices: (0,0,0) (1,0,0) (0,1,0) — lying in the XY plane.
 * Expected flat normal: (0,0,1) for each vertex.
 */
function makeTriangleGltf({ includeNormals = false, includeMaterial = false, useIndices = true } = {}) {
  const positions = new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]);
  const indices   = new Uint16Array([0, 1, 2]);

  // Pack everything into one binary buffer: positions, then optionally normals,
  // then optionally indices.
  const bufs = [positions];
  if (includeNormals) bufs.push(new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]));
  if (useIndices) bufs.push(indices);

  const totalBytes = bufs.reduce((sum, b) => sum + b.byteLength, 0);
  const combined   = new Uint8Array(totalBytes);
  let off = 0;
  for (const b of bufs) {
    combined.set(new Uint8Array(b.buffer), off);
    off += b.byteLength;
  }
  const b64 = btoa(String.fromCharCode(...combined));
  const uri = `data:application/octet-stream;base64,${b64}`;

  // --- glTF JSON --
  let bvIdx = 0;
  const bufferViews = [];
  const accessors = [];
  let offset = 0;

  // POSITION accessor (VEC3 FLOAT)
  bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: positions.byteLength });
  accessors.push({ bufferView: bvIdx++, byteOffset: 0, componentType: 5126, type: 'VEC3', count: 3 });
  offset += positions.byteLength;

  let normalAccessorIdx = null;
  if (includeNormals) {
    const normBuf = new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]);
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: normBuf.byteLength });
    normalAccessorIdx = accessors.length;
    accessors.push({ bufferView: bvIdx++, byteOffset: 0, componentType: 5126, type: 'VEC3', count: 3 });
    offset += normBuf.byteLength;
  }

  let indexAccessorIdx = null;
  if (useIndices) {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: indices.byteLength });
    indexAccessorIdx = accessors.length;
    accessors.push({ bufferView: bvIdx++, byteOffset: 0, componentType: 5123, type: 'SCALAR', count: 3 });
    offset += indices.byteLength;
  }

  const primitive = {
    attributes: { POSITION: 0 },
    mode: 4,
  };
  if (normalAccessorIdx !== null) primitive.attributes.NORMAL = normalAccessorIdx;
  if (indexAccessorIdx  !== null) primitive.indices = indexAccessorIdx;

  const materials = includeMaterial ? [
    {
      pbrMetallicRoughness: {
        baseColorFactor: [0.8, 0.4, 0.2, 1.0],
        metallicFactor: 0.3,
        roughnessFactor: 0.7,
      },
      doubleSided: true,
    },
  ] : [];

  if (includeMaterial) primitive.material = 0;

  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [primitive] }],
    accessors,
    bufferViews,
    buffers: [{ uri, byteLength: totalBytes }],
    ...(materials.length ? { materials } : {}),
  };

  const json = JSON.stringify(gltf);
  const jsonB64 = btoa(unescape(encodeURIComponent(json)));
  return `data:model/gltf+json;base64,${jsonB64}`;
}

/**
 * Build a minimal GLB ArrayBuffer from a glTF JSON + optional binary chunk.
 */
function makeGlb(json, binBytes = null) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  // JSON chunk must be padded to 4-byte boundary with 0x20 (space)
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonChunkLen = jsonBytes.length + jsonPad;

  const hasBin = binBytes instanceof ArrayBuffer && binBytes.byteLength > 0;
  const binPad = hasBin ? (4 - (binBytes.byteLength % 4)) % 4 : 0;
  const binChunkLen = hasBin ? binBytes.byteLength + binPad : 0;

  const headerLen = 12;
  const jsonHeaderLen = 8;
  const binHeaderLen = hasBin ? 8 : 0;
  const total = headerLen + jsonHeaderLen + jsonChunkLen + binHeaderLen + binChunkLen;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  let off = 0;

  view.setUint32(off, 0x46546C67, true); off += 4; // magic
  view.setUint32(off, 2, true); off += 4; // version
  view.setUint32(off, total, true); off += 4; // length

  view.setUint32(off, jsonChunkLen, true); off += 4;
  view.setUint32(off, 0x4E4F534A, true); off += 4; // JSON
  new Uint8Array(buf, off, jsonBytes.length).set(jsonBytes); off += jsonBytes.length;
  for (let i = 0; i < jsonPad; i++) { view.setUint8(off, 0x20); off++; }

  if (hasBin) {
    view.setUint32(off, binChunkLen, true); off += 4;
    view.setUint32(off, 0x004E4942, true); off += 4; // BIN
    new Uint8Array(buf, off, binBytes.byteLength).set(new Uint8Array(binBytes)); off += binBytes.byteLength;
    for (let i = 0; i < binPad; i++) { view.setUint8(off, 0); off++; }
  }

  return buf;
}

// ------------------------------------------------------------------ tests

test('M3: glTF loader returns one mesh for a single-node triangle scene', async () => {
  const url = makeTriangleGltf();
  const meshes = await loadGltf(url);
  assertEquals(meshes.length, 1, 'expected exactly one mesh');
});

test('M3: glTF loader produces correct positions for the triangle', async () => {
  const url = makeTriangleGltf();
  const [mesh] = await loadGltf(url);
  // 3 vertices × 3 floats = 9 values
  assertEquals(mesh.positions.length, 9, 'position array length');
  const first = [mesh.positions[0], mesh.positions[1], mesh.positions[2]];
  assertEquals(first.join(','), '0,0,0', 'first vertex is origin');
});

test('M3: glTF loader generates flat normals when NORMAL is absent', async () => {
  const url = makeTriangleGltf({ includeNormals: false });
  const [mesh] = await loadGltf(url);
  assertEquals(mesh.normals.length, 9, 'normals have same count as positions');
  // Triangle in XY plane → normal should be (0,0,1)
  const n = [mesh.normals[0], mesh.normals[1], mesh.normals[2]];
  assert(Math.abs(n[0]) < 1e-5 && Math.abs(n[1]) < 1e-5 && Math.abs(n[2] - 1) < 1e-5,
    `expected flat normal (0,0,1), got (${n.join(',')})`);
});

test('M3: glTF loader uses provided normals when NORMAL accessor is present', async () => {
  const url = makeTriangleGltf({ includeNormals: true });
  const [mesh] = await loadGltf(url);
  const n = [mesh.normals[0], mesh.normals[1], mesh.normals[2]];
  assert(Math.abs(n[2] - 1) < 1e-5, `expected provided normal (0,0,1), got (${n.join(',')})`);
});

test('M3: glTF loader reads indices and converts to Uint32Array', async () => {
  const url = makeTriangleGltf({ useIndices: true });
  const [mesh] = await loadGltf(url);
  assert(mesh.indices instanceof Uint32Array, 'indices must be Uint32Array');
  assertEquals(mesh.indices.length, 3, '3 index values for one triangle');
  assertEquals(Array.from(mesh.indices).join(','), '0,1,2');
});

test('M3: glTF loader returns null indices for non-indexed mesh', async () => {
  const url = makeTriangleGltf({ useIndices: false });
  const [mesh] = await loadGltf(url);
  assertEquals(mesh.indices, null, 'non-indexed mesh should have null indices');
});

test('M3: glTF loader reads PBR metallic-roughness material', async () => {
  const url = makeTriangleGltf({ includeMaterial: true });
  const [mesh] = await loadGltf(url);
  const m = mesh.material;
  assert(m, 'mesh must have a material');
  assertEquals(m.metallic.toFixed(2), '0.30', 'metallicFactor');
  assertEquals(m.roughness.toFixed(2), '0.70', 'roughnessFactor');
  assertEquals(m.baseColor[0].toFixed(2), '0.80', 'baseColorFactor[0]');
  assertEquals(m.doubleSided, true, 'doubleSided');
});

test('M3: glTF loader defaults material when no material is assigned', async () => {
  const url = makeTriangleGltf({ includeMaterial: false });
  const [mesh] = await loadGltf(url);
  const m = mesh.material;
  assertEquals(m.metallic, 1.0, 'default metallic');
  assertEquals(m.roughness, 1.0, 'default roughness');
  assertEquals(m.doubleSided, false, 'default doubleSided');
});

test('M3: glTF loader identity node produces identity worldMatrix', async () => {
  const url = makeTriangleGltf();
  const [mesh] = await loadGltf(url);
  // A node with no TRS should produce the identity matrix
  const id = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const wm = Array.from(mesh.worldMatrix).map((v) => Math.round(v));
  assertEquals(wm.join(','), id.join(','), 'world matrix should be identity');
});

test('M3: GLB parsing — load triangle from ArrayBuffer', async () => {
  // Build an inline GLB with the triangle geometry embedded in the binary chunk
  const positions = new Float32Array([0,0,0, 1,0,0, 0,1,0]);
  const indices   = new Uint16Array([0,1,2]);
  const combined  = new Uint8Array(positions.byteLength + indices.byteLength);
  combined.set(new Uint8Array(positions.buffer), 0);
  combined.set(new Uint8Array(indices.buffer), positions.byteLength);

  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    accessors: [
      { bufferView: 0, byteOffset: 0, componentType: 5126, type: 'VEC3', count: 3 },
      { bufferView: 1, byteOffset: 0, componentType: 5123, type: 'SCALAR', count: 3 },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: combined.byteLength }],
  };

  const glb = makeGlb(gltf, combined.buffer);
  const meshes = await loadGltf(glb, true);
  assertEquals(meshes.length, 1, 'one mesh from GLB');
  assertEquals(meshes[0].positions.length, 9, 'positions from GLB binary chunk');

  // The same binary over a URL must be detected from its magic and parsed as
  // GLB, not handed to JSON.parse because the call had no isGlb flag.
  const b64 = btoa(String.fromCharCode(...new Uint8Array(glb)));
  const urlMeshes = await loadGltf(`data:model/gltf-binary;base64,${b64}`);
  assertEquals(urlMeshes.length, 1, 'one mesh from a GLB data: URL');
  assertEquals(urlMeshes[0].positions.length, 9, 'positions from the GLB URL path');
});

test('M3: glTF loader rejects invalid GLB magic', async () => {
  const bad = new ArrayBuffer(12);
  new DataView(bad).setUint32(0, 0xDEADBEEF, true);
  let threw = false;
  try { await loadGltf(bad, true); } catch { threw = true; }
  assert(threw, 'should throw on bad GLB magic');
});

test('M3: glTF loader rejects non-triangle primitive mode', async () => {
  // Build a glTF with mode 1 (LINES) — should return no meshes.
  const positions = new Float32Array([0,0,0, 1,0,0]);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(positions.buffer)));
  const uri = `data:application/octet-stream;base64,${b64}`;
  const gltf = {
    asset: { version: '2.0' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 1 }] }],
    accessors: [{ bufferView: 0, byteOffset: 0, componentType: 5126, type: 'VEC3', count: 2 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: positions.byteLength }],
    buffers: [{ uri, byteLength: positions.byteLength }],
  };
  const jsonB64 = btoa(unescape(encodeURIComponent(JSON.stringify(gltf))));
  const url = `data:model/gltf+json;base64,${jsonB64}`;
  const meshes = await loadGltf(url);
  assertEquals(meshes.length, 0, 'non-triangle mode should yield no meshes');
});

// ------------------------------------------------------------------ textures

// Fabricate PNG-shaped bytes (enough header for the mime sniffer; the Node
// tests never decode, the browser suite does that against the real asset).
function fakePngBytes() {
  const bytes = new Uint8Array(32);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); // PNG signature
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);            // IHDR chunk header
  bytes.set([0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0], 16);         // 2x2 RGBA8 IHDR body
  return bytes;
}

/**
 * The triangle again, but carrying UVs plus a material that references two
 * images (base colour + normal map) through one sampler. The images ride in
 * the same binary buffer as the geometry, exercising the bufferView path and
 * the mime sniffer (the image entries omit mimeType).
 */
function makeTexturedGltf({ withUvs = true, normalScale = 2.5, warn = null } = {}) {
  const positions = new Float32Array([0, 0, 0,  1, 0, 0,  0, 1, 0]);
  const normals   = new Float32Array([0, 0, 1,  0, 0, 1,  0, 0, 1]);
  const uvs       = new Float32Array([0, 0,  1, 0,  0, 1]);
  const indices   = new Uint16Array([0, 1, 2]);
  const png0 = fakePngBytes();
  const png1 = fakePngBytes();

  const chunks = [positions, normals];
  if (withUvs) chunks.push(uvs);
  chunks.push(indices, png0, png1);

  const total = chunks.reduce((n, b) => n + b.byteLength, 0);
  const combined = new Uint8Array(total);
  let off = 0;
  for (const b of chunks) {
    combined.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
    off += b.byteLength;
  }
  const uri = `data:application/octet-stream;base64,${btoa(String.fromCharCode(...combined))}`;

  const bufferViews = [];
  const accessors = [];
  let bvOff = 0;
  let bvIdx = 0;
  const view = (bytes) => {
    bufferViews.push({ buffer: 0, byteOffset: bvOff, byteLength: bytes.byteLength });
    bvOff += bytes.byteLength;
    return bvIdx++;
  };

  const posView  = view(positions);
  const normView = view(normals);
  const uvView   = withUvs ? view(uvs) : null;
  const idxView  = view(indices);
  const imgView0 = view(png0);
  const imgView1 = view(png1);
  const acc = (viewIdx, type, count) => {
    const idx = accessors.length;
    accessors.push({ bufferView: viewIdx, byteOffset: 0, componentType: 5126, type, count });
    return idx;
  };

  const attributes = { POSITION: acc(posView, 'VEC3', 3), NORMAL: acc(normView, 'VEC3', 3) };
  if (uvView !== null) attributes.TEXCOORD_0 = acc(uvView, 'VEC2', 3);

  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{
      primitives: [{ attributes, indices: acc(idxView, 'SCALAR', 3), mode: 4, material: 0 }],
    }],
    accessors,
    bufferViews,
    buffers: [{ uri, byteLength: total }],
    images: [
      { bufferView: imgView0 }, // base colour — mime omitted, must be sniffed
      { bufferView: imgView1 }, // normal map
    ],
    samplers: [{ wrapS: 33071, wrapT: 33648, magFilter: 9728, minFilter: 9987 }],
    textures: [{ source: 0, sampler: 0 }, { source: 1, sampler: 0 }],
    materials: [{
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        baseColorTexture: { index: 0 },
      },
      normalTexture: { index: 1, scale: normalScale },
    }],
  };

  if (warn) {
    const original = console.warn;
    console.warn = warn;
    const teardown = () => { console.warn = original; };
    const jsonB64 = btoa(unescape(encodeURIComponent(JSON.stringify(gltf))));
    const url = `data:model/gltf+json;base64,${jsonB64}`;
    return loadGltf(url).then((meshes) => { teardown(); return meshes; },
      (err) => { teardown(); throw err; });
  }
  const jsonB64 = btoa(unescape(encodeURIComponent(JSON.stringify(gltf))));
  return loadGltf(`data:model/gltf+json;base64,${jsonB64}`);
}

test('M3: glTF loader materialises a base colour texture and honours the sampler', async () => {
  const [mesh] = await makeTexturedGltf();
  const tex = mesh.material.baseColorTexture;
  assert(tex, 'base color texture must resolve from the bufferView image');
  assert(tex.bytes instanceof Uint8Array, 'texture bytes are a Uint8Array');
  assertEquals(tex.bytes.length, 32, 'embedded image byteLength');
  assertEquals(tex.mimeType, 'image/png', 'mime sniffed from the PNG signature');
  assertEquals(tex.sampler.wrapS, 33071, 'wrapS CLAMP_TO_EDGE from the file sampler');
  assertEquals(tex.sampler.wrapT, 33648, 'wrapT MIRRORED_REPEAT from the file sampler');
  assertEquals(tex.sampler.magFilter, 9728, 'magFilter NEAREST from the file sampler');
  assertEquals(tex.sampler.minFilter, 9987, 'minFilter LINEAR_MIPMAP_LINEAR from the file sampler');
});

test('M3: glTF loader carries normalTexture scale and drives mikkelsen tangent generation', async () => {
  const [mesh] = await makeTexturedGltf();
  const tex = mesh.material.normalTexture;
  assert(tex, 'normal texture must resolve');
  assertEquals(tex.scale, 2.5, 'normalTexture scale comes through');
  const t = mesh.tangents;
  assert(t instanceof Float32Array, 'tangents are a Float32Array');
  assertEquals(t.length, mesh.positions.length / 3 * 4, '4 floats per vertex');
  const tl = Math.hypot(t[0], t[1], t[2]);
  assert(Math.abs(tl - 1) < 1e-5, `tangent is unit length (got ${tl})`);
  const dot = t[0] * mesh.normals[0] + t[1] * mesh.normals[1] + t[2] * mesh.normals[2];
  assert(Math.abs(dot) < 1e-5, 'tangent is orthogonal to the normal');
  // u = +X, v = +Y, n = +Z: the mikkelsen frame must be T=(1,0,0), w=+1.
  assert(Math.abs(t[0] - 1) < 1e-5 && Math.abs(t[1]) < 1e-5 && Math.abs(t[2]) < 1e-5,
    `cardinal triangle tangent should be (1,0,0), got (${t[0]},${t[1]},${t[2]})`);
  assertEquals(t[3], 1, 'handedness w is +1 for this winding');
});

test('M3: glTF loader degrades file textures to factors when the mesh has no UVs', async () => {
  const warnings = [];
  const [mesh] = await makeTexturedGltf({
    withUvs: false,
    warn: (...args) => warnings.push(args.join(' ')),
  });
  assertEquals(mesh.material.baseColorTexture, null, 'base colour texture dropped');
  assertEquals(mesh.material.normalTexture, null, 'normal texture dropped');
  assertEquals(mesh.tangents, null, 'no tangents without UVs');
  assertEquals(mesh.material.baseColor.join(','), '1,1,1,1', 'factors kept');
  assert(warnings.length >= 1 && warnings[0].includes('TEXCOORD_0'), 'loader warned about the missing UVs');
});

test('M3: computeTangents skips degenerate UV triangles and stays finite', () => {
  // Two triangles spanning four vertices; the first has a zero-area UV
  // triangle (all three UVs identical). Its vertices must still get a valid
  // frame from the second triangle (or synthesised ones) — never NaN.
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 0, 1, 0,   // triangle A
    1, 0, 0, 1, 1, 0, 0, 1, 0,   // triangle B
  ]);
  const normals = new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  const uvs = new Float32Array([
    0.5, 0.5, 0.5, 0.5, 0.5, 0.5,  // degenerate: det = 0
    1, 0, 1, 1, 0, 1,              // healthy
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  const tangents = computeTangents(positions, normals, uvs, indices);
  assertEquals(tangents.length, 6 * 4, '6 vertices × 4 floats');
  for (let i = 0; i < tangents.length; i += 1) {
    assert(Number.isFinite(tangents[i]), `tangent component ${i} is finite`);
  }
  // Vertex 3 (only touched by the healthy triangle) carries the exact frame.
  const tl = Math.hypot(tangents[12], tangents[13], tangents[14]);
  assert(Math.abs(tl - 1) < 1e-5, `skipped triangle's neighbour still gets a unit tangent (got ${tl})`);
});
