/**
 * The M3 skeletal rig, proven without a GPU: src/graphics/skin.js turns glTF
 * nodes and animation channels into joint matrices, and the renderer only
 * uploads those matrices. These tests pin the contract the shaders rely on:
 *
 *   - a correct inverse bind matrix cancels the rest world transform
 *   - LINEAR translation reaches the midpoint exactly, STEP holds the last key
 *   - CUBICSPLINE evaluates the glTF Hermite (span-scaled tangents) and
 *     normalises interpolated rotations
 *   - morph weight tracks sample LINEAR/STEP/CUBICSPLINE and validate against
 *     the target count
 *   - quaternion channels slerp the shortest arc, not the long way round
 *   - a parent's rotation reaches its child's joint matrix
 *   - time loops over the clip duration
 *   - the unsupported parts of the spec (unknown interpolation, non-monotonic
 *     time) are refused instead of approximated
 */
import { test, assert, assertEquals } from './harness.js';
import { buildRig, composeTRS, sampleTrack, sampleWeightTrack, validateWeightTrack } from '../src/graphics/skin.js';
import { transformPoint } from '../src/graphics/math.js';

const near = (a, b, eps, msg) => assert(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

const translation = (m) => [m[12], m[13], m[14]];

function identityMatrix() {
  return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

test('skin: correct inverse bind matrices yield identity joint matrices at rest', () => {
  const rig = buildRig({
    nodes: [
      { translation: [0, 0, 0], children: [1] },
      { translation: [0, 2, 0] },
    ],
    skins: [{
      joints: [0, 1],
      // Inverse of translate(0, 0, 0) and translate(0, 2, 0), column-major.
      inverseBindMatrices: new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -2, 0, 1,
      ]),
    }],
    animations: [],
  });
  const poses = rig.pose(0);
  assertEquals(poses.length, 1);
  const expected = identityMatrix();
  for (let j = 0; j < 2; j += 1) {
    const m = poses[0].subarray(j * 16, j * 16 + 16);
    for (let i = 0; i < 16; i += 1) near(m[i], expected[i], 1e-6, `joint ${j} element ${i}`);
  }
});

test('skin: a LINEAR translation channel reaches its exact midpoint', () => {
  const rig = buildRig({
    nodes: [{ translation: [0, 0, 0] }],
    skins: [{ joints: [0] }],
    animations: [{
      channels: [{
        node: 0,
        path: 'translation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 0, 4, 0]),
      }],
    }],
  });
  assertEquals(rig.duration, 1);
  const t = translation(rig.pose(0.5)[0]);
  near(t[0], 0, 1e-6, 'mid x');
  near(t[1], 2, 1e-6, 'mid y');
  near(t[2], 0, 1e-6, 'mid z');
});

test('skin: a quaternion channel slerps the shortest arc', () => {
  const rig = buildRig({
    nodes: [{ rotation: [0, 0, 0, 1] }],
    skins: [{ joints: [0] }],
    animations: [{
      channels: [{
        node: 0,
        path: 'rotation',
        times: new Float32Array([0, 1]),
        // Identity to (0, 1, 0, 0) is a half turn about Y, so halfway must be
        // 90 degrees, not the collapsed zero rotation linear interpolation
        // would produce.
        values: new Float32Array([0, 0, 0, 1, 0, 1, 0, 0]),
      }],
    }],
  });
  const point = transformPoint(rig.pose(0.5)[0], [1, 0, 0]);
  near(point[0], 0, 1e-6, 'x after 90 degrees about Y');
  near(point[1], 0, 1e-6, 'y after 90 degrees about Y');
  near(point[2], -1, 1e-6, 'z after 90 degrees about Y');
});

test('skin: a parent rotation reaches the child joint matrix', () => {
  const rig = buildRig({
    nodes: [
      { rotation: [0, 0, 0, 1], children: [1] },
      { translation: [0, 1, 0] },
    ],
    skins: [{ joints: [1] }],
    animations: [{
      channels: [{
        node: 0,
        path: 'rotation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 1, 0, 0, 1, 0]),
      }],
    }],
  });
  // Half a second into a 180 degree turn is a quarter turn; looping the clip
  // would make pose(1) identical to pose(0) and prove the wrong thing. With an
  // identity inverse bind, the joint matrix is world(joint): the joint's own
  // origin sits at (0,1,0) and must follow the parent to (-1,0,0).
  const point = transformPoint(rig.pose(0.5)[0], [0, 0, 0]);
  near(point[0], -1, 1e-5, 'child x after a 90 degree parent rotation about Z');
  near(point[1], 0, 1e-5, 'child y after a 90 degree parent rotation about Z');
  near(point[2], 0, 1e-5, 'child z after a 90 degree parent rotation about Z');
});

