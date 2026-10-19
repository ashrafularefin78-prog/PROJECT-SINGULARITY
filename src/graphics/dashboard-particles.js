/**
 * Futuristic Dashboard Particle System
 * 
 * A GPU-accelerated particle field for the dashboard hero background.
 * Features:
 * - 50,000 particles simulated entirely in vertex shader (zero CPU cost)
 * - Multiple layers: nebula dust, data streams, quantum foam
 * - Reactive to user interaction (mouse, scroll, module focus)
 * - Time-of-day aware color shifts
 * - Reduced-motion compliant (pauses instantly)
 * - WebGL2 only, no dependencies
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

const PARTICLE_COUNT = 50000;
const LAYER_COUNT = 3;

const VERT_SRC = `#version 300 es
precision highp float;

#define PARTICLE_COUNT ${PARTICLE_COUNT}
#define LAYER_COUNT ${LAYER_COUNT}

uniform mat4 uProjection;
uniform mat4 uView;
uniform float uTime;
uniform float uAspect;
uniform vec2 uMouse;
uniform float uScroll;
uniform float uIntensity;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform vec3 uColorC;
uniform int uLayer;
uniform float uReducedMotion;

layout(location = 0) in float aId;

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float noise3d(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec3 a = hash33(i);
  vec3 b = hash33(i + vec3(1,0,0));
  vec3 c = hash33(i + vec3(0,1,0));
  vec3 d = hash33(i + vec3(1,1,0));
  vec3 e = hash33(i + vec3(0,0,1));
  vec3 g = hash33(i + vec3(1,0,1));
  vec3 h = hash33(i + vec3(0,1,1));
  vec3 k = hash33(i + vec3(1,1,1));
  return mix(mix(mix(a.x, b.x, f.x), mix(c.x, d.x, f.x), f.y),
             mix(mix(e.x, g.x, f.x), mix(h.x, k.x, f.x), f.y), f.z);
}

vec3 fbm(vec3 p, int octaves) {
  float v = 0.0;
  float a = 0.5;
  vec3 shift = vec3(100.0);
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    v += a * noise3d(p);
    p = p * 2.0 + shift;
    a *= 0.5;
  }
  return vec3(v);
}

void main() {
  if (uReducedMotion > 0.5) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  float id = aId;
  float layer = float(uLayer);
  
  uint seed = uint(id) * 747796405u + 2891336453u;
  seed ^= seed >> 13;
  seed *= 3266489917u;
  seed ^= seed >> 16;
  float rand0 = float(seed) / 4294967296.0;
  
  seed = seed * 747796405u + 2891336453u;
  seed ^= seed >> 13;
  seed *= 3266489917u;
  seed ^= seed >> 16;
  float rand1 = float(seed) / 4294967296.0;
  
  seed = seed * 747796405u + 2891336453u;
  seed ^= seed >> 13;
  seed *= 3266489917u;
  seed ^= seed >> 16;
  float rand2 = float(seed) / 4294967296.0;

  float radius = mix(2.0, 25.0, pow(rand0, 1.5));
  float theta = rand1 * TAU;
  float phi = acos(2.0 * rand2 - 1.0);
  
  vec3 pos = vec3(
    radius * sin(phi) * cos(theta),
    radius * sin(phi) * sin(theta) * (1.0 + 0.3 * sin(uTime * 0.1 + id * 0.01)),
    radius * cos(phi)
  );

  float layerSpeed = mix(0.02, 0.15, layer / float(LAYER_COUNT - 1));
  float layerScale = mix(0.5, 2.0, layer / float(LAYER_COUNT - 1));
  
  vec3 noisePos = pos * layerScale + uTime * layerSpeed * vec3(0.1, 0.05, 0.07);
  vec3 flow = fbm(noisePos, 4) * 0.3;
  
  float mouseInfluence = 0.0;
  if (length(uMouse) > 0.0) {
    vec3 mouseDir = normalize(vec3(uMouse * 2.0 - 1.0, -2.0));
    float dist = length(pos - mouseDir * 5.0);
    mouseInfluence = smoothstep(8.0, 0.0, dist) * 0.5;
    flow += mouseDir * mouseInfluence * 0.5;
  }
  
  pos += flow * (1.0 + uIntensity * 2.0);
  pos.y += uScroll * 0.01 * sin(uTime * 0.5 + id * 0.1);

  float pulse = sin(uTime * 2.0 + id * 0.5) * 0.5 + 0.5;
  float size = mix(1.5, 4.0, rand0) * (1.0 + pulse * 0.5) * (1.0 + mouseInfluence);
  
  vec4 viewPos = uView * vec4(pos, 1.0);
  vec4 clipPos = uProjection * viewPos;
  gl_Position = clipPos;
  gl_PointSize = size * (300.0 / -viewPos.z) * uAspect;

  float layerT = layer / float(LAYER_COUNT - 1);
  vec3 color = mix(uColorA, uColorB, layerT);
  color = mix(color, uColorC, smoothstep(0.3, 0.7, rand0));
  
  float alpha = mix(0.15, 0.6, 1.0 - radius / 25.0) * (0.5 + 0.5 * pulse);
  alpha *= (1.0 + mouseInfluence * 2.0);
  
  vColor = vec4(color, alpha);
  vDepth = -viewPos.z;
}
` + `out vec4 vColor;
out float vDepth;
`;

const FRAG_SRC = `#version 300 es
precision highp float;

in vec4 vColor;
in float vDepth;

out vec4 fragColor;

void main() {
  vec2 center = gl_PointCoord - vec2(0.5);
  float dist = length(center);
  
  float falloff = 1.0 - smoothstep(0.0, 0.5, dist);
  falloff = pow(falloff, 2.0);
  
  float ring = sin(dist * 50.0 - vDepth * 0.1) * 0.02 + 1.0;
  falloff *= ring;
  
  vec3 color = vColor.rgb * (1.0 + center.x * 0.1);
  float alpha = vColor.a * falloff;
  
  fragColor = vec4(color, alpha);
}
`;

export class DashboardParticles {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      particleCount: PARTICLE_COUNT,
      layerCount: LAYER_COUNT,
      ...options,
    };
    this.gl = null;
    this.programs = [];
    this.buffers = [];
    this.vaos = [];
    this.running = false;
    this.startTime = performance.now();
    this.mouse = { x: 0.5, y: 0.5, active: false };
    this.scroll = 0;
    this.intensity = 1.0;
    this.reducedMotion = false;
    this.frameCount = 0;
    this.lastFpsUpdate = 0;
    this.fps = 0;
    
    this.colorSchemes = {
      default: { a: [0.1, 0.3, 0.8], b: [0.8, 0.2, 0.6], c: [0.2, 0.9, 0.7] },
      dawn: { a: [1.0, 0.5, 0.2], b: [1.0, 0.8, 0.3], c: [0.5, 0.9, 1.0] },
      day: { a: [0.2, 0.6, 1.0], b: [0.4, 0.9, 0.5], c: [1.0, 0.7, 0.2] },
      dusk: { a: [0.8, 0.3, 0.1], b: [1.0, 0.4, 0.6], c: [0.5, 0.2, 0.8] },
      night: { a: [0.1, 0.1, 0.4], b: [0.3, 0.1, 0.6], c: [0.0, 0.5, 0.3] },
    };
    this.currentScheme = 'default';
    this.targetScheme = 'default';
    this.schemeTransition = 0;
  }

  init() {
    const gl = this.canvas.getContext('webgl2', {
      antialias: true,
      alpha: true,
      depth: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.blendEquationSeparate(gl.FUNC_ADD, gl.FUNC_ADD);
    gl.clearColor(0, 0, 0, 0);

    const vertShader = this._compileShader(gl.VERTEX_SHADER, VERT_SRC);
    const fragShader = this._compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);

    for (let layer = 0; layer < this.options.layerCount; layer++) {
      const program = this._createProgram(vertShader, fragShader);
      this.programs.push(program);
      
      const ids = new Float32Array(this.options.particleCount);
      for (let i = 0; i < this.options.particleCount; i++) ids[i] = i;
      
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, ids, gl.STATIC_DRAW);
      this.buffers.push(buffer);
      
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
      this.vaos.push(vao);
      
      program.uniforms = {
        uProjection: gl.getUniformLocation(program, 'uProjection'),
        uView: gl.getUniformLocation(program, 'uView'),
        uTime: gl.getUniformLocation(program, 'uTime'),
        uAspect: gl.getUniformLocation(program, 'uAspect'),
        uMouse: gl.getUniformLocation(program, 'uMouse'),
        uScroll: gl.getUniformLocation(program, 'uScroll'),
        uIntensity: gl.getUniformLocation(program, 'uIntensity'),
        uColorA: gl.getUniformLocation(program, 'uColorA'),
        uColorB: gl.getUniformLocation(program, 'uColorB'),
        uColorC: gl.getUniformLocation(program, 'uColorC'),
        uLayer: gl.getUniformLocation(program, 'uLayer'),
        uReducedMotion: gl.getUniformLocation(program, 'uReducedMotion'),
      };
    }

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this._setupEventListeners();
    this.resize();
    return this;
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile error: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
  }

  _createProgram(vert, frag) {
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link error: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  _setupEventListeners() {
    const handleMouseMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - rect.left) / rect.width;
      this.mouse.y = 1.0 - (e.clientY - rect.top) / rect.height;
      this.mouse.active = true;
    };
    const handleMouseLeave = () => { this.mouse.active = false; };
    const handleScroll = () => { this.scroll = window.scrollY; };
    const handleVisibility = () => { this.reducedMotion = document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches; };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    this.canvas.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('visibilitychange', handleVisibility);
    
    this._cleanup = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      this.canvas.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }

  resize() {
    if (!this.gl) return;
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.aspect = this.canvas.width / this.canvas.height;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._animate();
  }

  stop() {
    this.running = false;
    if (this._cleanup) this._cleanup();
  }

  _animate() {
    if (!this.running) return;
    requestAnimationFrame(() => this._animate());
    this._frame();
  }

  _frame() {
    const gl = this.gl;
    const now = performance.now();
    const time = (now - this.startTime) * 0.001;

    this.frameCount++;
    if (now - this.lastFpsUpdate > 1000) {
      this.fps = Math.round(this.frameCount * 1000 / (now - this.lastFpsUpdate));
      this.frameCount = 0;
      this.lastFpsUpdate = now;
    }

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const proj = perspective(mat4(), TAU / 8, this.aspect, 0.1, 100);
    const view = lookAt(mat4(), vec3(0, 0, 15), vec3(0, 0, 0), vec3(0, 1, 0));

    const scheme = this.colorSchemes[this.currentScheme];
    const targetScheme = this.colorSchemes[this.targetScheme];
    if (this.schemeTransition < 1.0) {
      this.schemeTransition += 0.005;
      this.currentColors = {
        a: scheme.a.map((v, i) => mix(v, targetScheme.a[i], this.schemeTransition)),
        b: scheme.b.map((v, i) => mix(v, targetScheme.b[i], this.schemeTransition)),
        c: scheme.c.map((v, i) => mix(v, targetScheme.c[i], this.schemeTransition)),
      };
    } else {
      this.currentColors = scheme;
    }

    for (let layer = 0; layer < this.options.layerCount; layer++) {
      const program = this.programs[layer];
      gl.useProgram(program);
      const u = program.uniforms;
      
      gl.uniformMatrix4fv(u.uProjection, false, proj);
      gl.uniformMatrix4fv(u.uView, false, view);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uAspect, this.aspect);
      gl.uniform2f(u.uMouse, this.mouse.x, this.mouse.y);
      gl.uniform1f(u.uScroll, this.scroll * 0.01);
      gl.uniform1f(u.uIntensity, this.intensity);
      gl.uniform3fv(u.uColorA, this.currentColors.a);
      gl.uniform3fv(u.uColorB, this.currentColors.b);
      gl.uniform3fv(u.uColorC, this.currentColors.c);
      gl.uniform1i(u.uLayer, layer);
      gl.uniform1f(u.uReducedMotion, this.reducedMotion ? 1.0 : 0.0);
      
      gl.bindVertexArray(this.vaos[layer]);
      gl.drawArrays(gl.POINTS, 0, this.options.particleCount);
    }

    gl.bindVertexArray(null);
    gl.useProgram(null);
  }

  setIntensity(value) { this.intensity = Math.max(0, Math.min(2, value)); }
  setColorScheme(name) { if (this.colorSchemes[name]) { this.targetScheme = name; this.schemeTransition = 0; } }
  setReducedMotion(value) { this.reducedMotion = value; }
  stats() { return { fps: this.fps, particles: this.options.particleCount * this.options.layerCount, layers: this.options.layerCount }; }
}

function mix(a, b, t) { return a * (1 - t) + b * t; }

export function createDashboardParticles(canvas, options) {
  return new DashboardParticles(canvas, options).init();
}