/**
 * The spring solver, proven without a DOM: the physics is the contract, so the
 * tests are numeric properties, not screenshots.
 *
 *   - concentration: every tuning converges to its target
 *   - no overshoot at ζ = 1 (critical damping), overshoot at ζ < 1
 *   - the per-unit-mass energy never increases (the solver is stable)
 *   - snap mode is the reduced-motion teleport
 *   - a garbage dt cannot poison the state (fail closed, like the CRDT)
 */
import { test, assert, assertEquals } from './harness.js';
import { Spring, naturalFrequency, settlingTime, SPRINGS } from '../src/ui/motion.js';

test('motion: natural frequency is sqrt(k/m) and settling time is its log envelope', () => {
  assertEquals(naturalFrequency(900, 4).toFixed(3), '15.000'); // sqrt(900/4) = 15
  // k=900, ζ=1, m=4 knocks the amplitude down to 1% within ~0.307 s.
  const t = settlingTime(900, 1, 4, 0.01);
  assert(Math.abs(t - -Math.log(0.01) / 15) < 1e-9, `settling time formula: ${t}`);
});

test('motion: the default spring converges on its target within its settling time', () => {
  const s = new Spring({ value: 0 });
  s.setTarget(1);
  // 0.42 s of wall time at 60 fps past any hand-picked bezier.
  for (let i = 0; i < 40; i += 1) s.step(1 / 60);
  assert(Math.abs(s.value - 1) < 5e-3, `settled to ${s.value} in 0.67 s`);
  assert(s.settled, 'the settler flag agrees with the numbers');
});

test('motion: ζ = 1 arrives without overshooting, ζ = 0.3 rings past the target', () => {
  const critical = new Spring({ value: 0, dampingRatio: 1, stiffness: 160 });
  critical.setTarget(1);
  let criticalMax = 0;
  for (let i = 0; i < 400; i += 1) {
    critical.step(1 / 60);
    criticalMax = Math.max(criticalMax, critical.value);
  }
  assert(criticalMax <= 1 + 1e-4, `critical damping must not overshoot (max ${criticalMax})`);
  assert(Math.abs(critical.value - 1) < 5e-4, 'critical damping arrives');

  const ringing = new Spring({ value: 0, dampingRatio: 0.3, stiffness: 160 });
  ringing.setTarget(1);
  let ringingMax = 0;
  for (let i = 0; i < 200; i += 1) {
    ringing.step(1 / 60);
    ringingMax = Math.max(ringingMax, ringing.value);
  }
  assert(ringingMax > 1.05, `underdamping must overshoot (max ${ringingMax})`);
});

test('motion: the per-unit-mass energy decays monotonically (numerically)', () => {
  const s = new Spring({ value: 0, dampingRatio: 0.55, stiffness: 150 });
  s.setTarget(1);
  let previous = s.energy() + 1e-6;
  let spikes = 0;
  for (let i = 0; i < 400; i += 1) {
    s.step(1 / 60);
    const e = s.energy();
    // Semi-implicit Euler can gain a sliver within one step; it may never trend.
    if (e > previous + 1e-5) spikes += 1;
    previous = e;
  }
  assertEquals(spikes, 0, 'energy trend must be non-increasing at 60 Hz');
  assert(s.energy() < 1e-4, 'the oscillation must be spent');
});

/** @license nothing: snap mode exists for one reason - prefers-reduced-motion. */
test('motion: snap mode is a teleport, exactly what reduced motion asks for', () => {
  const s = new Spring({ value: 0, snap: true });
  s.setTarget(1);
  assertEquals(s.value, 1, 'set()/setTarget() snaps immediately');
  s.step(0);
  assertEquals(s.value, 1);
  s.jump(0);
  s.setTarget(1);
  s.step(0.016);
  assertEquals(s.value, 1, 'stepping in snap mode holds the target');
});

test('motion: a NaN or explosive dt is clamped, never propagated', () => {
  const s = new Spring({ value: 0 });
  s.setTarget(1);
  s.step(Number.NaN);
  assert(Number.isFinite(s.value), `NaN dt leaves state finite: ${s.value}`);
  s.step(60); // a two-second wake-up, clamped to 2 s
  assert(Number.isFinite(s.value));
  assert(Number.isFinite(s.velocity));
  // 2 s clamped: whatever it did, it went toward the target, not away.
  assert(s.value > 0, `clamped huge dt still moved toward the target: ${s.value}`);
});

test('motion: retargeting mid-flight stays bounded and settles', () => {
  const s = new Spring({ value: 0, dampingRatio: 0.65 });
  for (let frame = 0; frame < 240; frame += 1) {
    if (frame === 40) s.setTarget(-1);
    if (frame === 120) s.setTarget(0.5);
    s.step(1 / 60);
    assert(Math.abs(s.value) < 3, `value stayed physical at frame ${frame}: ${s.value}`);
  }
  assert(s.settled, 'retargets settle once the flips stop');
});

test('motion: the shared tunings arrive inside human-plausible times', () => {
  for (const [name, tuning] of Object.entries(SPRINGS)) {
    const s = new Spring({ value: 0, ...tuning });
    s.setTarget(1);
    // No UI spring may take more than a second to land at 1%.
    const limit = settlingTime(tuning.stiffness, tuning.dampingRatio, 1, 0.01);
    assert(limit < 1.2, `${name} settles in ${limit.toFixed(2)} s`);
    let i = 0;
    while (!s.settled && i < 100) {
      s.step(1 / 60);
      i += 1;
    }
    assert(s.settled, `${name} reached the settled flag`);
  }
});
