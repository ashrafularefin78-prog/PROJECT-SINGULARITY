/**
 * The futuristic UI layer, proven where it can be proven without a GPU: theme
 * tables must be total (every hour paints), avatar interpolation must converge
 * without overshooting, and the telemetry statistics must flag a real outlier
 * while leaving a steady signal alone. The DOM/WebGL pieces declare their
 * needs, so the browser run owns them and the Node run counts them as skips
 * rather than failures.
 */
import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import { THEMES, HIGH_CONTRAST_THEME } from '../src/ui/theming.js';
import { Avatar, PRESENCE_STATES, createAvatar } from '../src/ui/presence-avatars.js';
import { METRIC_TYPES, PREDICTION_HORIZONS, TelemetryEngine } from '../src/ui/telemetry-advanced.js';
import { TRANSITION_TYPES, TRANSITION_DURATION, TRANSITION_EASING } from '../src/ui/transitions.js';
import { A11yAI } from '../src/ui/a11y-ai.js';
import { createHolographicText, createHolographicButton } from '../src/ui/holographic.js';
import { PresenceAvatarRenderer } from '../src/ui/presence-avatars.js';
import { createDashboardParticles } from '../src/graphics/dashboard-particles.js';

const REQUIRED_TOKENS = [
  'bg', 'bgElevated', 'surface', 'border', 'primary', 'primaryHover', 'secondary',
  'accent', 'text', 'textMuted', 'success', 'warning', 'error', 'glow',
  'particleA', 'particleB', 'particleC',
];

test('theming: every theme carries the full token set the CSS contract needs', () => {
  for (const [name, theme] of Object.entries({ ...THEMES, 'high-contrast': HIGH_CONTRAST_THEME })) {
    for (const token of REQUIRED_TOKENS) {
      assert(token in theme.colors, `${name} is missing --theme-${token}`);
    }
    assertDeepEquals(Object.keys(theme.gradients).sort(), ['button', 'card', 'hero'], `${name} gradients`);
    for (const key of ['particleA', 'particleB', 'particleC']) {
      const rgb = theme.colors[key];
      assertEquals(rgb.length, 3, `${name}.${key} is an rgb triple`);
      for (const channel of rgb) assert(channel >= 0 && channel <= 1, `${name}.${key} channel ${channel}`);
    }
  }
});

