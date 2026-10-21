/**
 * The system constellation: a live picture of what this tab is actually doing.
 *
 * Every other "futuristic" panel in this project draws something it owns - a
 * CRDT, a 3D scene, a ciphertext relay. This one draws the *page itself*: the
 * eight modules as satellites around the running tab, each one's state read
 * from the same constants the scorecard uses, with peers, document throughput
 * and frame rate as the forces that move them. Nothing here is decorative
 * telemetry invented for the effect. If the app is idle, the canvas is idle.
 *
 * Two design decisions matter more than the visuals:
 *
 *   1. The geometry and the state mapping are pure functions. `buildModel`,
 *      `ring` and `describe` touch no DOM, so tests/constellation.test.js proves
 *      them in bare Node, and `paint` takes any object shaped like a 2D context,
 *      so the drawing pass is exercised against a recording stub rather than
 *      trusted. A canvas that can only be checked by looking at it is a canvas
 *      nobody checks.
 *
 *   2. It is a canvas, so it is invisible to assistive technology unless given
 *      a text alternative. `describe` produces that alternative from the same
 *      model, and the element carries `role="img"` with it as its `aria-label`
 *      (the a11y contract treats a nameless canvas as an error, WCAG 1.1.1).
 *
 * Reduced motion is not a switch that hides the picture: the model is still
 * true, so the canvas draws one frame per change and stops the loop. The
 * physical mode comes from ui/motion.js - `snap` springs teleport instead of
 * easing - so the whole page keeps one definition of "reduced motion".
 */

const TAU = Math.PI * 2;

/** Panel id -> the module it demonstrates. M0 is the shell itself. */
export const PANEL_MODULE = {
  dashboard: null,
  editor: 'M1',
  compiler: 'M2',
  engine: 'M3',
  crypto: 'M4',
  mesh: 'M5',
  offline: 'M6',
  a11y: 'M7',
  security: 'M8',
};

/**
 * Node colours. `active` is the module you are looking at, `ok` a module the
 * scorecard calls full, `partial` one that says exactly where it stops. The
 * colour is the claim, so it uses the same two words the scorecard does.
 */
export const STATES = {
  active: { fill: '#7ff3ff', halo: 'rgba(127, 243, 255, 0.28)', label: 'active' },
  ok: { fill: '#3ddc97', halo: 'rgba(61, 220, 151, 0.20)', label: 'full' },
  partial: { fill: '#f0b429', halo: 'rgba(240, 180, 41, 0.20)', label: 'partial' },
  peer: { fill: '#8b7bff', halo: 'rgba(139, 123, 255, 0.22)', label: 'peer' },
};

