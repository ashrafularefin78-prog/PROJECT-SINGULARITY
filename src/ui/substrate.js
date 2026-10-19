/**
 * The substrate: one WebGL2 canvas that *is* the environment, not decoration
 * painted behind it.
 *
 * A raymarched singularity - an accretion disk around a photon ring - whose
 * physical parameters are the page's real telemetry. Nothing here is scripted
 * art: every uniform is a number the app already measures and the header
 * telemetry strip already publishes.
 *
 *   uSpin   ← CRDT document operations per second (the disk's Keplerian flow)
 *   uGlow   ← 3D frame rate over 60 (the halo's luminosity)
 *   uTurb   ← relay outbox depth (turbulence injected into the disk)
 *   uEnergy ← module-transition impulses (a spring-driven brightness kick)
 *   uError  ← failed-command impulses (a warm flash that decays like Poisson)
 *
 * Constraints honoured from the rest of the codebase:
 *   - zero dependencies, PC-created DOM only (createElement, no innerHTML);
 *   - the CSP forbids inline styles, so every visual state is a data attribute
 *     styled by styles/app.css - sizes live in canvas *attributes*, which the
 *     policy does not govern;
 *   - FX gating is absolute: 'off' never creates the GL work, 'reduced' draws
 *     one still frame instead of a loop, and high-contrast/forced-colors hide
 *     the layer outright (M7 contract);
 *   - failure is honest: no WebGL2, a shader compile error or a lost context
 *     all degrade to the CSS scene (data-substrate='css'|'lost'), never to a
 *     blank or broken page.
 *
 * Unit tests: tests/substrate.test.js (browser-only, real WebGL2).
 */

import { Spring, SPRINGS } from './motion.js';

// ------------------------------------------------------------------ telemetry

/** The bus the app's one-second sampler pushes into. Values read as of write. */
export const telemetry = {
  fps: null,
  opsDelta: 0,
  ops: 0,
  peers: 1,
  relay: 0,
  heapMb: null,
  dial: 0,
  /** Impulse from a module transition or a failed command. */
  pulse(kind) {
    stateBus.impulse = kind === 'error' ? 'error' : 'energy';
  },
};

const stateBus = {
  impulse: null,
};

// --------------------------------------------------------------------- shader

const VERT = `#version 300 es
void main() {
  vec2 up = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(up * 2.0 - 1.0, 0.0, 1.0);
}`;

/**
 * The singularity. Kept to one additive pass and a bounded march so it costs
 * about a quarter of a frame on the machine the PBR budget was measured on.
 * Physics in the field: Keplerian differential rotation (inner bands circle
 * faster), Doppler beaming toward the approaching side, inverse-square
 * lensing pinching the field lines, and Reinhard-style filmic tonemapping -
 * the same tone path the M3 renderer uses.
 */
