/**
 * Stream a file of a chosen size through the chunk AEAD and measure it.
 *
 *   node tools/bench-stream.js --size=2GiB --chunk=256KiB
 *
 * The brief's M4 row asks for 2 GB with no full-file buffering. This tool is
 * the evidence: it never allocates the file, it feeds a repeating pattern into
 * `encryptStream`, decrypts each frame as it arrives, and compares a checksum
 * of what came back against a checksum of what went in. Peak RSS is sampled
 * throughout, so "bounded memory" is a measurement rather than a claim.
 *
 * No npm dependency, no temp file, no server: the same crypto module the app
 * ships is the thing under test.
 */
import { ChunkEncryptor, encryptStream } from '../src/crypto/e2ee.js';

function parseSize(text) {
  const m = /^(\d+(?:\.\d+)?)\s*(K|M|G)?i?B?$/i.exec(String(text).trim());
  if (!m) throw new Error(`cannot parse size '${text}' (expected e.g. 512MiB, 2GiB)`);
  const unit = (m[2] || '').toUpperCase();
  const scale = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : 1;
  return Math.round(Number(m[1]) * scale);
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const totalBytes = parseSize(arg('size', '64MiB'));
const chunkSize = parseSize(arg('chunk', '1MiB'));
const pieceSize = parseSize(arg('piece', '64KiB'));
if (pieceSize > chunkSize * 4) throw new Error('--piece is too large relative to --chunk');

const SECRET = new Uint8Array(32).fill(0x5a);
// A deterministic pattern, so a mismatch is always the cipher's fault.
const pattern = new Uint8Array(pieceSize);
for (let i = 0; i < pattern.length; i += 1) pattern[i] = (i * 31 + 17) & 0xff;

function mix(hash, bytes) {
  let h = hash;
  for (let i = 0; i < bytes.length; i += 1) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

async function* source() {
  let sent = 0;
  while (sent < totalBytes) {
    const take = Math.min(pieceSize, totalBytes - sent);
    yield take === pieceSize ? pattern : pattern.subarray(0, take);
    sent += take;
  }
}

const sampleRss = () => process.memoryUsage().rss / 1048576;
const started = process.hrtime.bigint();
const baselineRssMiB = sampleRss();
let peakRssMiB = baselineRssMiB;

let inHash = 0;
for (let sent = 0, left = totalBytes; left > 0; left -= Math.min(pieceSize, left)) {
  inHash = mix(inHash, pattern.subarray(0, Math.min(pieceSize, left)));
}

const dec = await ChunkEncryptor.openFromSecret(SECRET);
let outHash = 0;
let received = 0;
let frames = 0;
let finalFrames = 0;
let lastFrameWasFinal = false;
let maxFrameOverhead = 0;

for await (const frame of encryptStream(SECRET, source(), chunkSize)) {
  if (lastFrameWasFinal) throw new Error('frame arrived after the final frame');
  frames += 1;
  if (frame.final) finalFrames += 1;
  lastFrameWasFinal = frame.final;
  const plain = await dec.openFrame(frame);
  outHash = mix(outHash, plain);
  received += plain.length;
  maxFrameOverhead = Math.max(maxFrameOverhead, frame.ct.length);
  if (frames % 64 === 0) peakRssMiB = Math.max(peakRssMiB, sampleRss());
}
peakRssMiB = Math.max(peakRssMiB, sampleRss());
const seconds = Number(process.hrtime.bigint() - started) / 1e9;

const report = {
  sizeMiB: +(totalBytes / 1048576).toFixed(1),
  chunkKiB: chunkSize / 1024,
  frames,
  finalFrames,
  bytesReceived: received,
  bytesOk: received === totalBytes && outHash === inHash,
  throughputMiBps: +(totalBytes / 1048576 / seconds).toFixed(1),
  seconds: +seconds.toFixed(2),
  baselineRssMiB: +baselineRssMiB.toFixed(1),
  peakRssMiB: +peakRssMiB.toFixed(1),
  rssGrowthMiB: +(peakRssMiB - baselineRssMiB).toFixed(1),
  largestFrameB64: maxFrameOverhead,
};

console.log(JSON.stringify(report, null, 2));
if (!report.bytesOk) {
  console.error('FAIL: decrypted bytes do not match the source');
  process.exitCode = 1;
}
if (frames === 0 || finalFrames !== 1) {
  console.error(`FAIL: expected exactly one final frame, got ${finalFrames} of ${frames}`);
  process.exitCode = 1;
}

// A 2 GiB file must not drag the whole ciphertext (or plaintext) into memory.
// The ceiling is absolute rather than a function of the input: that is the
// claim. It is deliberately loose because V8 does not collect base64 strings
// eagerly, so resident memory includes garbage the collector has not taken yet.
// The evidence is a second run at a larger size: if this number stayed flat
// while the file quadrupled, memory is not proportional to the file.
const growthCeilingMiB = Number(arg('assert-growth', '320'));
if (report.rssGrowthMiB > growthCeilingMiB) {
  console.error(
    `FAIL: RSS grew ${report.rssGrowthMiB} MiB (ceiling ${growthCeilingMiB} MiB); that is not size-independent`,
  );
  process.exitCode = 1;
}
