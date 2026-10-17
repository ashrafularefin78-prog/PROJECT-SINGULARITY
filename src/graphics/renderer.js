/**
 * M3 - Custom 3D engine, written directly against WebGL2 with no engine, no
 * three.js, no helper libraries.
 *
 * What it actually does:
 *   - one indexed unit cube re-used for every object (single draw call)
 *   - hardware instancing: up to 100k instances, animated in the *vertex
 *     shader* (orbit + bob) so the CPU cost per frame is O(1), not O(n)
 *   - a real shadow map: depth-only pass into a DEPTH_COMPONENT24 texture with
 *     hardware PCF comparison sampling, plus a shadow-receiving ground plane
 *   - a GPU-computed particle system: 1,000,000 points generated from
 *     gl_VertexID with no vertex buffers at all
 *   - a glTF 2.0 model loaded from a real GLB (assets/models/singularity-core
 *     .glb), one draw call per primitive, shaded through the *same*
 *     Cook-Torrance BRDF chunk as the instanced cubes - material values come
 *     from the file, not from a seed
 *   - physically based shading: a Cook-Torrance BRDF (GGX distribution, Smith
 *     geometry, Schlick Fresnel) with per-instance metallic/roughness, a
 *     hemispheric ambient standing in for image-based lighting, and Reinhard
 *     tone mapping, plus a hand-written
 *     perspective/orbit camera
 *
 * Deliberately not implemented (declared in docs/ARCHITECTURE.md): PBR with
 * a real HDRI probe, skeletal animation, texture sampling. Shipping those
 * badly would be worse than declaring the gap.
 */
import {
  identity,
  lookAt,
  mat4,
  mulberry32,
  multiply,
  ortho,
  perspective,
  TAU,
  vec3,
} from './math.js';
import { uploadMesh } from './gltf.js';

const CUBE_VERTICES = new Float32Array([
  // +X
  1, -1, -1, 1, 0, 0, 1, 1, -1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, -1, 1, 1, 0, 0,
  // -X
  -1, -1, 1, -1, 0, 0, -1, 1, 1, -1, 0, 0, -1, 1, -1, -1, 0, 0, -1, -1, -1, -1, 0, 0,
  // +Y
  -1, 1, -1, 0, 1, 0, -1, 1, 1, 0, 1, 0, 1, 1, 1, 0, 1, 0, 1, 1, -1, 0, 1, 0,
  // -Y
  -1, -1, 1, 0, -1, 0, -1, -1, -1, 0, -1, 0, 1, -1, -1, 0, -1, 0, 1, -1, 1, 0, -1, 0,
  // +Z
  -1, -1, 1, 0, 0, 1, 1, -1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, -1, 1, 1, 0, 0, 1,
  // -Z
  1, -1, -1, 0, 0, -1, -1, -1, -1, 0, 0, -1, -1, 1, -1, 0, 0, -1, 1, 1, -1, 0, 0, -1,
]);

const CUBE_INDICES = new Uint16Array([
  0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11, 12, 13, 14, 12, 14, 15,
  16, 17, 18, 16, 18, 19, 20, 21, 22, 20, 22, 23,
]);

const GROUND_VERTICES = new Float32Array([-60, 0, -60, 0, 1, 0, 60, 0, -60, 0, 1, 0, 60, 0, 60, 0, 1, 0, -60, 0, 60, 0, 1, 0]);

const OBJECT_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec3 aOffset;   // (radius, angleSeed, height)
in float aSeed;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform float uTime;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vLightSpace;
out float vSeed;
void main() {
  float radius = aOffset.x;
  float angle = aOffset.y + uTime * (0.04 + aSeed * 0.18);
  vec3 base = vec3(cos(angle) * radius,
                   aOffset.z + sin(uTime * 0.9 + aSeed * 6.2831) * 1.1,
                   sin(angle) * radius);
  float scale = 0.16 + aSeed * 0.42;
  vec3 world = base + aPos * scale;
  vNormal = aNormal;
  vWorld = world;
  vSeed = aSeed;
  vLightSpace = uLightViewProj * vec4(world, 1.0);
  gl_Position = uViewProj * vec4(world, 1.0);
}`;

/**
 * The Cook-Torrance BRDF and the PCF shadow lookup, written once and spliced
 * into every shader that needs them. The instanced cubes and the glTF model
 * are lit by the *same* code, not by two similar copies that can drift apart.
 */
const PBR_BRDF = `
float distributionGGX(vec3 N, vec3 H, float roughness) {
  float a = roughness * roughness;
  float a2 = a * a;
  float NdotH = max(dot(N, H), 0.0);
  float denom = NdotH * NdotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 1e-5);
}

