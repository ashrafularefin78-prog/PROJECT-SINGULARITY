/**
 * The 2 GB streamed-file test.
 *
 * The claim this script exists to support is "memory stays bounded no matter
 * how big the file is", so the script is written the only way that claim can
 * be true: the plaintext is never materialised. A deterministic generator
 * produces one chunk at a time, the chunk is encrypted straight into a frame,
 * the frame goes to disk, and the disk is read back frame by frame and
 * decrypted one frame at a time. The only thing in memory at any moment is
 * the current chunk (256 KiB by default) plus the JSON line of the frame
 * being written.
 *
 * The file on disk is the real wire format: newline-delimited JSON, one
 * { streamId, n, final, ct } object per line, exactly what
 * ChunkEncryptor.pushChunk() returns.
 *
 *   node tools/stream-2gb.js                 # 2 GiB, the default
 *   node tools/stream-2gb.js --bytes=104857600 --keep
 *
 * What it prints: throughput, the peak RSS / heap / external memory observed
 * during each phase, and the digests of the plaintext before encryption and
 * after decryption. Equal digests plus a flat memory trace is the whole
 * claim: the file was transferred, and it was never held in memory.
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ChunkEncryptor, randomBytes } from '../src/crypto/e2ee.js';

const args = new Map();
for (const arg of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
  if (m) args.set(m[1], m[2] === undefined ? 'true' : m[2]);
}

const TOTAL = Number(args.get('bytes') || 2 * 1024 * 1024 * 1024);
const CHUNK = Number(args.get('chunk') || 256 * 1024);
const OUT = args.get('out') || '.tools/scratch/stream-2gb/frames.ndjson';
const KEEP = args.get('keep') === 'true';
const SAMPLE_EVERY = Number(args.get('sample-every') || 256 * 1024 * 1024);

if (TOTAL % CHUNK !== 0) throw new Error('bytes must be a multiple of the chunk size');

/**
 * A deterministic byte source. xorshift32 is not a cryptographic generator and
 * does not need to be: the plaintext here is test material, and the point is
 * that the same bytes come out on the other side. The pattern is also cheap
 * enough that the generator is never the bottleneck.
 */
function makeGenerator(seed) {
  let x = seed | 0 || 0x9e3779b9;
  return function fill(target) {
    for (let i = 0; i < target.length; i += 4) {
      x ^= x << 13; x |= 0;
      x ^= x >>> 17;
      x ^= x << 5; x |= 0;
      target[i] = x & 0xff;
      target[i + 1] = (x >>> 8) & 0xff;
      target[i + 2] = (x >>> 16) & 0xff;
      target[i + 3] = (x >>> 24) & 0xff;
    }
    return target;
  };
}

const samples = [];
function sample(label) {
  const m = process.memoryUsage();
  const point = {
    label,
    rss: m.rss,
    heapUsed: m.heapUsed,
    heapTotal: m.heapTotal,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  };
  samples.push(point);
  const mb = (n) => (n / 1048576).toFixed(1);
  console.log(
    `  ${label.padEnd(26)} rss ${mb(point.rss).padStart(8)} MiB   heap ${mb(point.heapUsed).padStart(8)} MiB   ` +
    `arrayBuffers ${mb(point.arrayBuffers).padStart(8)} MiB`,
  );
  return point;
}

const peak = (key) => samples.reduce((m, s) => Math.max(m, s[key]), 0);

