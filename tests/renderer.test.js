import { test, assert, assertEquals, assertThrows } from './harness.js';
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
import { loadGltf, uploadMesh } from '../src/graphics/gltf.js';

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

  // Attach a synthetic DrawMesh through the same path the M3 panel uses for
  // the loaded glTF model: uploadMesh must upload it, the frame must draw it,
  // and it must appear in the stats and the accessible scene description.
  const summary = renderer.attachModel([
    {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      worldMatrix: identity(),
      material: { baseColor: [1, 0.5, 0.25, 1], metallic: 0.2, roughness: 0.6, doubleSided: false },
    },
  ]);
  assertEquals(summary.meshes, 1);
  assertEquals(summary.triangles, 1);
  renderer.frame(48);
  const withModel = renderer.stats();
  assertEquals(withModel.modelMeshes, 1, 'attached model must be drawn');
  assertEquals(withModel.modelTriangles, 1);
  assertEquals(renderer.describeScene().objects.length, 4, 'the glTF model appears in the accessible tree');
  renderer.detachModel();
  renderer.frame(64); // stats() reflect the last drawn frame, so draw one after detaching
  assertEquals(renderer.stats().modelMeshes, 0, 'detachModel must release the model');
  renderer.dispose();
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
  renderer.dispose();
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

// ---------------------------------------------------------------- textures

/**
 * Poll for asynchronously decoded model textures: bitmap decode happens
 * between frames, so the textures do not exist the moment attachModel
 * returns (it is deliberately synchronous).
 */