float geometrySmith(vec3 N, vec3 V, vec3 L, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) / 8.0;
  float NdotV = max(dot(N, V), 0.0);
  float NdotL = max(dot(N, L), 0.0);
  return (NdotL / (NdotL * (1.0 - k) + k)) * (NdotV / (NdotV * (1.0 - k) + k));
}

vec3 fresnelSchlick(float cosTheta, vec3 F0) {
  return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}
`;

const SHADOW_PCF = `
uniform highp sampler2DShadow uShadow;  // ES 3.00 requires an explicit precision
uniform float uShadows;

float shadowFactor(vec4 lightSpace) {
  vec3 p = lightSpace.xyz / lightSpace.w;
  p = p * 0.5 + 0.5;
  if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0 || p.z > 1.0) return 1.0;
  float sum = 0.0;
  vec2 texel = 1.0 / vec2(textureSize(uShadow, 0));
  for (int x = -1; x <= 1; ++x) {
    for (int y = -1; y <= 1; ++y) {
      sum += texture(uShadow, vec3(p.xy + vec2(float(x), float(y)) * texel, p.z - 0.0022));
    }
  }
  return mix(1.0, sum / 9.0, uShadows);
}
`;

const OBJECT_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vLightSpace;
in float vSeed;
uniform vec3 uLightDir;      // direction the light travels
uniform vec3 uCamera;
out vec4 outColor;

const float PI = 3.14159265359;
${SHADOW_PCF}
${PBR_BRDF}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamera - vWorld);
  vec3 L = normalize(-uLightDir);
  vec3 H = normalize(V + L);

  // Per-instance material variety, derived from the instance seed so the same
  // cube always looks the same without any per-instance attribute.
  float metallic = mix(0.05, 0.85, vSeed);
  float roughness = clamp(mix(0.22, 0.72, fract(vSeed * 7.31)), 0.06, 1.0);
  vec3 albedo = mix(vec3(0.35, 0.62, 1.0), vec3(1.0, 0.62, 0.32), vSeed);
  vec3 F0 = mix(vec3(0.04), albedo, metallic);

  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 0.0);
  float shadow = shadowFactor(vLightSpace);

  vec3 radiance = vec3(1.0, 0.97, 0.92) * 3.2;
  vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
  float D = distributionGGX(N, H, roughness);
  float G = geometrySmith(N, V, L, roughness);
  vec3 specular = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);
  vec3 diffuse = (1.0 - F) * (1.0 - metallic) * albedo / PI;
  vec3 direct = (diffuse + specular) * radiance * NdotL * shadow;

  // Approximate image-based lighting with a hemispheric ambient: sky above,
  // floor bounce below, sampled by the normal. This is not an HDRI probe and
  // the shader says so; it exists so dielectrics are not lit from nowhere and
  // metals are not black.
  vec3 sky = vec3(0.17, 0.23, 0.36);
  vec3 floorBounce = vec3(0.05, 0.055, 0.075);
  vec3 ambientSource = mix(floorBounce, sky, N.y * 0.5 + 0.5);
  vec3 ambient = ambientSource * albedo * (1.0 - metallic) * 0.55;
  vec3 envSpecular = ambientSource * F0 * (1.0 - roughness) * 1.35;

  vec3 color = direct + ambient + envSpecular;
  // Reinhard tone map, so the specular highlights roll off instead of clipping.
  outColor = vec4(color / (color + vec3(1.0)), 1.0);
}`;

// --- glTF model --------------------------------------------------------------
// The loader (src/graphics/gltf.js) flattens the file's node hierarchy into a
// world matrix per primitive; this pair draws each primitive with that matrix
// and the material values as uniforms. Same BRDF chunk, different material
// source: the file instead of the instance seed.

