/**
 * M3 - glTF skeletal rigs.
 *
 * A skin is a list of joint nodes plus the inverse bind matrix of each joint.
 * The matrix that carries a vertex from bind pose into animated pose is
 *
 *     jointMatrix = world(joint, t) * inverseBind(joint)
 *
 * so this module has exactly three jobs, all deterministic and GL-free:
 *
 *   1. compose each node's local TRS (or static matrix) into a column-major
 *      world matrix, parent before child;
 *   2. evaluate glTF animation channels at a time - LINEAR (lerp, slerp) and
 *      STEP are supported, CUBICSPLINE is refused rather than approximated;
 *   3. multiply each joint's animated world by its inverse bind.
 *
 * Time loops over the clip duration. A rig with no animation still poses its
 * rest transforms, which yields identity joint matrices when the file's inverse
 * bind matrices are correct - useful as a self-check.
 *
 * Normals and tangents are skinned by the linear part of the same matrices in
 * the shader (linear-blend skinning with four influences), not by the inverse
 * transpose; that is exact for the rigid rotations this loader targets and is
 * stated as a limit in the M3 copy.
 *
 * Kept separate from gltf.js so pose maths can be tested without a document,
 * a file or a GPU.
 */
import { multiply } from './math.js';

const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Column-major TRS matrix, following glTF's translation/rotation/scale order. */
export function composeTRS(translation = [0, 0, 0], rotation = [0, 0, 0, 1], scale = [1, 1, 1]) {
  let [x, y, z, w] = rotation;
  const len = Math.hypot(x, y, z, w) || 1;
  x /= len; y /= len; z /= len; w /= len;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = scale;
  const [tx, ty, tz] = translation;
  return new Float32Array([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ]);
}

function slerp(a, b, t) {
  let [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  const al = Math.hypot(ax, ay, az, aw) || 1;
  const bl = Math.hypot(bx, by, bz, bw) || 1;
  ax /= al; ay /= al; az /= al; aw /= al;
  bx /= bl; by /= bl; bz /= bl; bw /= bl;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  // Shortest arc: q and -q are the same rotation, so flip when the
  // dot product would interpolate the long way round.
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    // Nearly parallel: normalised linear interpolation is stable and avoids
    // dividing by a vanishing sin(theta).
    const x = ax + (bx - ax) * t;
    const y = ay + (by - ay) * t;
    const z = az + (bz - az) * t;
    const w = aw + (bw - aw) * t;
    const inv = 1 / (Math.hypot(x, y, z, w) || 1);
    return [x * inv, y * inv, z * inv, w * inv];
  }
  const theta = Math.acos(Math.min(1, dot));
  const sin = Math.sin(theta);
  const wa = Math.sin((1 - t) * theta) / sin;
  const wb = Math.sin(t * theta) / sin;
  return [ax * wa + bx * wb, ay * wa + by * wb, az * wa + bz * wb, aw * wa + bw * wb];
}

/**
 * Sample one channel at `time` (already wrapped into the clip).
 * Values are packed `times.length * components`; returns an array of
 * `components` numbers (rotation channels slerp, everything else lerps).
 */
export function sampleTrack(channel, time) {
  const { times, values, path, interpolation = 'LINEAR' } = channel;
  const components = path === 'rotation' ? 4 : 3;
  const count = times.length;
  if (count === 1 || time <= times[0]) {
    return Array.from(values.subarray(0, components));
  }
  if (time >= times[count - 1]) {
    const start = (count - 1) * components;
    return Array.from(values.subarray(start, start + components));
  }
  // Binary search for the first key strictly after `time`.
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) lo = mid;
    else hi = mid;
  }
  const start = lo * components;
  const end = hi * components;
  if (interpolation === 'STEP') {
    return Array.from(values.subarray(start, start + components));
  }
  const span = times[hi] - times[lo];
  const t = span > 0 ? (time - times[lo]) / span : 0;
  if (path === 'rotation') {
    return slerp(
      values.subarray(start, start + 4),
      values.subarray(end, end + 4),
      t,
    );
  }
  const out = new Array(components);
  for (let i = 0; i < components; i += 1) {
    const a = values[start + i];
    out[i] = a + (values[end + i] - a) * t;
  }
  return out;
}

function validateChannel(channel, nodeCount) {
  if (!channel || !Number.isSafeInteger(channel.node) || channel.node < 0 || channel.node >= nodeCount) {
    throw new Error('glTF skin: animation channel targets an invalid node');
  }
  if (!['translation', 'rotation', 'scale'].includes(channel.path)) {
    throw new Error(`glTF skin: unsupported animation path '${channel.path}'`);
  }
  if (channel.interpolation === 'CUBICSPLINE') {
    throw new Error('glTF skin: CUBICSPLINE animation interpolation is not supported');
  }
  if (channel.interpolation !== undefined && !['LINEAR', 'STEP'].includes(channel.interpolation)) {
    throw new Error(`glTF skin: unknown animation interpolation '${channel.interpolation}'`);
  }
  const { times, values, path } = channel;
  if (!(times instanceof Float32Array) || !(values instanceof Float32Array)) {
    throw new Error('glTF skin: animation input and output must be float accessors');
  }
  if (times.length < 1) throw new Error('glTF skin: animation sampler has no keyframes');
  const components = path === 'rotation' ? 4 : 3;
  if (values.length !== times.length * components) {
    throw new Error(`glTF skin: ${path} output does not match its keyframe count`);
  }
  for (let i = 1; i < times.length; i += 1) {
    if (!(times[i] > times[i - 1])) throw new Error('glTF skin: animation keyframe times must strictly increase');
  }
}