async function waitForTextures(renderer, count, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  let seen = 0;
  for (;;) {
    seen = renderer.model ? renderer.model.meshes.reduce((n, m) => n + Object.keys(m.textures).length, 0) : 0;
    if (seen >= count) return seen;
    if (performance.now() > deadline) throw new Error(`textures never arrived: wanted ${count}, saw ${seen}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

test('M3: the shipped GLB decodes both material textures and draws without GL errors', async () => {
  const res = await fetch(new URL('../assets/models/singularity-core.glb', import.meta.url));
  assert(res.ok, 'the sample GLB must be reachable from the served tree');
  const meshes = await loadGltf(await res.arrayBuffer(), true);
  assertEquals(meshes.length, 3, 'core + ring + shard');
  const textured = meshes.filter((m) => m.material.baseColorTexture && m.material.normalTexture);
  assertEquals(textured.length, 2, 'core and ring carry both maps');

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  const renderer = new Renderer(canvas, { instances: 0, particles: 0 });
  renderer.init();
  renderer.gl.getError(); // flush any init-time error before attributing one to this test
  const summary = renderer.attachModel(meshes);
  assertEquals(summary.triangles, 2296, 'triangle count of the regenerated asset');
  await waitForTextures(renderer, 4);
  renderer.frame(16);
  const stats = renderer.stats();
  assertEquals(stats.modelMeshes, 3, 'all three primitives drawn');
  assertEquals(stats.modelTextures, 4, 'two materials × (base colour + normal map)');
  assertEquals(renderer.gl.getError(), renderer.gl.NO_ERROR,
    'textured draw pipeline must run clean: program compile, attribute wiring and sRGB sample all valid');
  renderer.detachModel();
  renderer.frame(32);
  assertEquals(renderer.stats().modelTextures, 0, 'detachModel released the textures');
  renderer.dispose();
}, NEEDS_GL);

test('M3: attachModel decodes canvas-rendered textures for a synthetic textured mesh', async () => {
  const png = async (r, g, b) => {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const ctx = c.getContext('2d');
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, 0, 2, 2);
    const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  };
  const baseBytes = await png(250, 120, 60);
  const normalBytes = await png(128, 128, 255); // flat tangent-space normal (+Z)
  const sampler = { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729 };

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const renderer = new Renderer(canvas, { instances: 0, particles: 0 });
  renderer.init();
  renderer.gl.getError();
  const summary = renderer.attachModel([{
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    worldMatrix: identity(),
    material: {
      baseColor: [1, 1, 1, 1],
      metallic: 0.1,
      roughness: 0.5,
      doubleSided: false,
      baseColorTexture: { bytes: baseBytes, mimeType: 'image/png', sampler },
      normalTexture: { bytes: normalBytes, mimeType: 'image/png', sampler, scale: 1.4 },
    },
  }]);
  assertEquals(summary.meshes, 1);
  await waitForTextures(renderer, 2);
  renderer.frame(16);
  assertEquals(renderer.stats().modelTextures, 2, 'both textures decoded and uploaded');
  assertEquals(renderer.gl.getError(), renderer.gl.NO_ERROR,
    'the TBN + normal-map shader must run clean on a textured mesh');
  renderer.detachModel();
  renderer.frame(32);
  assertEquals(renderer.stats().modelTextures, 0, 'detached cleanly');
  renderer.dispose();
}, NEEDS_GL);

// ---------------------------------------------------------------- owned resources / failure injection (also run in Node)

function trackedGL() {
  const live = new Map();
  const created = new Map();
  const deleted = new Map();
  const gl = {
    NO_ERROR: 0,
    OUT_OF_MEMORY: 0x0505,
    bufferDataCalls: 0,
    createBufferCalls: 0,
    texImageCalls: 0,
    boundVao: null,
    error: 0,
    getError() { const error = this.error; this.error = 0; return error; },
    getParameter: () => 4096,
    getExtension: () => null,
    getShaderParameter() { return !this.failCompile; },
    getProgramParameter() { return !this.failLink; },
    getShaderInfoLog: () => 'injected compile failure',
    getProgramInfoLog: () => 'injected link failure',
    getUniformLocation: (_program, name) => name,
    checkFramebufferStatus() { return this.FRAMEBUFFER_COMPLETE; },
    bindVertexArray(vao) { this.boundVao = vao; },
    bufferData() {
      this.bufferDataCalls += 1;
      if (this.bufferDataCalls === this.failBufferDataAt) throw new Error('injected buffer upload failure');
      if (this.bufferDataCalls === this.errorBufferDataAt) this.error = this.OUT_OF_MEMORY;
    },
    texImage2D() {
      this.texImageCalls += 1;
      if (this.texImageCalls === this.failTexImageAt) throw new Error('injected texture upload failure');
    },
  };
  for (const kind of ['Buffer', 'VertexArray', 'Texture', 'Program', 'Framebuffer', 'Shader', 'Query']) {
    live.set(kind, new Set());
    created.set(kind, 0);
    deleted.set(kind, 0);
    gl[`create${kind}`] = () => {
      if (kind === 'Buffer' && ++gl.createBufferCalls === gl.failCreateBufferAt) return null;
      const handle = { kind, id: created.get(kind) + 1 };
      created.set(kind, handle.id);
      live.get(kind).add(handle);
      return handle;
    };
    gl[`delete${kind}`] = (handle) => {
      assert(live.get(kind).delete(handle), `${kind} must be owned and deleted exactly once`);
      deleted.set(kind, deleted.get(kind) + 1);
    };
  }
  for (const name of ['bindBuffer', 'enableVertexAttribArray', 'vertexAttribPointer', 'vertexAttribDivisor',
    'shaderSource', 'compileShader', 'attachShader', 'linkProgram', 'useProgram', 'uniform1i',
    'bindTexture', 'texParameteri', 'generateMipmap', 'bindFramebuffer', 'framebufferTexture2D',
    'enable', 'cullFace']) gl[name] = () => {};
  let constant = 100;
  const context = new Proxy(gl, {
    get(target, name) {
      if (typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name) && !(name in target)) target[name] = constant++;
      return target[name];
    },
  });
  return { gl: context, live, created, deleted, total: () => [...live.values()].reduce((n, set) => n + set.size, 0) };
}

function syntheticMesh(textured = false) {
  const sampler = { wrapS: 10497, wrapT: 10497, magFilter: 9729, minFilter: 9729 };
  const texture = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png', sampler };
  return {
    positions: new Float32Array([0,0,0, 1,0,0, 0,1,0]),
    normals: new Float32Array([0,0,1, 0,0,1, 0,0,1]),
    uvs: new Float32Array([0,0, 1,0, 0,1]),
    tangents: new Float32Array([1,0,0,1, 1,0,0,1, 1,0,0,1]),
    indices: new Uint32Array([0,1,2]),
    worldMatrix: identity(),
    material: { baseColor: [1,1,1,1], metallic: 0.2, roughness: 0.5, doubleSided: false,
      ...(textured ? { baseColorTexture: texture, normalTexture: texture } : {}) },
  };
}

function trackedRenderer(resources, initialise = false) {
  const canvas = { width: 64, height: 64, getContext: () => resources.gl,
    getBoundingClientRect: () => ({ width: 64, height: 64 }) };
  const renderer = new Renderer(canvas);
  if (initialise) renderer.init();
  else renderer.gl = resources.gl;
  return renderer;
}

test('M3: uploadMesh rolls back every partial buffer upload and null allocation', () => {
  for (const mode of ['failBufferDataAt', 'failCreateBufferAt', 'errorBufferDataAt']) {
    for (let failAt = 1; failAt <= 5; failAt += 1) {
      const resources = trackedGL();
      resources.gl[mode] = failAt;
      assertThrows(() => uploadMesh(resources.gl, syntheticMesh(), { position: 0, normal: 1, uv: 2, tangent: 3 }), `${mode} ${failAt} must fail`);
      assertEquals(resources.total(), 0, `${mode} ${failAt} leaked GPU resources`);
      assertEquals(resources.gl.boundVao, null, 'rollback unbinds the VAO');
    }
  }
  const resources = trackedGL();
  resources.gl.createVertexArray = () => null;
  assertThrows(() => uploadMesh(resources.gl, syntheticMesh(), { position: 0, normal: 1 }));
  assertEquals(resources.total(), 0, 'failed VAO allocation creates no buffers');
});

test('M3: attachModel rolls back staged meshes and retains the previous committed model', () => {
  const resources = trackedGL();
  const renderer = trackedRenderer(resources);
  renderer.attachModel([syntheticMesh()]);
  const previous = renderer.model;
  const generation = renderer.modelGeneration;
  const baseline = resources.total();
  resources.gl.failBufferDataAt = resources.gl.bufferDataCalls + 8; // first mesh complete, second mesh UV fails
  assertThrows(() => renderer.attachModel([syntheticMesh(), syntheticMesh()]));
  assertEquals(renderer.model, previous, 'failed replacement preserves the old model');
  assertEquals(renderer.modelGeneration, generation, 'old texture generation stays valid');
  assertEquals(resources.total(), baseline, 'staged and partially uploaded resources released');
  assertEquals(previous.meshes[0].dropped, false, 'previous model still drawable');
  const badMaterial = syntheticMesh();
  badMaterial.material = null;
  assertThrows(() => renderer.attachModel([syntheticMesh(), badMaterial]));
  assertEquals(resources.total(), baseline, 'JS record failure rolls back earlier uploads');
  renderer.attachModel([syntheticMesh()]);
  assertEquals(previous.meshes[0].dropped, true, 'successful replacement releases the old model');
  assertEquals(resources.total(), baseline);
  renderer.detachModel();
  renderer.detachModel();
  assertEquals(resources.total(), 0, 'detach releases only the committed model once');
  renderer.dispose();
});

test('M3: dispose accounts for all renderer resources and stops animation idempotently', async () => {
  const resources = trackedGL();
  const renderer = trackedRenderer(resources, true);
  const originalBitmap = globalThis.createImageBitmap;
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let closed = 0;
  let requests = 0;
  const cancelled = [];
  try {
    globalThis.createImageBitmap = async () => ({ close: () => { closed += 1; } });
    globalThis.requestAnimationFrame = () => { requests += 1; return 0; };
    globalThis.cancelAnimationFrame = (id) => { cancelled.push(id); };
    renderer.attachModel([syntheticMesh(true)]);
    await Promise.resolve();
    assertEquals(closed, 2, 'both decoded bitmaps closed');
    assertEquals(resources.live.get('Texture').size, 6, 'environment, shadow and two model textures');
    assert(renderer.groundVbo && renderer.particleVbo, 'ground and particle buffer handles retained');
    assertEquals(resources.live.get('Buffer').size, 10);
    assertEquals(resources.live.get('VertexArray').size, 4);
    assertEquals(resources.live.get('Program').size, 6);
    assertEquals(resources.live.get('Framebuffer').size, 1);
    assertEquals(resources.live.get('Shader').size, 0, 'linked shaders already deleted');
    assertEquals(resources.created.get('Query'), 0, 'renderer does not allocate timer queries');
    renderer.start();
    renderer.dispose();
    renderer.dispose();
    renderer.stop();
    renderer.start();
    renderer.frame(16);
    assertEquals(resources.total(), 0, 'every owned GPU resource released');
    for (const [kind, count] of resources.created) assertEquals(resources.deleted.get(kind), count, `${kind} create/delete accounting`);
    assertEquals(requests, 1, 'disposed renderer cannot restart animation');
    assertEquals(cancelled.join(','), '0', 'even RAF ID zero cancelled exactly once');
    assertEquals(renderer.running, false);
    assertEquals(renderer.gl, null);
    assertEquals(renderer.model, null);
    assertThrows(() => renderer.init(), 'disposed renderer cannot reinitialise');
    assertThrows(() => renderer.attachModel([syntheticMesh()]));
  } finally {
    renderer.dispose();
    globalThis.createImageBitmap = originalBitmap;
    globalThis.requestAnimationFrame = originalRequest;
    globalThis.cancelAnimationFrame = originalCancel;
  }
});

test('M3: late model bitmap decodes after disposal close without allocating textures', async () => {
  const resources = trackedGL();
  const renderer = trackedRenderer(resources);
  const originalBitmap = globalThis.createImageBitmap;
  const pending = [];
  let closed = 0;
  try {
    globalThis.createImageBitmap = () => new Promise((resolve) => pending.push(resolve));
    renderer.attachModel([syntheticMesh(true)]);
    renderer.dispose();
    for (const resolve of pending) resolve({ close: () => { closed += 1; } });
    await Promise.resolve();
    assertEquals(closed, 2);
    assertEquals(resources.created.get('Texture'), 0, 'no late texture allocations');
    assertEquals(resources.total(), 0);
  } finally {
    renderer.dispose();
    globalThis.createImageBitmap = originalBitmap;
  }
});

test('M3: failed asynchronous texture uploads delete partial textures and close bitmaps', async () => {
  const resources = trackedGL();
  const renderer = trackedRenderer(resources);
  const originalBitmap = globalThis.createImageBitmap;
  let closed = 0;
  try {
    globalThis.createImageBitmap = async () => ({ close: () => { closed += 1; } });
    resources.gl.failTexImageAt = 1;
    renderer.attachModel([syntheticMesh(true)]);
    await Promise.resolve();
    assertEquals(closed, 2);
    assertEquals(resources.live.get('Texture').size, 1, 'failed base texture released, normal texture retained');
    assertEquals(Object.keys(renderer.model.meshes[0].textures).join(','), 'normalTexture');
    renderer.dispose();
    assertEquals(resources.total(), 0);
  } finally {
    renderer.dispose();
    globalThis.createImageBitmap = originalBitmap;
  }
});

test('M3: initialisation failures release partially built geometry, textures and shader programs', () => {
  for (const mode of ['buffer', 'texture', 'compile', 'link']) {
    const resources = trackedGL();
    if (mode === 'buffer') resources.gl.failBufferDataAt = 3; // ground after cube
    if (mode === 'texture') resources.gl.failTexImageAt = 1; // first environment cube
    if (mode === 'compile') resources.gl.failCompile = true;
    if (mode === 'link') resources.gl.failLink = true;
    const renderer = trackedRenderer(resources);
    renderer.gl = null;
    assertThrows(() => renderer.init(), `injected ${mode} init failure`);
    renderer.dispose();
    assertEquals(resources.total(), 0, `${mode} initialisation leaked resources`);
  }
});