async function main() {
  await mkdir(dirname(OUT), { recursive: true });
  console.log(
    `streaming ${(TOTAL / 1048576).toFixed(0)} MiB in ${(CHUNK / 1024).toFixed(0)} KiB frames -> ${OUT}`,
  );

  const secret = randomBytes(32);
  const fill = makeGenerator(0x1234567);
  const plainHash = createHash('sha256');
  const enc = await ChunkEncryptor.fromSecret(secret);

  // ---------------------------------------------------------------- encrypt
  const out = createWriteStream(OUT, { encoding: 'utf8' });
  let outError = null;
  out.on('error', (error) => {
    outError = error;
  });
  const write = (line) =>
    new Promise((resolve, reject) => {
      if (outError) {
        reject(outError);
        return;
      }
      if (out.write(line)) resolve();
      else out.once('drain', resolve);
    });

  let bytes = 0;
  let frames = 0;
  let sinceSample = 0;
  const t0 = Date.now();
  const chunk = new Uint8Array(CHUNK);
  while (bytes < TOTAL) {
    fill(chunk);
    plainHash.update(chunk);
    const frame = await enc.pushChunk(chunk, { final: bytes + CHUNK >= TOTAL });
    await write(JSON.stringify(frame) + '\n');
    bytes += CHUNK;
    frames += 1;
    sinceSample += CHUNK;
    if (sinceSample >= SAMPLE_EVERY) {
      sinceSample = 0;
      sample(`encrypt ${(bytes / 1048576).toFixed(0)} MiB`);
    }
  }
  await new Promise((resolve) => out.end(resolve));
  const encMs = Date.now() - t0;
  sample('encrypt done');

  const cipherHash = createHash('sha256');
  const plainDigest = plainHash.digest('hex');

  // ---------------------------------------------------------------- decrypt
  const dec = await ChunkEncryptor.openFromSecret(secret);
  const rl = createInterface({ input: createReadStream(OUT, { encoding: 'utf8' }), crlfDelay: Infinity });
  const t1 = Date.now();
  let dbytes = 0;
  let dframes = 0;
  for await (const line of rl) {
    if (!line) continue;
    const frame = JSON.parse(line);
    const plain = await dec.openFrame(frame);
    cipherHash.update(plain);
    dbytes += plain.length;
    dframes += 1;
    if (dbytes % SAMPLE_EVERY === 0) sample(`decrypt ${(dbytes / 1048576).toFixed(0)} MiB`);
  }
  const decMs = Date.now() - t1;
  sample('decrypt done');
  const roundDigest = cipherHash.digest('hex');

  const fileSize = (await stat(OUT)).size;
  if (!KEEP) await rm(OUT, { force: true });

  const report = {
    generatedAt: new Date().toISOString(),
    totalBytes: TOTAL,
    chunkBytes: CHUNK,
    frames,
    framesDecrypted: dframes,
    bytesDecrypted: dbytes,
    plaintextSha256: plainDigest,
    roundTripSha256: roundDigest,
    digestsMatch: plainDigest === roundDigest,
    ciphertextFileBytes: fileSize,
    encryptMs: encMs,
    decryptMs: decMs,
    encryptMiBPerSecond: Number((TOTAL / 1048576 / (encMs / 1000)).toFixed(1)),
    decryptMiBPerSecond: Number((TOTAL / 1048576 / (decMs / 1000)).toFixed(1)),
    peakRssBytes: peak('rss'),
    peakHeapUsedBytes: peak('heapUsed'),
    peakArrayBuffersBytes: peak('arrayBuffers'),
    nodeVersion: process.version,
    samples: samples.map((s) => ({
      label: s.label,
      rssMiB: Number((s.rss / 1048576).toFixed(1)),
      heapUsedMiB: Number((s.heapUsed / 1048576).toFixed(1)),
      arrayBuffersMiB: Number((s.arrayBuffers / 1048576).toFixed(1)),
    })),
  };

  console.log('');
  console.log(`frames encrypted   ${frames}`);
  console.log(`frames decrypted   ${dframes}`);
  console.log(`plaintext sha-256  ${plainDigest}`);
  console.log(`round-trip sha-256 ${roundDigest}`);
  console.log(`digests match      ${report.digestsMatch}`);
  console.log(`peak rss           ${(report.peakRssBytes / 1048576).toFixed(1)} MiB`);
  console.log(`peak heap used     ${(report.peakHeapUsedBytes / 1048576).toFixed(1)} MiB`);
  console.log(`peak arrayBuffers  ${(report.peakArrayBuffersBytes / 1048576).toFixed(1)} MiB`);
  console.log(`encrypt            ${report.encryptMiBPerSecond} MiB/s`);
  console.log(`decrypt            ${report.decryptMiBPerSecond} MiB/s`);

  if (args.get('json')) {
    console.log(JSON.stringify(report));
  } else {
    const { writeFile, mkdir: mk } = await import('node:fs/promises');
    const reportPath = args.get('report') || 'docs/reports/stream-2gb.json';
    await mk(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`report             ${reportPath}`);
  }

  if (!report.digestsMatch) {
    console.error('FAILED: the decrypted bytes do not match the plaintext');
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
