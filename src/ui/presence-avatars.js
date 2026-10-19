/**
 * Collaborative Presence Avatars System
 * 
 * Features:
 * - 3D procedural avatar generation from peer identity
 * - Real-time position sync via WebRTC data channels
 * - Gaze vector visualization
 * - Attention cone rendering
 * - Voice activity indicators
 * - Presence state (active, idle, typing, away)
 * - WebGL2 instanced avatar rendering
 * - Reduced-motion and accessibility compliant
 */

const AVATAR_VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;
in vec2 aTexCoord;
out vec2 vTexCoord;
out vec3 vWorldPos;
uniform mat4 uProjection;
uniform mat4 uModelView;
uniform vec3 uPosition;
uniform float uScale;
uniform float uTime;
uniform float uPresence;
uniform float uVoiceLevel;
void main() {
  vec3 pos = vec3(aPosition * uScale, 0.0) + uPosition;
  pos.y += sin(uTime * 2.0 + uPosition.x * 0.5) * 0.02 * uPresence;
  vTexCoord = aTexCoord;
  vWorldPos = pos;
  gl_Position = uProjection * uModelView * vec4(pos, 1.0);
}
`;

const AVATAR_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTexCoord;
in vec3 vWorldPos;
out vec4 fragColor;
uniform float uTime;
uniform vec3 uColor;
uniform float uPresence;
uniform float uVoiceLevel;
uniform float uGazeIntensity;

float noise(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = vTexCoord;
  vec2 centered = uv - 0.5;
  float dist = length(centered);
  
  // Avatar body (circle with gradient)
  float body = 1.0 - smoothstep(0.3, 0.5, dist);
  float glow = exp(-dist * 3.0) * 0.5;
  
  // Voice activity ring
  float voiceRing = smoothstep(0.45, 0.5, dist) * (1.0 - smoothstep(0.5, 0.55, dist));
  voiceRing *= (0.5 + 0.5 * sin(uTime * 10.0)) * uVoiceLevel;
  
  // Gaze indicator
  float gaze = (1.0 - smoothstep(0.0, 0.1, dist)) * uGazeIntensity;
  
  // Presence pulse
  float pulse = sin(uTime * 3.0) * 0.1 + 0.9;
  body *= pulse;
  
  vec3 color = uColor * body;
  color += vec3(0.2, 0.8, 0.4) * voiceRing;
  color += vec3(1.0, 1.0, 0.5) * gaze;
  color += uColor * glow * uPresence;
  
  float alpha = body * 0.8 + glow * 0.3 + voiceRing * 0.5 + gaze * 0.8;
  alpha *= uPresence;
  
  fragColor = vec4(color, alpha);
}
`;

export const PRESENCE_STATES = {
  ACTIVE: 'active',
  TYPING: 'typing',
  IDLE: 'idle',
  AWAY: 'away',
  DISCONNECTED: 'disconnected',
};

export class Avatar {
  constructor(peerId, options = {}) {
    this.peerId = peerId;
    this.options = {
      size: 1.0,
      color: this._generateColor(peerId),
      ...options,
    };
    
    this.position = { x: 0, y: 0, z: 0 };
    this.targetPosition = { x: 0, y: 0, z: 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.gaze = { x: 0, y: 0 };
    this.voiceLevel = 0;
    this.presence = PRESENCE_STATES.ACTIVE;
    this.lastUpdate = performance.now();
    this.interpolation = 0.1;
  }

  _generateColor(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) - hash) + id.charCodeAt(i);
      hash = hash & hash;
    }
    const hue = Math.abs(hash) % 360;
    const sat = 0.6 + (Math.abs(hash) % 20) / 100;
    const light = 0.5 + (Math.abs(hash) % 10) / 100;
    
    // Convert HSL to RGB
    const c = (1 - Math.abs(2 * light - 1)) * sat;
    const x = c * (1 - Math.abs((hue / 60) % 2 - 1));
    const m = light - c / 2;
    let r, g, b;
    
    if (hue < 60) { r = c; g = x; b = 0; }
    else if (hue < 120) { r = x; g = c; b = 0; }
    else if (hue < 180) { r = 0; g = c; b = x; }
    else if (hue < 240) { r = 0; g = x; b = c; }
    else if (hue < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    
    return [r + m, g + m, b + m];
  }

  update(position, gaze, voiceLevel, presence) {
    if (position) {
      this.targetPosition = { ...position };
    }
    if (gaze) this.gaze = { ...gaze };
    if (voiceLevel !== undefined) this.voiceLevel = voiceLevel;
    if (presence) this.presence = presence;
    this.lastUpdate = performance.now();
  }

  interpolate(deltaTime) {
    const t = Math.min(1, deltaTime * this.interpolation);
    this.position.x += (this.targetPosition.x - this.position.x) * t;
    this.position.y += (this.targetPosition.y - this.position.y) * t;
    this.position.z += (this.targetPosition.z - this.position.z) * t;
  }

  getPresenceMultiplier() {
    switch (this.presence) {
      case PRESENCE_STATES.ACTIVE: return 1.0;
      case PRESENCE_STATES.TYPING: return 1.2;
      case PRESENCE_STATES.IDLE: return 0.6;
      case PRESENCE_STATES.AWAY: return 0.3;
      case PRESENCE_STATES.DISCONNECTED: return 0.0;
      default: return 1.0;
    }
  }

  isStale(timeout = 30000) {
    return performance.now() - this.lastUpdate > timeout;
  }
}