test('skin: time loops over the clip duration and STEP holds the previous key', () => {
  const keyframes = {
    node: 0,
    path: 'translation',
    times: new Float32Array([0, 1, 2]),
    values: new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]),
  };
  const rig = buildRig({
    nodes: [{ translation: [0, 0, 0] }],
    skins: [{ joints: [0] }],
    animations: [{ channels: [keyframes] }],
  });
  near(translation(rig.pose(0.5)[0])[1], 0.5, 1e-6, 'halfway');
  near(translation(rig.pose(2.5)[0])[1], 0.5, 1e-6, 'loop wraps 2.5 to 0.5');

  const stepped = sampleTrack({ ...keyframes, interpolation: 'STEP' }, 0.75);
  near(stepped[1], 0, 1e-6, 'STEP holds the key at 0');
  const held = sampleTrack({ ...keyframes, interpolation: 'STEP' }, 1.5);
  near(held[1], 1, 1e-6, 'STEP holds the key at 1');
});

test('skin: pose is cached for an identical time and differs for another', () => {
  const rig = buildRig({
    nodes: [{ translation: [0, 0, 0] }],
    skins: [{ joints: [0] }],
    animations: [{
      channels: [{
        node: 0,
        path: 'translation',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 3, 0, 0]),
      }],
    }],
  });
  const a = rig.pose(0.25)[0];
  const b = rig.pose(0.25)[0];
  assert(a === b, 'same time returns the same cached array');
  const c = rig.pose(0.75)[0];
  near(translation(a)[0], 0.75, 1e-6, 'first pose');
  near(translation(c)[0], 2.25, 1e-6, 'second pose');
});

test('skin: composeTRS normalises rotation and applies scale before translation', () => {
  const m = composeTRS([2, 3, 4], [0, 0, 0, 2], [2, 2, 2]);
  const point = transformPoint(m, [1, 0, 0]);
  near(point[0], 4, 1e-6, 'scaled x plus translation');
  near(point[1], 3, 1e-6, 'y translation');
  near(point[2], 4, 1e-6, 'z translation');
});

test('skin: CUBICSPLINE applies the glTF Hermite with span-scaled tangents', () => {
  // Two translation keys; each key is [inTangent, value, outTangent]. At
  // t = 0.25 the Hermite basis gives 0.84375*p0 + 0.140625*span*m0 +
  // 0.15625*p1 - 0.046875*span*m1. With p0 = 0, p1 = 4, m0 = m1 = 2 and
  // span = 1 that is 0.8125, while LINEAR would say 1.0.
  const cubic = {
    node: 0,
    path: 'translation',
    interpolation: 'CUBICSPLINE',
    times: new Float32Array([0, 1]),
    values: new Float32Array([
      0, 0, 0,   0, 0, 0,   2, 0, 0,
      2, 0, 0,   4, 0, 0,   0, 0, 0,
    ]),
  };
  const rig = buildRig({
    nodes: [{ translation: [0, 0, 0] }],
    skins: [{ joints: [0] }],
    animations: [{ channels: [cubic] }],
  });
  assertEquals(rig.duration, 1);
  near(translation(rig.pose(0.25)[0])[0], 0.8125, 1e-6, 'quarter key Hermite value');
  near(translation(rig.pose(0.5)[0])[0], 2, 1e-6, 'midpoint with symmetric tangents');
  near(translation(rig.pose(0)[0])[0], 0, 1e-6, 'first key returns its value, not its tangent');
  near(sampleTrack(cubic, 1)[0], 4, 1e-6, 'last key returns its value');
  // A duplicated call at the same time must hit the pose cache, not resample.
  assert(rig.pose(0.25)[0] === rig.pose(0.25)[0], 'cubic pose is cached per time');
});

test('skin: CUBICSPLINE normalises interpolated rotations', () => {
  const channel = {
    path: 'rotation',
    interpolation: 'CUBICSPLINE',
    times: new Float32Array([0, 1]),
    // Tangents and values chosen so the component-wise Hermite at t = 0.5 is
    // (0, 0, 0.5, 1.5): length sqrt(2.5), so the result must be renormalised.
    values: new Float32Array([
      0, 0, 0, 0,   0, 0, 0, 1,   0, 0, 0, 0,
      0, 0, 0, 0,   0, 0, 1, 2,   0, 0, 0, 0,
    ]),
  };
  const q = sampleTrack(channel, 0.5);
  near(Math.hypot(...q), 1, 1e-6, 'normalised quaternion');
  near(q[2], 0.5 / Math.sqrt(2.5), 1e-6, 'direction preserved: z');
  near(q[3], 1.5 / Math.sqrt(2.5), 1e-6, 'direction preserved: w');
});