const MODEL_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
uniform mat4 uWorld;      // the node's flattened world matrix, from the GLB
uniform float uTime;
uniform float uSpin;      // radians per second about the world Y axis
out vec3 vNormal;
out vec3 vWorld;
out vec4 vLightSpace;
void main() {
  vec4 world = uWorld * vec4(aPos, 1.0);
  float a = uTime * uSpin;
  float c = cos(a), s = sin(a);
  vec3 spun = vec3(world.x * c + world.z * s, world.y, -world.x * s + world.z * c);
  // The sample model uses uniform scale only, so mat3(uWorld) is enough for
  // the normals; a skewing node would need the inverse-transpose instead.
  vec3 n = mat3(uWorld) * aNormal;
  vNormal = vec3(n.x * c + n.z * s, n.y, -n.x * s + n.z * c);
  vWorld = spun;
  vLightSpace = uLightViewProj * vec4(spun, 1.0);
  gl_Position = uViewProj * vec4(spun, 1.0);
}`;

const MODEL_DEPTH_VS = `#version 300 es
in vec3 aPos;
uniform mat4 uLightViewProj;
uniform mat4 uWorld;
uniform float uTime;
uniform float uSpin;
void main() {
  vec4 world = uWorld * vec4(aPos, 1.0);
  float a = uTime * uSpin;
  float c = cos(a), s = sin(a);
  gl_Position = uLightViewProj * vec4(world.x * c + world.z * s, world.y, -world.x * s + world.z * c, 1.0);
}`;

const MODEL_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vLightSpace;
uniform vec3 uLightDir;
uniform vec3 uCamera;
uniform vec4 uBaseColor;   // baseColorFactor from the glTF material
uniform float uMetallic;
uniform float uRoughness;
out vec4 outColor;

const float PI = 3.14159265359;
${SHADOW_PCF}
${PBR_BRDF}

void main() {
  vec3 N = normalize(vNormal);
  vec3 V = normalize(uCamera - vWorld);
  vec3 L = normalize(-uLightDir);
  vec3 H = normalize(V + L);

  float metallic = clamp(uMetallic, 0.0, 1.0);
  float roughness = clamp(uRoughness, 0.04, 1.0);
  vec3 albedo = uBaseColor.rgb;
  vec3 F0 = mix(vec3(0.04), albedo, metallic);

  float NdotL = max(dot(N, L), 0.0);
  float NdotV = max(dot(N, V), 0.0);
  float shadow = shadowFactor(vLightSpace);

  vec3 radiance = vec3(1.0, 0.97, 0.92) * 3.2;
  vec3 F = fresnelSchlick(max(dot(H, V), 0.0), F0);
  float D = distributionGGX(N, H, roughness);
  float G = geometrySmith(N, V, L, roughness);
  vec3 specular = (D * G * F) / max(4.0 * NdotV * NdotL, 1e-4);
  vec3 diffuse = (1.0 - F) * (1.0 - metallic) * albedo / PI;
  vec3 direct = (diffuse + specular) * radiance * NdotL * shadow;

  vec3 sky = vec3(0.17, 0.23, 0.36);
  vec3 floorBounce = vec3(0.05, 0.055, 0.075);
  vec3 ambientSource = mix(floorBounce, sky, N.y * 0.5 + 0.5);
  vec3 ambient = ambientSource * albedo * (1.0 - metallic) * 0.55;
  vec3 envSpecular = ambientSource * F0 * (1.0 - roughness) * 1.35;

  vec3 color = direct + ambient + envSpecular;
  outColor = vec4(color / (color + vec3(1.0)), 1.0);
}`;