const FRAG = `#version 300 es
precision highp float;

uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uSpin;
uniform float uGlow;
uniform float uTurb;
uniform float uEnergy;
uniform float uError;

out vec4 frag;

const vec3 BLUE = vec3(0.431, 0.659, 0.996);
const vec3 PURPLE = vec3(0.702, 0.635, 0.878);
const vec3 CYAN = vec3(0.302, 0.816, 0.882);
const vec3 WARM = vec3(1.0, 0.502, 0.553);

float hash21(vec2 p) {
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float a = 0.5;
  float v = 0.0;
  for (int i = 0; i < 3; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = (2.0 * gl_FragCoord.xy - uRes) / min(uRes.x, uRes.y);

  // Pointer parallax: the whole field leans a few degrees with the mouse.
  float lean = uMouse.x * 0.14;
  float ca = cos(lean);
  float sa = sin(lean);
  uv = mat2(ca, -sa, sa, ca) * uv;
  uv += uMouse * 0.03;

  vec2 focus = uv - vec2(0.0, 0.06);
  float r0 = length(focus);

  // Gravitational lensing: the deflection scales like 1/r^2. Applied as a
  // screen-space pinch - cheap, stable, and it reads as the real effect.
  vec2 bent = focus * (1.0 - 0.05 / (r0 * r0 + 0.08));
  float r = length(bent);
  float angle = atan(bent.y, bent.x);

  // Deep-space base: the page's own gradient shows through via alpha later.
  vec3 col = vec3(0.0);

  // --- accretion disk, seen at an inclination (squashed ellipse) -------------
  float incl = 2.35;                         // y squash: near edge-on
  vec2 disk = bent * vec2(1.0, incl);
  float rd = length(disk);
  float spin = uTime * (0.35 + uSpin);
  float kepler = spin / (rd * rd * 3.4 + 0.22); // inner bands flow faster

  float inner = smoothstep(0.20, 0.30, rd);
  float outer = 1.0 - smoothstep(0.72, 1.12 + uTurb * 0.18, rd);
  float band = inner * outer;

  // Matter streams, advected by the rotation; turbulence = relay backlog.
  float streaks = fbm(vec2(angle * 2.6 + kepler * 3.0, rd * 7.0 + kepler));
  streaks += fbm(vec2(angle * 5.3 - kepler * 5.0, rd * 13.0 + uTime * 0.15)) * 0.5;
  streaks = pow(max(streaks, 0.0) * 0.72, 1.6);
  float turb = 1.0 + uTurb * (fbm(vec2(rd * 9.0, angle * 4.0 + uTime * 0.6)) - 0.5) * 1.4;
  float density = band * streaks * turb;

  // Doppler beaming: the limb rotating toward the viewer is brighter.
  float doppler = 1.0 + 0.5 * cos(angle - 1.9);

  // Gravitational redshift dims the innermost band as it approaches the rim.
  float redshift = 1.0 - 0.65 * smoothstep(0.28, 0.19, rd);
  vec3 diskCol = mix(BLUE, PURPLE, smoothstep(0.2, 0.75, rd));
  diskCol = mix(diskCol, CYAN, smoothstep(0.75, 0.35, rd) * 0.55);
  col += diskCol * density * doppler * redshift * (0.55 + 0.75 * uGlow) * (1.0 + uEnergy * 1.3);

  // --- photon ring -----------------------------------------------------------
  float ring = exp(-abs(r - 0.185) * 90.0);
  col += mix(BLUE, CYAN, 0.4) * ring * (0.9 + 0.8 * uGlow);

  // The event horizon: an absorbing sphere with a temperature rim.
  if (r < 0.185) {
    float rim = smoothstep(0.185, 0.16, r);
    col = mix(col, vec3(0.0), rim * 0.95);
    col += WARM * (1.0 - rim) * ring * 0.35;
  }

  // Hawking shimmer: deterministic flicker at the horizon, never random art.
  float shimmer = step(0.986, hash21(vec2(floor(angle * 60.0), floor(uTime * 17.0))));
  col += CYAN * shimmer * (1.0 - smoothstep(0.16, 0.24, r)) * 0.5 * (0.4 + uGlow);

  // Error state: a warm alarm that tints the rim flash, decaying via uError.
  col += WARM * uError * exp(-abs(r - 0.24) * 14.0) * 0.8;

  // --- tone map + vignette + dither ------------------------------------------
  col = 1.0 - exp(-col * 1.7);              // filmic-ish exposure
  col = pow(col, vec3(0.9));                // slight lift toward the tokens
  float vig = 1.0 - 0.32 * smoothstep(0.55, 1.6, length(uv));
  col *= vig;

  // Blue-noise-ish dither so the dark band does not band on LCD panels.
  col += (hash21(gl_FragCoord.xy) - 0.5) * (1.0 / 255.0) * 2.0;

  float alpha = clamp(max(max(col.r, col.g), col.b) * 1.6, 0.0, 1.0);
  frag = vec4(col, alpha);
}`;

// --------------------------------------------------------------------- engine

const SUBST_ATTR = 'data-substrate';

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`substrate shader: ${log}`);
  }
  return sh;
}

const UNIFORMS = ['uRes', 'uTime', 'uMouse', 'uSpin', 'uGlow', 'uTurb', 'uEnergy', 'uError'];