/**
 * Build a reusable rig from parsed glTF nodes, skins and animations.
 *
 * @param {object} input
 * @param {Array<object>} [input.nodes]   raw glTF nodes (TRS, matrix, children)
 * @param {Array<{joints:number[],inverseBindMatrices?:Float32Array}>} [input.skins]
 * @param {Array<{channels:Array<object>}>} [input.animations] parsed channels
 * @returns {{duration:number, jointCounts:number[], pose:(seconds:number)=>Float32Array[]}}
 */
export function buildRig({ nodes = [], skins = [], animations = [] } = {}) {
  const nodeCount = nodes.length;
  const parent = new Array(nodeCount).fill(-1);
  for (let ni = 0; ni < nodeCount; ni += 1) {
    for (const child of nodes[ni].children || []) {
      if (parent[child] !== undefined) parent[child] = ni;
    }
  }
  const order = [];
  const queue = [];
  for (let ni = 0; ni < nodeCount; ni += 1) if (parent[ni] === -1) queue.push(ni);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    order.push(queue[cursor]);
    for (const child of nodes[queue[cursor]].children || []) queue.push(child);
  }
  if (order.length !== nodeCount) throw new Error('glTF skin: node graph is not acyclic');

  const staticLocal = nodes.map((node) => {
    if (node.matrix) {
      if (node.translation || node.rotation || node.scale) {
        throw new Error('glTF skin: a node cannot mix matrix and TRS');
      }
      return new Float32Array(node.matrix);
    }
    return composeTRS(node.translation, node.rotation, node.scale);
  });

  const channels = [];
  let duration = 0;
  for (const animation of animations) {
    for (const channel of animation.channels || []) {
      validateChannel(channel, nodeCount);
      if (nodes[channel.node].matrix) {
        throw new Error('glTF skin: animations cannot target a matrix node');
      }
      channels.push(channel);
      duration = Math.max(duration, channel.times[channel.times.length - 1]);
    }
  }

  for (const skin of skins) {
    if (!Array.isArray(skin.joints) || skin.joints.length === 0) {
      throw new Error('glTF skin: a skin needs at least one joint');
    }
    for (const joint of skin.joints) {
      if (!Number.isSafeInteger(joint) || joint < 0 || joint >= nodeCount) {
        throw new Error('glTF skin: skin joint is not a node');
      }
    }
    if (skin.inverseBindMatrices !== undefined
        && skin.inverseBindMatrices.length !== skin.joints.length * 16) {
      throw new Error('glTF skin: inverse bind matrix count does not match joint count');
    }
  }

  const jointMatrices = skins.map((skin) => skin.joints.map((joint) => {
    const inverse = skin.inverseBindMatrices
      ? new Float32Array(skin.inverseBindMatrices.buffer, skin.inverseBindMatrices.byteOffset + joint * 64, 16)
      : IDENTITY;
    return { joint, inverse };
  }));

  let cachedTime = NaN;
  let cached = null;

  const pose = (seconds) => {
    const time = duration > 0
      ? ((seconds % duration) + duration) % duration
      : 0;
    if (time === cachedTime && cached) return cached;

    // Local TRS per node, then override whatever a channel animates.
    const local = staticLocal.slice();
    if (channels.length) {
      const trs = nodes.map((node) => ({
        t: Array.from(node.translation || [0, 0, 0]),
        r: Array.from(node.rotation || [0, 0, 0, 1]),
        s: Array.from(node.scale || [1, 1, 1]),
        matrix: node.matrix ? new Float32Array(node.matrix) : null,
      }));
      for (const channel of channels) {
        const sampled = sampleTrack(channel, time);
        const target = trs[channel.node];
        if (target.matrix) throw new Error('glTF skin: animations cannot target a matrix node');
        if (channel.path === 'translation') target.t = sampled;
        else if (channel.path === 'rotation') target.r = sampled;
        else target.s = sampled;
      }
      for (let ni = 0; ni < nodeCount; ni += 1) {
        const target = trs[ni];
        local[ni] = target.matrix || composeTRS(target.t, target.r, target.s);
      }
    }

    const world = new Array(nodeCount);
    for (const ni of order) {
      world[ni] = parent[ni] === -1
        ? local[ni]
        : multiply(new Float32Array(16), world[parent[ni]], local[ni]);
    }

    cached = jointMatrices.map((joints) => {
      const out = new Float32Array(joints.length * 16);
      for (let j = 0; j < joints.length; j += 1) {
        if (joints[j].inverse === IDENTITY) {
          out.set(world[joints[j].joint], j * 16);
        } else {
          multiply(out.subarray(j * 16, j * 16 + 16), world[joints[j].joint], joints[j].inverse);
        }
      }
      return out;
    });
    cachedTime = time;
    return cached;
  };

  // Rest pose once, so a file with correct inverse bind matrices can be
  // checked against identity without a renderer.
  return {
    duration,
    jointCounts: skins.map((skin) => skin.joints.length),
    pose,
  };
}