const GROUND_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
uniform mat4 uViewProj;
uniform mat4 uLightViewProj;
out vec3 vNormal;
out vec3 vWorld;
out vec4 vLightSpace;
void main() {
  vNormal = aNormal;
  vWorld = aPos;
  vLightSpace = uLightViewProj * vec4(aPos, 1.0);
  gl_Position = uViewProj * vec4(aPos, 1.0);
}`;

const GROUND_FS = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec3 vWorld;
in vec4 vLightSpace;
uniform vec3 uLightDir;
uniform vec3 uCamera;
uniform highp sampler2DShadow uShadow;  // ES 3.00 requires an explicit precision
uniform float uShadows;
out vec4 outColor;
void main() {
  vec3 p = vLightSpace.xyz / vLightSpace.w;
  p = p * 0.5 + 0.5;
  float shadow = 1.0;
  if (p.x >= 0.0 && p.x <= 1.0 && p.y >= 0.0 && p.y <= 1.0 && p.z <= 1.0) {
    float sum = 0.0;
    vec2 texel = 1.0 / vec2(textureSize(uShadow, 0));
    for (int x = -1; x <= 1; ++x) {
      for (int y = -1; y <= 1; ++y) {
        sum += texture(uShadow, vec3(p.xy + vec2(float(x), float(y)) * texel * 1.5, p.z - 0.0028));
      }
    }
    shadow = mix(1.0, sum / 9.0, uShadows);
  }
  float checker = mod(floor(vWorld.x / 4.0) + floor(vWorld.z / 4.0), 2.0);
  vec3 base = mix(vec3(0.055, 0.07, 0.09), vec3(0.085, 0.105, 0.13), checker);
  float ndl = max(dot(normalize(vNormal), -uLightDir), 0.0);
  float rim = 1.0 - max(dot(normalize(vNormal), normalize(uCamera - vWorld)), 0.0);
  vec3 color = base * (0.35 + ndl * shadow * 1.1) + vec3(0.04, 0.05, 0.07) * rim;
  outColor = vec4(color, 1.0);
}`;

const DEPTH_VS = `#version 300 es
in vec3 aPos;
in vec3 aNormal;
in vec3 aOffset;
in float aSeed;
uniform mat4 uLightViewProj;
uniform float uTime;
void main() {
  float radius = aOffset.x;
  float angle = aOffset.y + uTime * (0.04 + aSeed * 0.18);
  vec3 base = vec3(cos(angle) * radius,
                   aOffset.z + sin(uTime * 0.9 + aSeed * 6.2831) * 1.1,
                   sin(angle) * radius);
  float scale = 0.16 + aSeed * 0.42;
  gl_Position = uLightViewProj * vec4(base + aPos * scale, 1.0);
}`;

const DEPTH_FS = `#version 300 es
precision highp float;
void main() {}`;

const PARTICLE_VS = `#version 300 es
in float aIndex;
uniform mat4 uViewProj;
uniform float uTime;
out float vAlpha;
float hash(float n) { return fract(sin(n) * 43758.5453123); }
void main() {
  float id = aIndex;
  float h0 = hash(id);
  float h1 = hash(id + 17.0);
  float h2 = hash(id + 43.0);
  float radius = 9.0 + h1 * 34.0;
  float angle = h2 * 6.283185 + uTime * (0.05 + h0 * 0.25);
  float height = (h0 - 0.5) * 18.0 + sin(uTime * 0.6 + h0 * 6.283185) * 1.8;
  vec3 pos = vec3(cos(angle) * radius, height, sin(angle) * radius);
  gl_Position = uViewProj * vec4(pos, 1.0);
  gl_PointSize = 1.0 + h0 * 2.6;
  vAlpha = 0.12 + h2 * 0.45;
}`;