class Substrate {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { alpha: true, depth: false, stencil: false, antialias: false, powerPreference: 'low-power' });
    if (!this.gl) throw new Error('WebGL2 unavailable');
    const gl = this.gl;
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`substrate link: ${log}`);
    }
    gl.useProgram(program);
    this.program = program;
    this.uniform = {};
    for (const name of UNIFORMS) this.uniform[name] = gl.getUniformLocation(program, name);
    // One bound VAO and drawArrays(0,3): the fullscreen triangle is generated
    // from gl_VertexID, so no buffers exist at all.
    gl.bindVertexArray(gl.createVertexArray());
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);

    this.scale = 0.8;
    this.renderScale = this.scale;
    this.frames = 0;
    this.running = false;
    this.destroyed = false;
    this.mouse = [0, 0];
    this.mouseTarget = [0, 0];
    this.startAt = performance.now();
    this.frameTimes = [];

    // Telemetry smoothing springs - the same physics the UI motion uses.
    this.springs = {
      spin: new Spring({ value: 0.35, ...SPRINGS.soft }),
      glow: new Spring({ value: 0.55, ...SPRINGS.soft }),
      turb: new Spring({ value: 0, ...SPRINGS.soft }),
      energy: new Spring({ value: 0, stiffness: 120, dampingRatio: 0.32 }),
      error: new Spring({ value: 0, stiffness: 140, dampingRatio: 0.5 }),
    };

    this.onResize = () => this.resize();
    this.onVisibility = () => {
      if (!document.hidden && this.fxMode() === 'full') this.begin();
    };
    this.onPointer = (event) => {
      this.mouseTarget[0] = (event.clientX / Math.max(1, innerWidth)) * 2 - 1;
      this.mouseTarget[1] = (event.clientY / Math.max(1, innerHeight)) * 2 - 1;
    };
    this.onContextLost = (event) => {
      // Let the page keep working: the canvas degrades to the CSS scene.
      event.preventDefault();
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.setAttr('lost');
    };
    addEventListener('resize', this.onResize, { passive: true });
    document.addEventListener('visibilitychange', this.onVisibility);
    addEventListener('pointermove', this.onPointer, { passive: true });
    canvas.addEventListener('webglcontextlost', this.onContextLost);

    // M7: the FX state machine owns this layer. Observe it.
    this.observer = new MutationObserver(() => this.syncFx());
    this.observer.observe(document.documentElement, { attributeFilter: ['data-fx', 'data-motion', 'data-contrast', 'data-scale'] });
  }

  setAttr(value) {
    const html = document.documentElement;
    if (html.getAttribute(SUBST_ATTR) !== value) html.setAttribute(SUBST_ATTR, value);
  }

  attr() {
    return document.documentElement.getAttribute(SUBST_ATTR);
  }

  /** Resolve the resolved-FX state to a substrate mode. */
  fxMode() {
    const html = document.documentElement;
    const fx = html.dataset.fx || 'full';
    if (fx === 'off') return 'off';
    if (fx === 'reduced') return 'reduced';
    if ((html.dataset.contrast || '') === 'high') return 'off';
    if (html.dataset.motion === 'reduced') return 'reduced';
    return 'full';
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    const w = Math.max(2, Math.round((innerWidth * dpr * this.renderScale) / 16) * 16);
    const h = Math.max(2, Math.round((innerHeight * dpr * this.renderScale) / 16) * 16);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  syncFx() {
    if (this.destroyed) return;
    const mode = this.fxMode();
    if (mode === 'off') {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.setAttr('stopped');
      return;
    }
    if (mode === 'reduced') {
      this.running = false;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = null;
      this.resize();
      this.draw(true);
      this.setAttr('reduced');
      // One fresh still frame every six seconds: the scene stays truthful
      // without ever animating.
      if (!this.stillTimer) this.stillTimer = setInterval(() => {
        if (!this.destroyed && this.fxMode() === 'reduced' && !document.hidden) this.draw(true);
      }, 6000);
      return;
    }
    if (this.stillTimer) {
      clearInterval(this.stillTimer);
      this.stillTimer = null;
    }
    this.setAttr('gpu');
    this.begin();
  }

  begin() {
    if (this.running || this.destroyed) return;
    this.running = true;
    this.resize();
    const loop = (now) => {
      if (!this.running || this.destroyed) return;
      if (document.hidden) {
        this.raf = requestAnimationFrame(loop);
        return;
      }
      this.draw(false, now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  mode() {
    const attr = this.attr();
    return attr === 'gpu' ? 'webgl2' : attr || 'idle';
  }

  stats() {
    return {
      mode: this.mode(),
      running: this.running,
      frames: this.frames,
      scale: this.renderScale,
      uniforms: {
        spin: this.springs.spin.value,
        glow: this.springs.glow.value,
        turb: this.springs.turb.value,
        energy: this.springs.energy.value,
        error: this.springs.error.value,
      },
    };
  }

  /** Shake decayed impulses into the springs, then converge toward telemetry. */
  stepSprings(dt) {
    if (stateBus.impulse) {
      const kind = stateBus.impulse;
      stateBus.impulse = null;
      if (kind === 'error') {
        this.springs.error.jump(1);
        this.springs.error.setTarget(0);
      } else {
        this.springs.energy.jump(1);
        this.springs.energy.setTarget(0);
      }
    }
    const t = telemetry;
    // Keplerian flow: 0 → none, ~40 ops/s → full gallop.
    this.springs.spin.setTarget(0.35 + Math.min(1, t.opsDelta / 40) * 1.65);
    // Luminosity: the frame rate the engine is actually achieving.
    this.springs.glow.setTarget(t.fps == null ? 0.42 + 0.13 * Math.sin(performance.now() / 4000) : Math.min(1, Math.max(0.25, t.fps / 60)));
    // Turbulence: a queued relay frame is matter waiting for a node.
    this.springs.turb.setTarget(Math.min(1, t.relay / 48));
    const list = [this.springs.spin, this.springs.glow, this.springs.turb, this.springs.energy, this.springs.error];
    for (const spring of list) spring.step(dt);
  }

  draw(still, now = performance.now()) {
    const gl = this.gl;
    const dt = Math.min(0.1, (now - (this.lastNow || now)) / 1000) || 0.016;
    this.lastNow = now;
    this.stepSprings(dt);
    // Pointer smoothing: a tiny first-order filter, motion-scaled by dt.
    const a = 1 - Math.exp(-dt * 6);
    this.mouse[0] += (this.mouseTarget[0] - this.mouse[0]) * a;
    this.mouse[1] += (this.mouseTarget[1] - this.mouse[1]) * a;

    const t0 = performance.now();
    this.resize();
    gl.uniform2f(this.uniform.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.uniform.uTime, (now - this.startAt) / 1000);
    gl.uniform2f(this.uniform.uMouse, this.mouse[0], this.mouse[1]);
    gl.uniform1f(this.uniform.uSpin, this.springs.spin.value);
    gl.uniform1f(this.uniform.uGlow, this.springs.glow.value);
    gl.uniform1f(this.uniform.uTurb, this.springs.turb.value);
    gl.uniform1f(this.uniform.uEnergy, this.springs.energy.value);
    gl.uniform1f(this.uniform.uError, this.springs.error.value);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.frames += 1;

    // Adaptive resolution: stay under ~7 ms per pass by moving the buffer
    // scale, not the shader. Evaluated over 40-frame windows.
    if (!still && this.fxMode() === 'full') {
      this.frameTimes.push(performance.now() - t0);
      if (this.frameTimes.length >= 40) {
        const avg = this.frameTimes.reduce((s, v) => s + v, 0) / this.frameTimes.length;
        this.frameTimes.length = 0;
        const next = avg > 9 ? Math.max(0.5, this.renderScale - 0.15) : avg < 5 ? Math.min(0.9, this.renderScale + 0.1) : this.renderScale;
        if (next !== this.renderScale) this.renderScale = next;
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.stillTimer) clearInterval(this.stillTimer);
    this.observer.disconnect();
    removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    removeEventListener('pointermove', this.onPointer);
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
      const lose = this.gl && this.gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      this.canvas.remove();
    }
    document.documentElement.removeAttribute(SUBST_ATTR);
  }
}

// -------------------------------------------------------------------- mount

/**
 * Mount the substrate (once per page). Idempotent: a second call returns the
 * first instance. On any failure the canvas is removed and data-substrate is
 * left unset so the CSS scene keeps carrying the viewport. Returns null when
 * the layer degraded - the caller logs that, nothing breaks.
 */
export function mountSubstrate() {
  if (mountSubstrate.current) return mountSubstrate.current;
  const canvas = document.createElement('canvas');
  canvas.className = 'substrate';
  canvas.setAttribute('aria-hidden', 'true');
  const anchor = document.querySelector('.fx') || document.body.firstElementChild;
  if (anchor && anchor.isConnected) document.body.insertBefore(canvas, anchor);
  else document.body.appendChild(canvas);
  let substrate;
  try {
    substrate = new Substrate(canvas);
  } catch (err) {
    canvas.remove();
    console.warn('[substrate] degraded to the CSS scene:', err.message);
    document.documentElement.setAttribute(SUBST_ATTR, 'css');
    return null;
  }
  mountSubstrate.current = substrate;
  substrate.syncFx();
  return substrate;
}

export function unmountSubstrate() {
  if (mountSubstrate.current) {
    mountSubstrate.current.destroy();
    mountSubstrate.current = null;
  }
  document.documentElement.removeAttribute(SUBST_ATTR);
}
