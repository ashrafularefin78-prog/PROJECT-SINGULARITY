/**
 * M4 streaming file AEAD.
 *
 * The 2 GB row in the brief is a statement about *memory*, not about a big
 * number on a slide: a file must move through the cipher one chunk at a time.
 * These tests pin the contract down - arbitrary source piece sizes, exact frame
 * sequence, an authenticated final flag, and lazy decryption.
 */
import { test, assert, assertEquals } from './harness.js';
import { decryptStream, encryptStream, randomBytes } from '../src/crypto/e2ee.js';

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

async function* pieces(bytes, size) {
  for (let off = 0; off < bytes.length; off += size) {
    yield bytes.subarray(off, Math.min(off + size, bytes.length));
  }
}

const SECRET = new Uint8Array(32).fill(7);

test('M4 stream: irregular source pieces round-trip exactly', async () => {
  const data = randomBytes(10000);
  const frames = await collect(encryptStream(SECRET, pieces(data, 777), 1024));
  const plain = await collect(decryptStream(SECRET, frames));
  const joined = new Uint8Array(plain.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const piece of plain) {
    joined.set(piece, at);
    at += piece.length;
  }
  assertEquals(joined.length, data.length, 'length is preserved');
  assertEquals(joined.join(','), data.join(','), 'bytes are preserved');
});

test('M4 stream: frames are a gapless sequence with exactly one final frame', async () => {
  const frames = await collect(encryptStream(SECRET, pieces(randomBytes(5000), 256), 512));
  assertEquals(frames.length, 10, '5000 bytes at 512 per frame');
  for (let i = 0; i < frames.length; i += 1) {
    assertEquals(frames[i].n, i, `frame ${i} carries its index`);
    assertEquals(frames[i].final, i === frames.length - 1, `only frame ${frames.length - 1} is final`);
  }
});

test('M4 stream: a chunk-aligned file marks the last full block as final', async () => {
  const data = randomBytes(2048);
  const frames = await collect(encryptStream(SECRET, pieces(data, 512), 512));
  assertEquals(frames.length, 4, 'four aligned blocks, no empty fifth frame');
  assertEquals(frames[3].final, true, 'the last full block is final');
  assertEquals(frames[2].final, false, 'the one before it is not');
});

test('M4 stream: empty input is one authenticated empty frame', async () => {
  const frames = await collect(encryptStream(SECRET, [], 256));
  assertEquals(frames.length, 1);
  assertEquals(frames[0].final, true);
  const plain = await collect(decryptStream(SECRET, frames));
  assertEquals(plain.length, 1);
  assertEquals(plain[0].length, 0);
});

test('M4 stream: decryption is lazy and rejects a reordered frame', async () => {
  const frames = await collect(encryptStream(SECRET, pieces(randomBytes(4096), 1024), 1024));
  const swapped = [frames[1], frames[0], ...frames.slice(2)];
  let failed = false;
  try {
    await collect(decryptStream(SECRET, swapped));
  } catch (err) {
    failed = /out of order|another stream/.test(err.message);
  }
  assert(failed, 'a reordered stream fails closed');
});

test('M4 stream: a non-byte source piece is a type error, not a silent coercion', async () => {
  let failed = false;
  try {
    await collect(encryptStream(SECRET, ['text'], 16));
  } catch (err) {
    failed = err instanceof TypeError;
  }
  assert(failed, 'strings are rejected');
});