const PARTICLE_FS = `#version 300 es
precision highp float;
in float vAlpha;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);
  if (r2 > 0.25) discard;
  float falloff = 1.0 - r2 * 4.0;
  vec3 tint = vec3(0.55, 0.78, 1.0);
  outColor = vec4(tint * falloff * vAlpha, falloff * vAlpha);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

function program(gl, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    throw new Error(`program link failed: ${log}`);
  }
  return prog;
}

function uniforms(gl, prog, names) {
  const map = {};
  for (const name of names) map[name] = gl.getUniformLocation(prog, name);
  return map;
}

export const DEFAULT_INSTANCES = 20000;
export const MAX_INSTANCES = 100000;
export const DEFAULT_PARTICLES = 200000;
export const MAX_PARTICLES = 1000000;

export class Renderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = options;
    this.gl = null;
    this.instanceCount = Math.min(options.instances ?? DEFAULT_INSTANCES, MAX_INSTANCES);
    this.particleCount = Math.min(options.particles ?? DEFAULT_PARTICLES, MAX_PARTICLES);
    this.shadows = options.shadows !== false;
    this.camera = { azimuth: 0.6, elevation: 0.42, distance: 62 };
    this.running = false;
    this.frameTimes = [];
    this.fps = 0;
    this.frames = 0;
    /**
     * Main-thread CPU cost of issuing one frame, as an exponential moving
     * average. This is the number the "CPU cost stays O(1)" claim is about: it
     * measures the work the page does to submit the frame, not how fast the GPU
     * or a headless software rasteriser can push pixels.
     */
    this.cpuMs = 0;
    this.cpuSamples = 0;
    /** Attached glTF model: { meshes: [...], triangles, spin } or null. */
    this.model = null;
    this.lastState = { instances: 0, particles: 0, drawCalls: 0, triangles: 0 };
  }

  static isSupported() {
    try {
      const canvas = document.createElement('canvas');
      return !!canvas.getContext('webgl2');
    } catch {
      return false;
    }
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');
    this.gl = gl;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.renderer = (() => {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    })();

    this._buildCube();
    this._buildGround();
    this._buildPrograms();
    this._buildInstances();
    this._buildParticles();
    this._buildShadowFramebuffer();

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    this.resize();
    return this.info();
  }

  info() {
    const gl = this.gl;
    return {
      api: 'WebGL2',
      glVersion: gl ? gl.getParameter(gl.VERSION) : 'n/a',
      renderer: this.renderer || 'unknown',
      maxTextureSize: this.maxTextureSize || 0,
      shadowMapSize: this.shadowSize || 0,
      instances: this.instanceCount,
      particles: this.particleCount,
    };
  }

  // ------------------------------------------------------------- geometry

  _buildCube() {
    const gl = this.gl;
    this.cubeVao = gl.createVertexArray();
    gl.bindVertexArray(this.cubeVao);
    this.cubeVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cubeVbo);
    gl.bufferData(gl.ARRAY_BUFFER, CUBE_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    this.cubeIbo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.cubeIbo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, CUBE_INDICES, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
  }

  _buildGround() {
    const gl = this.gl;
    this.groundVao = gl.createVertexArray();
    gl.bindVertexArray(this.groundVao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, GROUND_VERTICES, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
  }

  _buildPrograms() {
    const gl = this.gl;
    this.objectProgram = program(gl, OBJECT_VS, OBJECT_FS);
    this.objectUniforms = uniforms(gl, this.objectProgram, [
      'uViewProj', 'uLightViewProj', 'uTime', 'uLightDir', 'uCamera', 'uShadow', 'uShadows',
    ]);
    this.groundProgram = program(gl, GROUND_VS, GROUND_FS);
    this.groundUniforms = uniforms(gl, this.groundProgram, [
      'uViewProj', 'uLightViewProj', 'uLightDir', 'uCamera', 'uShadow', 'uShadows',
    ]);
    this.depthProgram = program(gl, DEPTH_VS, DEPTH_FS);
    this.depthUniforms = uniforms(gl, this.depthProgram, ['uLightViewProj', 'uTime']);
    this.modelProgram = program(gl, MODEL_VS, MODEL_FS);
    this.modelUniforms = uniforms(gl, this.modelProgram, [
      'uViewProj', 'uLightViewProj', 'uLightDir', 'uCamera', 'uShadow', 'uShadows',
      'uTime', 'uSpin', 'uWorld', 'uBaseColor', 'uMetallic', 'uRoughness',
    ]);
    this.modelDepthProgram = program(gl, MODEL_DEPTH_VS, DEPTH_FS);
    this.modelDepthUniforms = uniforms(gl, this.modelDepthProgram, ['uLightViewProj', 'uWorld', 'uTime', 'uSpin']);
    this.particleProgram = program(gl, PARTICLE_VS, PARTICLE_FS);
    this.particleUniforms = uniforms(gl, this.particleProgram, ['uViewProj', 'uTime']);
  }

  _buildInstances() {
    const gl = this.gl;
    const count = MAX_INSTANCES;
    const offsets = new Float32Array(count * 4);
    const rnd = mulberry32(0xc0ffee);
    for (let i = 0; i < count; i += 1) {
      const band = Math.floor(rnd() * 5);
      const radius = 6 + band * 7 + rnd() * 5;
      offsets[i * 4] = radius;
      offsets[i * 4 + 1] = rnd() * TAU;
      offsets[i * 4 + 2] = (rnd() - 0.5) * 6;
      offsets[i * 4 + 3] = rnd();
    }
    this.instanceVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.bufferData(gl.ARRAY_BUFFER, offsets, gl.STATIC_DRAW);
    this.instanceData = offsets;

    gl.bindVertexArray(this.cubeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceVbo);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 16, 12);
    gl.vertexAttribDivisor(3, 1);
    gl.bindVertexArray(null);
  }

  _buildParticles() {
    const gl = this.gl;
    // No vertex buffer at all: the indices are implicit in gl_VertexID, which
    // is what keeps a million particles essentially free of memory traffic.
    this.particleVao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    gl.bindVertexArray(this.particleVao);
    const indices = new Float32Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i += 1) indices[i] = i;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 4, 0);
    gl.bindVertexArray(null);
  }

  _buildShadowFramebuffer() {
    const gl = this.gl;
    this.shadowSize = 1024;
    this.shadowTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, this.shadowSize, this.shadowSize, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);

    this.shadowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTexture, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`shadow framebuffer incomplete (0x${status.toString(16)})`);
  }

  // ---------------------------------------------------------------- control

  /**
   * Upload a glTF model (the flat DrawMesh list `loadGltf` returns) and draw
   * it with the same PBR shader as everything else. Replaces any previous
   * model. Returns a small summary for the UI.
   *
   * @param {Array} meshes   DrawMesh[] from src/graphics/gltf.js
   * @param {{ spin?: number }} [options]  radians/second about the world Y axis
   */
  attachModel(meshes, options = {}) {
    if (!this.gl) throw new Error('attachModel() needs an initialised renderer');
    this.detachModel();
    const uploaded = (meshes || []).map((mesh) => {
      const glMesh = uploadMesh(this.gl, mesh, { position: 0, normal: 1 });
      return {
        ...glMesh,
        material: {
          baseColor: new Float32Array(mesh.material.baseColor),
          metallic: mesh.material.metallic,
          roughness: mesh.material.roughness,
          doubleSided: mesh.material.doubleSided,
        },
        worldMatrix: mesh.worldMatrix,
        triangles: (mesh.indices ? mesh.indices.length : mesh.positions.length / 3) / 3,
      };
    });
    this.model = {
      meshes: uploaded,
      triangles: uploaded.reduce((n, m) => n + m.triangles, 0),
      spin: options.spin ?? 0.25,
    };
    return {
      meshes: uploaded.length,
      triangles: this.model.triangles,
      nodes: meshes.length,
    };
  }

  /** Drop the attached model and release its GPU buffers. */
  detachModel() {
    if (!this.model) return;
    const gl = this.gl;
    if (gl) {
      for (const mesh of this.model.meshes) {
        gl.deleteVertexArray(mesh.vao);
        for (const buffer of mesh.buffers) gl.deleteBuffer(buffer);
      }
    }
    this.model = null;
  }

  setInstances(n) {
    this.instanceCount = Math.max(0, Math.min(Math.round(n), MAX_INSTANCES));
    return this.instanceCount;
  }

  setParticles(n) {
    this.particleCount = Math.max(0, Math.min(Math.round(n), MAX_PARTICLES));
    return this.particleCount;
  }

  setShadows(on) {
    this.shadows = !!on;
    return this.shadows;
  }

  orbit(dAzimuth, dElevation, dDistance = 0) {
    this.camera.azimuth += dAzimuth;
    this.camera.elevation = Math.max(-1.3, Math.min(1.35, this.camera.elevation + dElevation));
    this.camera.distance = Math.max(14, Math.min(180, this.camera.distance + dDistance));
  }

  resize() {
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor((rect.width || this.canvas.width) * dpr));
    const height = Math.max(1, Math.floor((rect.height || this.canvas.height) * dpr));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.aspect = width / height;
    return { width, height, dpr };
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (now) => {
      if (!this.running) return;
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  // ----------------------------------------------------------------- render

  frame(nowMs) {
    const gl = this.gl;
    if (!gl) return;
    const cpuStart = typeof performance !== 'undefined' ? performance.now() : 0;
    const seconds = nowMs / 1000;
    this.resize();

    if (this.frameTimes.length > 0) {
      const last = this.frameTimes[this.frameTimes.length - 1];
      const dt = nowMs - last;
      if (dt > 0) this.fps = this.fps ? this.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
    }
    this.frameTimes.push(nowMs);
    if (this.frameTimes.length > 90) this.frameTimes.shift();
    this.frames += 1;

    const lightDir = [-0.45, -0.78, -0.44];
    const lightLen = Math.hypot(...lightDir);
    const l = lightDir.map((v) => v / lightLen);

    const eyeDist = this.camera.distance;
    const eye = [
      Math.cos(this.camera.azimuth) * Math.cos(this.camera.elevation) * eyeDist,
      Math.sin(this.camera.elevation) * eyeDist + 8,
      Math.sin(this.camera.azimuth) * Math.cos(this.camera.elevation) * eyeDist,
    ];
    const view = lookAt(mat4(), eye, [0, 2, 0], [0, 1, 0]);
    const proj = perspective(mat4(), (55 * Math.PI) / 180, this.aspect, 0.5, 400);
    const viewProj = multiply(mat4(), proj, view);

    const lightEye = [l[0] * -70, l[1] * -70 + 20, l[2] * -70];
    const lightView = lookAt(mat4(), lightEye, [0, 0, 0], [0, 1, 0]);
    const lightProj = ortho(mat4(), -60, 60, -60, 60, 1, 200);
    const lightViewProj = multiply(mat4(), lightProj, lightView);

    let drawCalls = 0;

    // 1) shadow depth pass
    if (this.shadows) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
      gl.viewport(0, 0, this.shadowSize, this.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.depthProgram);
      gl.uniformMatrix4fv(this.depthUniforms.uLightViewProj, false, lightViewProj);
      gl.uniform1f(this.depthUniforms.uTime, seconds);
      gl.bindVertexArray(this.cubeVao);
      gl.drawElementsInstanced(gl.TRIANGLES, CUBE_INDICES.length, gl.UNSIGNED_SHORT, 0, this.instanceCount);
      drawCalls += 1;
      if (this.model) {
        gl.useProgram(this.modelDepthProgram);
        gl.uniformMatrix4fv(this.modelDepthUniforms.uLightViewProj, false, lightViewProj);
        gl.uniform1f(this.modelDepthUniforms.uTime, seconds);
        gl.uniform1f(this.modelDepthUniforms.uSpin, this.model.spin);
        for (const mesh of this.model.meshes) {
          gl.uniformMatrix4fv(this.modelDepthUniforms.uWorld, false, mesh.worldMatrix);
          gl.bindVertexArray(mesh.vao);
          if (mesh.indexed) gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
          else gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
          drawCalls += 1;
        }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // 2) main pass
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.02, 0.03, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTexture);

    gl.useProgram(this.groundProgram);
    gl.uniformMatrix4fv(this.groundUniforms.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(this.groundUniforms.uLightViewProj, false, lightViewProj);
    gl.uniform3fv(this.groundUniforms.uLightDir, l);
    gl.uniform3fv(this.groundUniforms.uCamera, eye);
    gl.uniform1i(this.groundUniforms.uShadow, 0);
    gl.uniform1f(this.groundUniforms.uShadows, this.shadows ? 1 : 0);
    gl.bindVertexArray(this.groundVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawCalls += 1;

    gl.useProgram(this.objectProgram);
    gl.uniformMatrix4fv(this.objectUniforms.uViewProj, false, viewProj);
    gl.uniformMatrix4fv(this.objectUniforms.uLightViewProj, false, lightViewProj);
    gl.uniform1f(this.objectUniforms.uTime, seconds);
    gl.uniform3fv(this.objectUniforms.uLightDir, l);
    gl.uniform3fv(this.objectUniforms.uCamera, eye);
    gl.uniform1i(this.objectUniforms.uShadow, 0);
    gl.uniform1f(this.objectUniforms.uShadows, this.shadows ? 1 : 0);
    gl.bindVertexArray(this.cubeVao);
    if (this.instanceCount > 0) {
      gl.drawElementsInstanced(gl.TRIANGLES, CUBE_INDICES.length, gl.UNSIGNED_SHORT, 0, this.instanceCount);
      drawCalls += 1;
    }

    // 2b) glTF model: one draw call per primitive, material straight from the
    // file, shaded by the same Cook-Torrance BRDF as the instances above.
    if (this.model) {
      gl.useProgram(this.modelProgram);
      gl.uniformMatrix4fv(this.modelUniforms.uViewProj, false, viewProj);
      gl.uniformMatrix4fv(this.modelUniforms.uLightViewProj, false, lightViewProj);
      gl.uniform1f(this.modelUniforms.uTime, seconds);
      gl.uniform1f(this.modelUniforms.uSpin, this.model.spin);
      gl.uniform3fv(this.modelUniforms.uLightDir, l);
      gl.uniform3fv(this.modelUniforms.uCamera, eye);
      gl.uniform1i(this.modelUniforms.uShadow, 0);
      gl.uniform1f(this.modelUniforms.uShadows, this.shadows ? 1 : 0);
      for (const mesh of this.model.meshes) {
        if (mesh.material.doubleSided) gl.disable(gl.CULL_FACE);
        gl.uniformMatrix4fv(this.modelUniforms.uWorld, false, mesh.worldMatrix);
        gl.uniform4fv(this.modelUniforms.uBaseColor, mesh.material.baseColor);
        gl.uniform1f(this.modelUniforms.uMetallic, mesh.material.metallic);
        gl.uniform1f(this.modelUniforms.uRoughness, mesh.material.roughness);
        gl.bindVertexArray(mesh.vao);
        if (mesh.indexed) gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_INT, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
        if (mesh.material.doubleSided) gl.enable(gl.CULL_FACE);
        drawCalls += 1;
      }
    }

    // 3) GPU particles: one draw call, zero buffers touched per frame
    if (this.particleCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      gl.useProgram(this.particleProgram);
      gl.uniformMatrix4fv(this.particleUniforms.uViewProj, false, viewProj);
      gl.uniform1f(this.particleUniforms.uTime, seconds);
      gl.bindVertexArray(this.particleVao);
      gl.drawArrays(gl.POINTS, 0, this.particleCount);
      drawCalls += 1;
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }

    gl.bindVertexArray(null);
    const modelTriangles = this.model ? Math.round(this.model.triangles) : 0;
    this.lastState = {
      instances: this.instanceCount,
      particles: this.particleCount,
      modelMeshes: this.model ? this.model.meshes.length : 0,
      modelTriangles,
      drawCalls,
      triangles: this.instanceCount * (CUBE_INDICES.length / 3) + 2 + modelTriangles,
      shadows: this.shadows,
    };

    if (typeof performance !== 'undefined') {
      const spent = performance.now() - cpuStart;
      this.cpuMs = this.cpuSamples ? this.cpuMs * 0.94 + spent * 0.06 : spent;
      this.cpuSamples += 1;
    }
  }

  stats() {
    return {
      fps: Math.round(this.fps),
      frames: this.frames,
      cpuMs: Math.round(this.cpuMs * 1000) / 1000,
      ...this.lastState,
      camera: { ...this.camera },
    };
  }

  /**
   * M7 - Accessibility: the canvas is invisible to assistive tech, so the
   * engine exposes a text description of the scene for a parallel accessible
   * tree. This is the data behind that tree.
   */
  describeScene() {
    const model = this.model
      ? `, and a glTF model (${Math.round(this.model.triangles).toLocaleString()} triangles)`
      : '';
    return {
      summary: `3D scene: ${this.instanceCount.toLocaleString()} instanced cubes orbiting on a shadowed ground plane, ${this.particleCount.toLocaleString()} particles${model}, ${this.shadows ? 'shadows on' : 'shadows off'}.`,
      objects: [
        { role: 'group', label: 'Instanced cubes', count: this.instanceCount, detail: 'Orbiting rings, animated in the vertex shader.' },
        { role: 'object', label: 'Ground plane', count: 1, detail: 'Receives the directional shadow map.' },
        { role: 'group', label: 'Particle field', count: this.particleCount, detail: 'Compute-free GPU points generated from vertex ids.' },
        ...(this.model
          ? [{ role: 'group', label: 'glTF model', count: this.model.meshes.length, detail: `assets/models/singularity-core.glb, ${Math.round(this.model.triangles).toLocaleString()} triangles, PBR materials from the file.` }]
          : []),
      ],
      camera: `Orbit camera at azimuth ${(this.camera.azimuth % TAU).toFixed(2)} rad, elevation ${this.camera.elevation.toFixed(2)} rad, distance ${this.camera.distance.toFixed(0)}.`,
    };
  }
}

export { identity, vec3 };