test('skin: morph weight tracks support LINEAR, STEP and CUBICSPLINE', () => {
  const linear = {
    times: new Float32Array([0, 1]),
    values: new Float32Array([0, 1, 1, 0]),
  };
  const a = sampleWeightTrack(linear, 2, 0.25);
  near(a[0], 0.25, 1e-6, 'linear target 0');
  near(a[1], 0.75, 1e-6, 'linear target 1');

  const stepped = { ...linear, interpolation: 'STEP' };
  near(sampleWeightTrack(stepped, 2, 0.75)[0], 0, 1e-6, 'STEP holds key 0');
  near(sampleWeightTrack(stepped, 2, 1)[0], 1, 1e-6, 'STEP advances at key 1');

  const cubic = {
    times: new Float32Array([0, 1]),
    interpolation: 'CUBICSPLINE',
    // One target, two keys, each [inTangent, value, outTangent].
    values: new Float32Array([0, 0, 2, 2, 4, 0]),
  };
  near(sampleWeightTrack(cubic, 1, 0.25)[0], 0.8125, 1e-6, 'cubic target 0 at a quarter');
  near(sampleWeightTrack(cubic, 1, 0)[0], 0, 1e-6, 'cubic first key value');
  near(sampleWeightTrack(cubic, 1, 1)[0], 4, 1e-6, 'cubic last key value');

  validateWeightTrack(linear, 2);
  validateWeightTrack(cubic, 1);
  let message = '';
  try { validateWeightTrack(linear, 3); } catch (error) { message = error.message; }
  assert(/target and keyframe counts/.test(message), `wrong target count should be named: ${message}`);
  message = '';
  try { validateWeightTrack({ ...linear, times: new Float32Array([1, 0]) }, 2); } catch (error) { message = error.message; }
  assert(/strictly increase/.test(message), `backwards keys should be named: ${message}`);
  message = '';
  try { validateWeightTrack(linear, 0); } catch (error) { message = error.message; }
  assert(/at least one target/.test(message), `zero targets should be named: ${message}`);
});

test('skin: unsupported or malformed rigs are refused, not approximated', () => {
  const base = {
    nodes: [{ translation: [0, 0, 0] }],
    skins: [{ joints: [0] }],
  };
  const unknown = () => buildRig({
    ...base,
    animations: [{
      channels: [{
        node: 0, path: 'translation', interpolation: 'QUADRATIC',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 1, 0, 0]),
      }],
    }],
  });
  let message = '';
  try { unknown(); } catch (error) { message = error.message; }
  assert(/QUADRATIC/.test(message), `unknown interpolation should be named: ${message}`);

  const shortCubic = () => buildRig({
    ...base,
    animations: [{
      channels: [{
        node: 0, path: 'translation', interpolation: 'CUBICSPLINE',
        times: new Float32Array([0, 1]),
        values: new Float32Array([0, 0, 0, 1, 0, 0]),
      }],
    }],
  });
  message = '';
  try { shortCubic(); } catch (error) { message = error.message; }
  assert(/keyframe count/.test(message), `short cubic output should be named: ${message}`);

  const backwards = () => buildRig({
    ...base,
    animations: [{
      channels: [{
        node: 0, path: 'translation',
        times: new Float32Array([1, 0]),
        values: new Float32Array([0, 0, 0, 1, 0, 0]),
      }],
    }],
  });
  message = '';
  try { backwards(); } catch (error) { message = error.message; }
  assert(/strictly increase/.test(message), `backwards keys should be named: ${message}`);

  message = '';
  try { buildRig({ ...base, skins: [{ joints: [5] }] }); } catch (error) { message = error.message; }
  assert(/joint is not a node/.test(message), `bad joint should be named: ${message}`);

  message = '';
  try {
    buildRig({ nodes: [{ matrix: identityMatrix(), translation: [0, 1, 0] }], skins: [] });
  } catch (error) { message = error.message; }
  assert(/matrix and TRS/.test(message), `mixed transform should be named: ${message}`);

  message = '';
  try {
    buildRig({
      nodes: [{ matrix: identityMatrix() }],
      skins: [{ joints: [0] }],
      animations: [{
        channels: [{
          node: 0, path: 'translation',
          times: new Float32Array([0]),
          values: new Float32Array([0, 0, 0]),
        }],
      }],
    });
  } catch (error) { message = error.message; }
  assert(/matrix node/.test(message), `matrix node animation should be named: ${message}`);
});