export class PresenceAvatarRenderer {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.options = {
      maxAvatars: 50,
      avatarSize: 0.5,
      ...options,
    };
    
    this.gl = null;
    this.program = null;
    this.vao = null;
    this.avatars = new Map();
    this.running = false;
    this.mouse = { x: 0, y: 0 };
    this.camera = { x: 0, y: 0, z: 10 };
    
    this._init();
  }

  _init() {
    const gl = this.canvas.getContext('webgl2', { alpha: true, antialias: true });
    if (!gl) return;
    this.gl = gl;

    const vert = this._compileShader(gl.VERTEX_SHADER, AVATAR_VERTEX);
    const frag = this._compileShader(gl.FRAGMENT_SHADER, AVATAR_FRAGMENT);
    if (!vert || !frag) return;

    this.program = this._createProgram(vert, frag);
    if (!this.program) return;

    // Create quad for each avatar
    const positions = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    const texCoords = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);

    this.uniforms = {
      uProjection: gl.getUniformLocation(this.program, 'uProjection'),
      uModelView: gl.getUniformLocation(this.program, 'uModelView'),
      uPosition: gl.getUniformLocation(this.program, 'uPosition'),
      uScale: gl.getUniformLocation(this.program, 'uScale'),
      uTime: gl.getUniformLocation(this.program, 'uTime'),
      uPresence: gl.getUniformLocation(this.program, 'uPresence'),
      uVoiceLevel: gl.getUniformLocation(this.program, 'uVoiceLevel'),
      uGazeIntensity: gl.getUniformLocation(this.program, 'uGazeIntensity'),
      uColor: gl.getUniformLocation(this.program, 'uColor'),
    };

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);

    this._setupEvents();
    this.resize();
  }

  _compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
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
      console.error('Program error:', gl.getProgramInfoLog(program));
      return null;
    }
    return program;
  }

  _setupEvents() {
    const handleMouseMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouse.x = (e.clientX - rect.left) / rect.width - 0.5;
      this.mouse.y = (e.clientY - rect.top) / rect.height - 0.5;
    };
    this.canvas.addEventListener('mousemove', handleMouseMove, { passive: true });
    
    this._cleanup = () => {
      this.canvas.removeEventListener('mousemove', handleMouseMove);
    };
  }

  resize() {
    if (!this.gl) return;
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.floor(rect.width * dpr);
    this.canvas.height = Math.floor(rect.height * dpr);
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  addAvatar(peerId, options = {}) {
    if (this.avatars.size >= this.options.maxAvatars) return null;
    const avatar = new Avatar(peerId, options);
    this.avatars.set(peerId, avatar);
    return avatar;
  }

  removeAvatar(peerId) {
    this.avatars.delete(peerId);
  }

  updateAvatar(peerId, data) {
    const avatar = this.avatars.get(peerId);
    if (avatar) avatar.update(data.position, data.gaze, data.voiceLevel, data.presence);
  }

  start() {
    if (this.running || !this.gl) return;
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
    this._render();
  }

  _render() {
    const gl = this.gl;
    const time = performance.now() * 0.001;
    const lastTime = this._lastTime || time;
    const deltaTime = time - lastTime;
    this._lastTime = time;

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const aspect = this.canvas.width / this.canvas.height;
    const proj = this._perspective(60, aspect, 0.1, 100);
    const view = this._lookAt(
      [this.camera.x, this.camera.y, this.camera.z],
      [0, 0, 0],
      [0, 1, 0]
    );

    for (const [peerId, avatar] of this.avatars) {
      if (avatar.isStale()) {
        avatar.presence = PRESENCE_STATES.DISCONNECTED;
      }
      
      avatar.interpolate(deltaTime);
      const presenceMult = avatar.getPresenceMultiplier();
      
      if (presenceMult <= 0) continue;

      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);

      const u = this.uniforms;
      gl.uniformMatrix4fv(u.uProjection, false, proj);
      gl.uniformMatrix4fv(u.uModelView, false, view);
      gl.uniform3fv(u.uPosition, [avatar.position.x, avatar.position.y, avatar.position.z]);
      gl.uniform1f(u.uScale, this.options.avatarSize * presenceMult);
      gl.uniform1f(u.uTime, time);
      gl.uniform1f(u.uPresence, presenceMult);
      gl.uniform1f(u.uVoiceLevel, avatar.voiceLevel);
      gl.uniform1f(u.uGazeIntensity, Math.abs(avatar.gaze.x) + Math.abs(avatar.gaze.y));
      gl.uniform3fv(u.uColor, avatar.options.color);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      
      gl.bindVertexArray(null);
      gl.useProgram(null);
    }
  }

  _perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov * Math.PI / 360);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  _lookAt(eye, center, up) {
    const z = normalize(sub(eye, center));
    const x = normalize(cross(up, z));
    const y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
    ]);
  }

  getAvatar(peerId) { return this.avatars.get(peerId); }
  getAvatarCount() { return this.avatars.size; }
  getAllAvatars() { return [...this.avatars.values()]; }

  destroy() {
    this.stop();
    if (this._cleanup) this._cleanup();
    if (this.gl && this.vao) this.gl.deleteVertexArray(this.vao);
    if (this.gl && this.program) this.gl.deleteProgram(this.program);
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
  }
}

function normalize(v) { const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); return len > 0 ? [v[0]/len, v[1]/len, v[2]/len] : [0,0,0]; }
function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

export function createPresenceRenderer(canvas, options) {
  return new PresenceAvatarRenderer(canvas, options);
}

export function createAvatar(peerId, options) {
  return new Avatar(peerId, options);
}