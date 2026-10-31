#!/usr/bin/env node
/**
 * Generate assets/models/skinned-totem.glb - the M3 skeletal-animation sample.
 *
 * A twisted, seven-joint alloy standard stands beside the core. The mesh is a
 * single indexed ribbon: 13 rings x 8 sides plus a cap, each vertex blended
 * between the two joint levels nearest its height. A six-second looping clip
 * rotates alternating joints about X and Z, so the totem bends in two axes.
 *
 * The mesh also carries two morph targets - a radial pulse and a slow twist,
 * each with matching normal deltas - mixed by a CUBICSPLINE weights track. The
 * loader, rig sampler and renderer therefore exercise morph deltas, animated
 * weights and cubic interpolation alongside the skeletal clip.
 *
 * Everything is deterministic: fixed phases, fixed amplitudes, keys every
 * 0.25 s. Running this file twice writes the same bytes, which is why the
 * generated asset can be committed rather than built in the browser.
 *
 *   node tools/make-skinned-glb.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'assets/models/skinned-totem.glb');

const TAU = Math.PI * 2;
const JOINTS = 7;
const RINGS = 13;
const SIDES = 8;
const DURATION = 6;
const KEYS = 25;
const ORIGIN = [7.5, 0, -2.5];

// ---------------------------------------------------------------- geometry
const positions = [];
const normals = [];
const jointIndices = [];
const jointWeights = [];
const indices = [];

const radiusAt = (h) => 0.5 + 0.16 * Math.sin(h * 2.1) + 0.06 * Math.cos(h * 3.7);
const slopeAt = (h) => 0.16 * 2.1 * Math.cos(h * 2.1) - 0.06 * 3.7 * Math.sin(h * 3.7);

for (let r = 0; r < RINGS; r += 1) {
  const h = r * 0.5;
  const radius = radiusAt(h);
  const slope = slopeAt(h);
  for (let s = 0; s < SIDES; s += 1) {
    const angle = (s / SIDES) * TAU + h * 0.55;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    positions.push(ORIGIN[0] + cos * radius, h, ORIGIN[2] + sin * radius);
    const n = Math.hypot(cos, slope, sin) || 1;
    normals.push(cos / n, -slope / n, sin / n);

    // Height h lies between joints floor(h) and floor(h)+1; the top ring sits
    // exactly on the last joint.
    const lower = Math.min(JOINTS - 1, Math.floor(h));
    const upper = Math.min(JOINTS - 1, lower + 1);
    const frac = h - lower;
    jointIndices.push(lower, upper, 0, 0);
    if (upper === lower || frac === 0) jointWeights.push(1, 0, 0, 0);
    else jointWeights.push(1 - frac, frac, 0, 0);
  }
}

for (let r = 0; r < RINGS - 1; r += 1) {
  for (let s = 0; s < SIDES; s += 1) {
    const next = (s + 1) % SIDES;
    const a = r * SIDES + s;
    const b = r * SIDES + next;
    const c = (r + 1) * SIDES + s;
    const d = (r + 1) * SIDES + next;
    indices.push(a, c, b, b, c, d);
  }
}

// Top cap: centre on the last joint, fanned to the top ring.
const centre = positions.length / 3;
positions.push(ORIGIN[0], 6.02, ORIGIN[2]);
normals.push(0, 1, 0);
jointIndices.push(JOINTS - 1, 0, 0, 0);
jointWeights.push(1, 0, 0, 0);
for (let s = 0; s < SIDES; s += 1) {
  const next = (s + 1) % SIDES;
  const a = (RINGS - 1) * SIDES + s;
  const b = (RINGS - 1) * SIDES + next;
  indices.push(b, a, centre);
}

// ---------------------------------------------------------------- morph targets
// Both targets peak at mid-height: a radial pulse driven by r + 0.16 sin(pi y /
// DURATION), and a twist of 0.10 rad about Y. Deltas are per vertex; normal
// deltas follow the analytic surface normal so shading tracks the deformation.
const pulsePosition = new Float32Array(positions.length);
const pulseNormal = new Float32Array(normals.length);
const twistPosition = new Float32Array(positions.length);
const twistNormal = new Float32Array(normals.length);

for (let v = 0; v < positions.length / 3; v += 1) {
  const at = v * 3;
  const x = positions[at] - ORIGIN[0];
  const y = positions[at + 1];
  const z = positions[at + 2] - ORIGIN[2];
  const radius = Math.hypot(x, z);
  const bell = Math.sin((Math.PI * y) / DURATION);
  const bellSlope = (Math.PI * Math.cos((Math.PI * y) / DURATION)) / DURATION;

  if (radius > 1e-6) {
    const cos = x / radius;
    const sin = z / radius;
    const bulge = 0.16 * bell;
    const bulgeSlope = 0.16 * bellSlope;
    pulsePosition[at] = cos * bulge;
    pulsePosition[at + 2] = sin * bulge;
    // Surface of revolution: N ~ (cos, -r'(y), sin), normalised before and
    // after the pulse, so the delta is the shading change the bulge implies.
    const baseSlope = slopeAt(y);
    const baseLength = Math.hypot(cos, baseSlope, sin);
    const nextLength = Math.hypot(cos, baseSlope + bulgeSlope, sin);
    pulseNormal[at] = cos / nextLength - cos / baseLength;
    pulseNormal[at + 1] = -(baseSlope + bulgeSlope) / nextLength + baseSlope / baseLength;
    pulseNormal[at + 2] = sin / nextLength - sin / baseLength;
  }

  const twist = 0.10 * bell;
  const cosTwist = Math.cos(twist);
  const sinTwist = Math.sin(twist);
  twistPosition[at] = x * cosTwist + z * sinTwist - x;
  twistPosition[at + 2] = -x * sinTwist + z * cosTwist - z;
  const nx = normals[at];
  const nz = normals[at + 2];
  twistNormal[at] = nx * cosTwist + nz * sinTwist - nx;
  twistNormal[at + 2] = -nx * sinTwist + nz * cosTwist - nz;
}

// ---------------------------------------------------------------- animation
const times = new Float32Array(KEYS);
for (let k = 0; k < KEYS; k += 1) times[k] = (k * DURATION) / (KEYS - 1);

const AMPLITUDES = [0.08, 0.13, 0.15, 0.17, 0.19, 0.21, 0.23];
const PHASES = [0.5, 0.0, 1.1, 2.2, 3.1, 4.0, 4.8];
const rotations = AMPLITUDES.map((amplitude, joint) => {
  const values = new Float32Array(KEYS * 4);
  for (let k = 0; k < KEYS; k += 1) {
    const angle = amplitude * Math.sin((TAU * times[k]) / DURATION + PHASES[joint]);
    const half = Math.sin(angle / 2);
    const cos = Math.cos(angle / 2);
    // Alternate the bend axis so the chain sways in two directions.
    if (joint % 2 === 0) {
      values.set([half, 0, 0, cos], k * 4);
    } else {
      values.set([0, 0, half, cos], k * 4);
    }
  }
  return values;
});

// CUBICSPLINE weights track: target 0 swings 0..1, target 1 is its complement.
// Each key packs in-tangents, values and out-tangents, two targets each, as the
// glTF cubic-spline layout requires. The analytic derivative keeps the curve
// smooth through every key.
const morphWeightValues = new Float32Array(KEYS * 2 * 3);
for (let k = 0; k < KEYS; k += 1) {
  const angle = (TAU * times[k]) / DURATION;
  const swing = Math.sin(angle);
  const rate = (0.5 * TAU * Math.cos(angle)) / DURATION;
  morphWeightValues.set([rate, -rate, 0.5 + 0.5 * swing, 0.5 - 0.5 * swing, rate, -rate], k * 6);
}

// ---------------------------------------------------------------- binary
const chunks = [];
const views = [];
let byteLength = 0;
const addView = (typed) => {
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const pad = (4 - (byteLength % 4)) % 4;
  if (pad) {
    chunks.push(new Uint8Array(pad));
    byteLength += pad;
  }
  const view = { buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength };
  views.push(view);
  chunks.push(bytes);
  byteLength += bytes.byteLength;
  return views.length - 1;
};

const positionArray = new Float32Array(positions);
const normalArray = new Float32Array(normals);
const jointArray = new Uint16Array(jointIndices);
const weightArray = new Float32Array(jointWeights);
const indexArray = new Uint16Array(indices);

const positionView = addView(positionArray);
const normalView = addView(normalArray);
const jointView = addView(jointArray);
const weightView = addView(weightArray);
const indexView = addView(indexArray);
const pulsePositionView = addView(pulsePosition);
const pulseNormalView = addView(pulseNormal);
const twistPositionView = addView(twistPosition);
const twistNormalView = addView(twistNormal);
const morphWeightView = addView(morphWeightValues);

// Inverse bind matrices: joints sit at ORIGIN + (0, j, 0) at rest, so the
// inverse is a pure translation.
const inverseBind = new Float32Array(JOINTS * 16);
for (let j = 0; j < JOINTS; j += 1) {
  inverseBind.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -ORIGIN[0], -j, -ORIGIN[2], 1], j * 16);
}
const inverseBindView = addView(inverseBind);
const timeView = addView(times);
const rotationViews = rotations.map((values) => addView(values));

const accessors = [];
const accessor = (view, type, count, componentType, extra = {}) => {
  accessors.push({ bufferView: view, byteOffset: 0, componentType, type, count, ...extra });
  return accessors.length - 1;
};

const positionAccessor = accessor(positionView, 'VEC3', positionArray.length / 3, 5126, {
  min: [Math.min(...positions.filter((_, i) => i % 3 === 0)),
    Math.min(...positions.filter((_, i) => i % 3 === 1)),
    Math.min(...positions.filter((_, i) => i % 3 === 2))],
  max: [Math.max(...positions.filter((_, i) => i % 3 === 0)),
    Math.max(...positions.filter((_, i) => i % 3 === 1)),
    Math.max(...positions.filter((_, i) => i % 3 === 2))],
});
const normalAccessor = accessor(normalView, 'VEC3', normalArray.length / 3, 5126);
const jointAccessor = accessor(jointView, 'VEC4', jointArray.length / 4, 5123);
const weightAccessor = accessor(weightView, 'VEC4', weightArray.length / 4, 5126);
const indexAccessor = accessor(indexView, 'SCALAR', indexArray.length, 5123);
const extent = (array) => {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < array.length; i += 3) {
    for (let c = 0; c < 3; c += 1) {
      if (array[i + c] < min[c]) min[c] = array[i + c];
      if (array[i + c] > max[c]) max[c] = array[i + c];
    }
  }
  return { min, max };
};
const pulsePositionAccessor = accessor(pulsePositionView, 'VEC3', pulsePosition.length / 3, 5126, extent(pulsePosition));
const pulseNormalAccessor = accessor(pulseNormalView, 'VEC3', pulseNormal.length / 3, 5126);
const twistPositionAccessor = accessor(twistPositionView, 'VEC3', twistPosition.length / 3, 5126, extent(twistPosition));
const twistNormalAccessor = accessor(twistNormalView, 'VEC3', twistNormal.length / 3, 5126);
const morphWeightAccessor = accessor(morphWeightView, 'SCALAR', morphWeightValues.length, 5126);
const inverseBindAccessor = accessor(inverseBindView, 'MAT4', JOINTS, 5126);
const timeAccessor = accessor(timeView, 'SCALAR', KEYS, 5126);
const rotationAccessors = rotationViews.map((view) => accessor(view, 'VEC4', KEYS, 5126));

const nodes = [
  { name: 'totem-base', translation: ORIGIN, children: [1] },
  ...Array.from({ length: JOINTS - 1 }, (_, i) => ({
    name: `totem-joint-${i + 1}`,
    translation: [0, 1, 0],
    ...(i < JOINTS - 2 ? { children: [i + 2] } : {}),
  })),
  { name: 'totem', mesh: 0, skin: 0, weights: [0.5, 0.5] },
];

const gltf = {
  asset: { version: '2.0', generator: 'tools/make-skinned-glb.mjs' },
  scene: 0,
  scenes: [{ nodes: [0, JOINTS] }],
  nodes,
  meshes: [{
    name: 'totem-mesh',
    primitives: [{
      attributes: {
        POSITION: positionAccessor,
        NORMAL: normalAccessor,
        JOINTS_0: jointAccessor,
        WEIGHTS_0: weightAccessor,
      },
      indices: indexAccessor,
      material: 0,
      mode: 4,
      targets: [
        { POSITION: pulsePositionAccessor, NORMAL: pulseNormalAccessor },
        { POSITION: twistPositionAccessor, NORMAL: twistNormalAccessor },
      ],
    }],
  }],
  skins: [{ joints: Array.from({ length: JOINTS }, (_, i) => i), inverseBindMatrices: inverseBindAccessor, skeleton: 0 }],
  animations: [{
    name: 'totem-sway',
    samplers: [
      ...rotations.map((_, j) => ({
        input: timeAccessor,
        output: rotationAccessors[j],
        interpolation: 'LINEAR',
      })),
      { input: timeAccessor, output: morphWeightAccessor, interpolation: 'CUBICSPLINE' },
    ],
    channels: [
      ...rotations.map((_, j) => ({
        sampler: j,
        target: { node: j, path: 'rotation' },
      })),
      { sampler: rotations.length, target: { node: JOINTS, path: 'weights' } },
    ],
  }],
  materials: [{
    name: 'totem-alloy',
    pbrMetallicRoughness: {
      baseColorFactor: [0.38, 0.72, 0.85, 1],
      metallicFactor: 0.85,
      roughnessFactor: 0.28,
    },
    doubleSided: false,
  }],
  accessors,
  bufferViews: views,
  buffers: [{ byteLength }],
};

// ---------------------------------------------------------------- GLB
const binPad = (4 - (byteLength % 4)) % 4;
const bin = new Uint8Array(byteLength + binPad);
let at = 0;
for (const chunk of chunks) {
  bin.set(chunk, at);
  at += chunk.byteLength;
}

const encoder = new TextEncoder();
const jsonBytes = encoder.encode(JSON.stringify(gltf));
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + bin.byteLength;
const out = new Uint8Array(total);
const view = new DataView(out.buffer);
view.setUint32(0, 0x46546c67, true);
view.setUint32(4, 2, true);
view.setUint32(8, total, true);
view.setUint32(12, jsonBytes.length + jsonPad, true);
view.setUint32(16, 0x4e4f534a, true);
out.set(jsonBytes, 20);
out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
const binHeader = 20 + jsonBytes.length + jsonPad;
view.setUint32(binHeader, bin.byteLength, true);
view.setUint32(binHeader + 4, 0x004e4942, true);
out.set(bin, binHeader + 8);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
console.log(`wrote ${outPath} (${out.byteLength} bytes, ${positionArray.length / 3} vertices, ${indexArray.length / 3} triangles, ${JOINTS} joints, 2 morph targets, ${KEYS} CUBICSPLINE weight keys)`);
