/**
 * Motion as physics.
 *
 * Every animation curve in this codebase used to be a hand-picked
 * cubic-bezier; this module replaces the idea of a curve with the thing the
 * curves were imitating: a damped harmonic oscillator, integrated in real
 * time. One physical object moves the interface and its properties are
 * measurable, not aesthetic opinions:
 *
 *     x''(t) = -ω² (x - g) - 2 ζ ω x'(t)
 *
 * with ω = √(k/m) and ζ the damping ratio. ζ < 1 underdamped (overshoots
 * once), ζ = 1 critically damped (fastest arrival with no overshoot), ζ > 1
 * overdamped (sluggish). Semi-implicit Euler keeps the integrator stable and
 * is the same scheme the M3 particle field uses, so the whole page shares one
 * numerical habit.
 *
 * Reduced motion is a *physical* mode here, not a policy layer: `snap` makes
 * the spring critically overdamped to the point of teleporting - ζ → ∞ is the
 * limit where the mass is always glued to its target, which is exactly the
 * UI behaviour a reduced-motion user asked for. Nothing in this file touches
 * the DOM, so it is unit-tested without a browser (tests/motion.test.js).
 */

/** ω = √(k/m): the natural frequency the oscillator rings at, in rad/s. */
export function naturalFrequency(stiffness, mass) {
  return Math.sqrt(stiffness / mass);
}

/**
 * Settling time of the envelope exp(-ζωt): the time for the transient
 * amplitude to decay to `tolerance` of its start. This is what a designer
 * actually means by "how long does this settle", and exposing it means the
 * tests can prove the springs arrive within the durations the CSS used.
 */
export function settlingTime(stiffness, dampingRatio, mass = 1, tolerance = 0.01) {
  const omega = naturalFrequency(stiffness, mass);
  if (dampingRatio <= 0) return Infinity;
  return -Math.log(tolerance) / (dampingRatio * omega);
}

export class Spring {
  /**
   * @param {number} options.value          initial position
   * @param {number} options.stiffness      k, N/m-scale; higher = snappier
   * @param {number} options.dampingRatio   ζ; <1 overshoots, =1 critical
   * @param {number} options.mass           m
   * @param {boolean} options.snap          reduced-motion teleport mode
   * @param {number} options.settleEps      |x-g| at which the motion counts as done
   * @param {number} options.velocityEps    |v| at which it counts as done
   */
  constructor({
    value = 0,
    target = value,
    stiffness = 170,
    dampingRatio = 0.9,
    mass = 1,
    snap = false,
    settleEps = 1e-3,
    velocityEps = 1e-2,
  } = {}) {
    if (!(stiffness > 0)) throw new Error('spring stiffness must be > 0');
    if (!(mass > 0)) throw new Error('spring mass must be > 0');
    if (!(dampingRatio > 0)) throw new Error('spring dampingRatio must be > 0');
    this.stiffness = stiffness;
    this.dampingRatio = dampingRatio;
    this.mass = mass;
    this.snap = Boolean(snap);
    this.settleEps = settleEps;
    this.velocityEps = velocityEps;
    this.value = value;
    this.velocity = 0;
    this.target = target;
  }

  /** Teleport (also the reduced-motion path): position only, velocity zeroed. */
  jump(value) {
    this.value = value;
    this.velocity = 0;
  }

  setTarget(target) {
    if (!Number.isFinite(target)) return;
    if (this.snap) {
      this.target = target;
      this.jump(target);
      return;
    }
    this.target = target;
  }

  /** Per-unit-mass energy of the oscillator - the number that must decay. */
  energy() {
    const omega = naturalFrequency(this.stiffness, this.mass);
    const displacement = this.value - this.target;
    return 0.5 * this.velocity * this.velocity + 0.5 * omega * omega * displacement * displacement;
  }

  get settled() {
    return Math.abs(this.value - this.target) <= this.settleEps && Math.abs(this.velocity) <= this.velocityEps;
  }

  /**
   * Advance by `dt` seconds. Semi-implicit Euler with substepping: dt is split
   * into chunks no longer than 8 ms (the stability limit for the fastest spring
   * used here) and clamped to 2 s so a backgrounded tab that wakes up cannot
   * inject a runaway delta.
   */
  step(dt) {
    const t = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 2)) : 0;
    if (this.snap) {
      this.jump(this.target);
      return this.settled;
    }
    if (t === 0) return this.settled;
    const steps = Math.min(64, Math.max(1, Math.ceil(t / 0.008)));
    const h = t / steps;
    const omega = naturalFrequency(this.stiffness, this.mass);
    for (let i = 0; i < steps; i += 1) {
      const displacement = this.value - this.target;
      // v += a dt, then x += v dt: semi-implicit (symplectic Euler)
      const acceleration = -omega * omega * displacement - 2 * this.dampingRatio * omega * this.velocity;
      this.velocity += acceleration * h;
      this.value += this.velocity * h;
    }
    if (!Number.isFinite(this.value)) {
      // A NaN here would poison every animation downstream; fail closed to the
      // target instead, the same way the CRDT fails closed on damaged logs.
      this.jump(this.target);
      return true;
    }
    return this.settled;
  }
}

/**
 * Three shared tunings, named for what they are for rather than how they feel.
 * `soft` powers the substrate's telemetry smoothing, `tab` the module dolly,
 * `dial` the radar blips.
 */
export const SPRINGS = {
  soft: { stiffness: 90, dampingRatio: 1 },
  tab: { stiffness: 210, dampingRatio: 1 },
  dial: { stiffness: 140, dampingRatio: 0.82 },
};

/**
 * Build a set of springs in one snap-or-move policy.
 * @param {string[]} names
 * @param {{snap?: boolean, [k: string]: object}} config - per-name overrides
 */
export function springs(names, config = {}) {
  const out = {};
  for (const name of names) {
    const tuning = { ...SPRINGS[name], ...(config[name] || {}) };
    out[name] = new Spring({ snap: Boolean(config.snap), ...tuning });
  }
  return out;
}