test('theming: every solid colour token parses as hex, and hue gradients stay gradients', () => {
  for (const [name, theme] of Object.entries(THEMES)) {
    for (const [token, value] of Object.entries(theme.colors)) {
      if (Array.isArray(value)) continue;
      assert(/^#[0-9a-f]{6}$/i.test(value) || /^rgba\(/.test(value), `${name}.${token} = ${value}`);
    }
    for (const [slot, css] of Object.entries(theme.gradients)) {
      assert(css.includes('gradient('), `${name}.${slot} is a gradient`);
    }
  }
});

test('theming: the four day periods tile 24 hours with no gap and no overlap', () => {
  const hits = new Array(24).fill(0);
  for (const theme of Object.values(THEMES)) {
    const { start, end } = theme.period;
    for (let hour = 0; hour < 24; hour += 1) {
      const inside = start < end ? hour >= start && hour < end : hour >= start || hour < end;
      if (inside) hits[hour] += 1;
    }
  }
  for (let hour = 0; hour < 24; hour += 1) {
    assertEquals(hits[hour], 1, `hour ${hour} must map to exactly one theme`);
  }
});

test('transitions: the type table is the exported contract, one value per key', () => {
  assertDeepEquals(
    Object.values(TRANSITION_TYPES).sort(),
    ['dissolve', 'fold', 'glitch', 'morph', 'portal', 'quantum', 'slide'],
  );
  for (const [key, value] of Object.entries(TRANSITION_TYPES)) assertEquals(value, key.toLowerCase());
  assert(TRANSITION_DURATION > 0 && TRANSITION_DURATION < 2000, `duration ${TRANSITION_DURATION}`);
  assert(TRANSITION_EASING.startsWith('cubic-bezier('), TRANSITION_EASING);
});

test('presence: an avatar colour is deterministic and a valid rgb triple', () => {
  const a = new Avatar('peer-alpha');
  const b = new Avatar('peer-alpha');
  assertDeepEquals(a.options.color, b.options.color, 'same id, same colour');
  for (const channel of a.options.color) {
    assert(channel >= 0 && channel <= 1, `channel ${channel}`);
  }
});

test('presence: interpolation approaches the target without overshooting', () => {
  const avatar = createAvatar('peer-interp');
  avatar.update({ x: 10, y: -4, z: 2 });
  let previous = Infinity;
  for (let i = 0; i < 200; i += 1) {
    avatar.interpolate(1);
    const distance = Math.abs(avatar.position.x - 10)
      + Math.abs(avatar.position.y + 4)
      + Math.abs(avatar.position.z - 2);
    assert(distance <= previous + 1e-9, `distance must not grow back: ${distance} > ${previous}`);
    previous = distance;
  }
  assert(previous < 1e-6, `converged to within a millionth (${previous})`);
});

test('presence: the state ladder orders activity, and disconnected renders nothing', () => {
  const avatar = createAvatar('peer-ladder');
  const multiplier = (state) => {
    avatar.presence = state;
    return avatar.getPresenceMultiplier();
  };
  const typing = multiplier(PRESENCE_STATES.TYPING);
  const active = multiplier(PRESENCE_STATES.ACTIVE);
  const idle = multiplier(PRESENCE_STATES.IDLE);
  const away = multiplier(PRESENCE_STATES.AWAY);
  const gone = multiplier(PRESENCE_STATES.DISCONNECTED);
  assert(typing >= active && active > idle && idle > away && away > gone, 'ladder is ordered');
  assertEquals(gone, 0, 'a disconnected peer is not drawn');
});

test('presence: a silent peer goes stale after the timeout', () => {
  const avatar = createAvatar('peer-stale');
  assertEquals(avatar.isStale(30000), false, 'fresh arrival');
  avatar.lastUpdate = performance.now() - 31000;
  assertEquals(avatar.isStale(30000), true, 'silence over the timeout');
});

test('telemetry: counters aggregate exactly when privacy noise is off', () => {
  const engine = new TelemetryEngine({ samplingRate: 60000, privacyBudget: 0 });
  try {
    engine.record('clicks', 3, METRIC_TYPES.COUNTER);
    engine.record('clicks', 4, METRIC_TYPES.COUNTER);
    const metric = engine.getMetric('clicks');
    assertEquals(metric.count, 2);
    assertEquals(metric.sum, 7);
    assertEquals(metric.min, 3);
    assertEquals(metric.max, 4);
    assertEquals(metric.value, 4);
  } finally {
    engine.destroy();
  }
});

test('telemetry: an injected outlier is flagged, a steady signal is not', () => {
  const engine = new TelemetryEngine({ samplingRate: 60000, privacyBudget: 0 });
  try {
    for (let i = 0; i < 40; i += 1) {
      engine.record('latency', 100 + (i % 5) * 0.1);
      engine.sample();
    }
    assertEquals(engine.getAnomalies().length, 0, 'noise band is not an anomaly');
    engine.record('latency', 10000);
    engine.sample();
    const anomalies = engine.getAnomalies();
    assert(anomalies.length >= 1, 'the outlier must be flagged');
    const last = anomalies[anomalies.length - 1];
    assertEquals(last.metric, 'latency');
    assert(['medium', 'high', 'critical'].includes(last.severity), last.severity);
  } finally {
    engine.destroy();
  }
});

test('telemetry: prediction holds a constant series and reports honest confidence', () => {
  const engine = new TelemetryEngine({ samplingRate: 60000, privacyBudget: 0 });
  try {
    for (let i = 0; i < 30; i += 1) {
      engine.record('temp', 42);
      engine.sample();
    }
    const prediction = engine.getPrediction('temp');
    assert(prediction, 'a prediction exists after ten samples');
    for (const [horizon, value] of Object.entries(prediction.predictions)) {
      assert(Math.abs(value - 42) < 0.5, `${horizon} horizon drifted: ${value}`);
    }
    assert(prediction.confidence >= 0.9, `a constant series is predictable (${prediction.confidence})`);
    assert(Object.keys(PREDICTION_HORIZONS).every((k) => k in prediction.predictions), 'all horizons answered');
  } finally {
    engine.destroy();
  }
});

test('telemetry: an alert fires on crossing and re-arms after recovery', () => {
  const engine = new TelemetryEngine({ samplingRate: 60000, privacyBudget: 0 });
  const seen = [];
  try {
    engine.on('alert', (alert) => seen.push(alert));
    engine.addAlert('fps', (value) => value < 30, 'frame rate below 30 fps');
    engine.record('fps', 25);
    engine.sample();
    assertEquals(seen.length, 1, 'crossing fires once');
    engine.sample();
    assertEquals(seen.length, 1, 'no re-fire while still low');
    engine.record('fps', 60);
    engine.sample();
    engine.record('fps', 20);
    engine.sample();
    assertEquals(seen.length, 2, 're-armed after recovery');
  } finally {
    engine.destroy();
  }
});

test('telemetry: the quality recommendation degrades with measured load', () => {
  const engine = new TelemetryEngine({ samplingRate: 60000, privacyBudget: 0 });
  try {
    engine.record('fps', 60);
    engine.record('heap-used', 0);
    engine.record('interaction-rate', 0);
    assertEquals(engine.getQualityRecommendation().quality, 'high');
    engine.record('fps', 40);
    assertEquals(engine.getQualityRecommendation().quality, 'medium');
    engine.record('fps', 20);
    assertEquals(engine.getQualityRecommendation().quality, 'low');
  } finally {
    engine.destroy();
  }
});

test('telemetry: destroy() stops the sampler so no timer outlives the engine', () => {
  const engine = new TelemetryEngine({ samplingRate: 60000 });
  assert(engine._timers.length >= 1, 'the sampler armed itself');
  engine.destroy();
  assertEquals(engine._timers.length, 0, 'destroy cleared every timer');
});

test('holo: the shimmer class is applied and no runtime <style> node appears', () => {
  const element = document.createElement('h1');
  document.body.appendChild(element);
  createHolographicText(element, { shimmerSpeed: 5 });
  try {
    assert(element.classList.contains('holo-text'), 'class carries the contract');
    assertEquals(document.getElementById('holo-shimmer-keyframes'), null, 'keyframes live in app.css, not a style node');
  } finally {
    element.remove();
  }
}, { needs: 'dom' });

test('holo: a click leaves one ripple, and the ripple cleans itself up', async () => {
  const button = document.createElement('button');
  button.textContent = 'go';
  document.body.appendChild(button);
  createHolographicButton(button, { glow: false, rippleDuration: 20 });
  try {
    button.dispatchEvent(new MouseEvent('click', { clientX: 10, clientY: 10, bubbles: true }));
    assertEquals(button.querySelectorAll('.holo-ripple').length, 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assertEquals(button.querySelectorAll('.holo-ripple').length, 0, 'the ripple removed itself');
  } finally {
    button.remove();
  }
}, { needs: 'dom' });

test('presence: the avatar renderer constructs (or stays inert) without a GPU', () => {
  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  const renderer = new PresenceAvatarRenderer(canvas, {});
  try {
    const added = renderer.addAvatar('peer-render');
    if (renderer.gl) assert(added, 'with a context, the avatar is admitted');
    assertEquals(renderer.getAvatarCount(), renderer.gl ? 1 : 0);
  } finally {
    renderer.destroy();
    canvas.remove();
  }
}, { needs: 'dom' });

test('a11y-ai: a frantic burst loads the model more than a calm one', () => {
  try { localStorage.removeItem('singularity.a11y.ai.profile'); } catch { /* private mode */ }
  const ai = new A11yAI({ enableCognitiveLoad: true });

  const burst = (entries) => {
    ai.cognitiveLoad = 0;
    ai.interactionHistory.length = 0;
    ai.interactionHistory.push(...entries);
    for (let i = 0; i < 30; i += 1) ai._updateCognitiveLoad();
    return ai.getCognitiveLoad();
  };

  const now = performance.now();
  const calm = burst(Array.from({ length: 6 }, (_, i) => ({
    type: 'click', timestamp: now - i * 100, delta: 5000,
  })));
  const frantic = burst(Array.from({ length: 40 }, (_, i) => ({
    type: 'keydown', timestamp: now - i * 10, delta: 5,
  })));

  assert(calm < 0.3, `calm interaction stays below the adaptation threshold (${calm})`);
  assert(frantic > calm, `frantic (${frantic}) must load more than calm (${calm})`);
  assert(frantic <= 1, 'load is bounded');
}, { needs: 'dom' });

test('a11y-ai: reinforcement weights are clamped to [0, 1]', () => {
  const ai = new A11yAI({});
  for (let i = 0; i < 30; i += 1) ai.learnFromInteraction('open-panel', true, { elementType: 'button' });
  const ceiling = ai.getProfile().learnedWeights['open-panel:button'];
  assertEquals(ceiling, 1, 'success cannot push past one');
  for (let i = 0; i < 100; i += 1) ai.learnFromInteraction('open-panel', false, { elementType: 'button' });
  const floor = ai.getProfile().learnedWeights['open-panel:button'];
  assertEquals(floor, 0, 'failure cannot push below zero');
}, { needs: 'dom' });

test('particles: the field builds to spec and stops on request', () => {
  const canvas = document.createElement('canvas');
  canvas.style.width = '64px';
  canvas.style.height = '32px';
  document.body.appendChild(canvas);
  try {
    const field = createDashboardParticles(canvas, { particleCount: 64, layerCount: 2 });
    const stats = field.stats();
    assertEquals(stats.particles, 128, 'particle count times layers');
    assertEquals(stats.layers, 2);
    field.stop();
  } finally {
    canvas.remove();
  }
}, { needs: ['dom', 'webgl2'] });