/** Evenly spaced points on a circle, the first at 12 o'clock. */
export function ring(count, radius, phase = -Math.PI / 2) {
  if (!Number.isFinite(count) || count <= 0) return [];
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const angle = phase + (TAU * i) / count;
    out.push({ angle, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return out;
}

const clamp01 = (value) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/**
 * The satellites, in the order the scorecard lists them. The active panel wins
 * over the status word, because "where you are" is the more useful thing to
 * draw than "how it scores" and the two would otherwise fight over one colour.
 */
export function modelNodes(activePanel, modules) {
  const active = PANEL_MODULE[activePanel] || null;
  return modules.map((m) => ({
    id: m.id,
    // Keep the scorecard's own word beside the drawn state: the open panel is
    // coloured "active", but it has not stopped being full or partial, and the
    // text alternative has to count it as what it is.
    status: m.status,
    state: m.id === active ? 'active' : m.status === 'ok' ? 'ok' : 'partial',
    points: m.points,
  }));
}

/**
 * Normalise live readings into the thing the painter draws. Every input is
 * optional: a browser without `performance.memory` simply has no heap, and the
 * model says so rather than inventing a number.
 */
export function buildModel({
  activePanel = 'dashboard',
  modules = [],
  peers = 0,
  opsDelta = 0,
  fps = null,
  heapMiB = null,
} = {}) {
  const nodes = modelNodes(activePanel, modules);
  return {
    nodes,
    // A ring of more than 12 peers is unreadable at this size; the count is
    // still reported in the text alternative.
    peers: Math.min(12, Math.max(0, Math.trunc(peers) || 0)),
    peerCount: Math.max(0, Math.trunc(peers) || 0),
    opsDelta: Math.max(0, Number(opsDelta) || 0),
    fps: Number.isFinite(fps) ? fps : null,
    heapMiB: Number.isFinite(heapMiB) ? heapMiB : null,
    // Document throughput is the only signal that says "work is happening right
    // now"; 20 operations in one sample is the point where the ring saturates.
    activity: clamp01((Number(opsDelta) || 0) / 20),
  };
}

/** The text alternative for the canvas, built from the same model. */
export function describe(model) {
  const active = model.nodes.find((n) => n.state === 'active');
  // Counted by status, not by colour: an open module is drawn as active and
  // would otherwise vanish from both totals and under-report the scorecard.
  const full = model.nodes.filter((n) => n.status === 'ok').length;
  const partial = model.nodes.filter((n) => n.status !== 'ok').length;
  const bits = [
    active ? `${active.id} is open` : 'the dashboard is open',
    `${full} of ${model.nodes.length} modules report full and ${partial} report partial`,
    `${model.peerCount} peer${model.peerCount === 1 ? '' : 's'} on the mesh`,
  ];
  if (model.fps !== null) bits.push(`${Math.round(model.fps)} frames per second`);
  if (model.heapMiB !== null) bits.push(`${model.heapMiB.toFixed(1)} mebibytes of heap`);
  bits.push(`${model.opsDelta} document operation${model.opsDelta === 1 ? '' : 's'} since the last sample`);
  return `Live system constellation: ${bits.join(', ')}.`;
}

/**
 * One frame. Takes anything that answers the 2D context calls used below, which
 * is what lets the test pass a recorder instead of a real canvas.
 */
export function paint(ctx, model, t, view = {}) {
  const width = view.width || 0;
  const height = view.height || 0;
  if (!width || !height) return;
  const cx = width / 2;
  const cy = height / 2;
  // The short side sets the type and the core; the long side sets the orbits.
  // A circle sized by the short side leaves two thirds of a wide dashboard
  // empty, which is the difference between an instrument and a widget.
  const span = Math.min(width, height);
  const coreR = Math.max(12, span * 0.065);
  const rx = Math.max(coreR * 2.6, width * 0.29);
  const ry = Math.max(coreR * 2.2, height * 0.33);
  const peerRx = rx * 1.24;
  const peerRy = ry * 1.22;
  const count = model.nodes.length;
  // A model with no modules is still a valid picture (the core and its rings),
  // so nothing below may divide by `count`.
  const phase = count ? Math.PI / count : 0;

  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(cx, cy);

  // Instrumentation first: two elliptical orbits A circle would be wrong here,
  // so these are ellipses, with tick marks at sixteen positions to read the
  // ring as a scale rather than a decoration.
  ctx.strokeStyle = 'rgba(120, 200, 255, 0.10)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(0, 0, peerRx, peerRy, 0, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(120, 200, 255, 0.16)';
  for (let i = 0; i < 16; i += 1) {
    const a = (TAU * i) / 16;
    const inner = i % 4 === 0 ? 0.97 : 0.99;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * rx * inner, Math.sin(a) * ry * inner);
    ctx.lineTo(Math.cos(a) * rx, Math.sin(a) * ry);
    ctx.stroke();
  }

  // One radial sweep, the only element that moves when the app is idle. Slow
  // enough to read as a scanner rather than a spinner.
  const sweep = t * 0.00035;
  ctx.strokeStyle = 'rgba(127, 243, 255, 0.22)';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(sweep) * peerRx, Math.sin(sweep) * peerRy);
  ctx.stroke();

  const nodes = ring(count, 1);
  const speed = 0.00016 + model.activity * 0.0009;

  // Edges, then the packets that travel them. A packet is the visible form of
  // "an operation happened": at activity 0 they crawl, at 1 they stream.
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    const nx = node.x * rx;
    const ny = node.y * ry;
    const colour = STATES[model.nodes[i].state] || STATES.partial;
    ctx.strokeStyle = colour.halo;
    ctx.beginPath();
    ctx.moveTo(node.x * coreR, node.y * coreR);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    const p = ((t * speed * 60 + i * 0.17) % 1);
    ctx.fillStyle = colour.fill;
    ctx.globalAlpha = 0.35 + 0.55 * Math.sin(p * Math.PI);
    ctx.beginPath();
    ctx.arc(nx * p, ny * p, Math.max(1.4, span * 0.005), 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // The core: breathing with throughput, and only ever as fast as the tab is
  // actually doing something.
  const pulse = 1 + Math.sin(t * (0.0012 + model.activity * 0.004)) * (0.04 + model.activity * 0.10);
  ctx.fillStyle = 'rgba(127, 243, 255, 0.14)';
  ctx.beginPath();
  ctx.arc(0, 0, coreR * pulse * 1.75, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#0a1626';
  ctx.strokeStyle = '#7ff3ff';
  ctx.lineWidth = Math.max(1, span * 0.004);
  ctx.beginPath();
  ctx.arc(0, 0, coreR * pulse, 0, TAU);
  ctx.fill();
  ctx.stroke();
  // An inner reticle, so the core reads as a sensor and not a dot.
  ctx.strokeStyle = 'rgba(127, 243, 255, 0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, coreR * 0.45, 0, TAU);
  ctx.stroke();

  // Peers, on their own ring, rotating the other way so the two groups never
  // read as one.
  const peerNodes = ring(model.peers, 1, phase - t * 0.00006);
  ctx.fillStyle = STATES.peer.fill;
  for (const peer of peerNodes) {
    ctx.beginPath();
    ctx.arc(peer.x * peerRx, peer.y * peerRy, Math.max(2, span * 0.010), 0, TAU);
    ctx.fill();
  }

  // Satellites. Labels sit outside the orbit, along the node's own direction, so
  // they never collide with the core or with each other.
  ctx.font = `${Math.max(10, Math.round(span * 0.034))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < count; i += 1) {
    const node = nodes[i];
    const state = model.nodes[i].state;
    const colour = STATES[state] || STATES.partial;
    const nx = node.x * rx;
    const ny = node.y * ry;
    const radius = Math.max(6, span * 0.026) * (state === 'active' ? 1.35 : 1);
    ctx.fillStyle = colour.halo;
    ctx.beginPath();
    ctx.arc(nx, ny, radius * 2.2, 0, TAU);
    ctx.fill();
    ctx.fillStyle = colour.fill;
    ctx.beginPath();
    ctx.arc(nx, ny, radius, 0, TAU);
    ctx.fill();
    ctx.fillStyle = state === 'active' ? '#dff7ff' : 'rgba(190, 210, 235, 0.75)';
    ctx.fillText(model.nodes[i].id, node.x * (rx + span * 0.055), node.y * (ry + span * 0.075));
  }

  ctx.restore();
}

/**
 * Mount the picture on a canvas and drive it from a `getModel` callback.
 *
 * The loop is deliberately cheap and honest about when it should not run:
 * at most 30 fps, never while the document is hidden, never after the canvas
 * has left the DOM, and never at all under reduced motion (one frame per model
 * change instead). A decorative canvas that burns a core in a background tab
 * would be the opposite of what this panel is claiming.
 */
export function mountConstellation(canvas, { reducedMotion = false, now = () => performance.now() } = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  let raf = 0;
  let last = 0;
  let model = buildModel();
  let width = 0;
  let height = 0;
  let disposed = false;

  const resize = () => {
    const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
    width = canvas.clientWidth || canvas.width || 0;
    height = canvas.clientHeight || canvas.height || 0;
    if (!width || !height) return;
    const w = Math.round(width * dpr);
    const h = Math.round(height * dpr);
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  const frame = (timeStamp) => {
    if (disposed) return;
    // Reduced motion: no loop to schedule, the picture is redrawn on change.
    if (reducedMotion) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden) return;
    // 30 fps is plenty for a diagram and halves the cost of the paint.
    if (timeStamp - last < 33) return;
    last = timeStamp;
    resize();
    paint(ctx, model, timeStamp, { width, height });
  };

  const redraw = () => {
    resize();
    paint(ctx, model, now(), { width, height });
  };

  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(redraw) : null;
  if (observer) observer.observe(canvas);
  const onVisibility = () => {
    if (!document.hidden) {
      last = 0;
      redraw();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    /** Push new readings. Rebuilds the text alternative, paints if static. */
    update(next) {
      model = buildModel(next);
      canvas.setAttribute('aria-label', describe(model));
      if (reducedMotion) redraw();
    },
    start() {
      if (disposed || reducedMotion) {
        redraw();
        return;
      }
      resize();
      if (!raf) raf = requestAnimationFrame(frame);
    },
    stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
    destroy() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    },
    get model() {
      return model;
    },
  };
}
