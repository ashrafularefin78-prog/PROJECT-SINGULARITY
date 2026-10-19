import { test, assert, assertEquals } from './harness.js';
import {
  Identity,
  Ratchet,
  GroupReceiver,
  GroupSender,
  b64,
  createGroupEpoch,
  decryptFile,
  dh,
  dhVariantInfo,
  encryptFile,
  exportDhPublic,
  exportSignPublic,
  formatSafetyNumber,
  importSignPublic,
  randomBytes,
  rotateGroupEpoch,
  safetyNumber,
  sha256,
  unb64,
  verifyBundleWith,
  x3dhInitiate,
  x3dhRespond,
  exportIdentityPrivate,
  importIdentityPrivate,
  sealPrivateKeys,
  openPrivateKeys,
  derivePassphraseKey,
} from '../src/crypto/e2ee.js';
// The handshake helper lives in one place so the fuzz suite and this one cannot
// drift apart (see tests/crypto-helpers.js).
import { dec, handshake, hexLocal } from './crypto-helpers.js';

test('M4: DH primitive is symmetric and uses a real curve', async () => {
  const v = await dhVariantInfo();
  assert(['X25519', 'ECDH-P256'].includes(v.name), 'expected X25519 or P-256, got ' + v.name);
  const alice = await Identity.create('a');
  const bob = await Identity.create('b');
  const ab = await dh(alice.dhPair, bob.dhPair.publicKey);
  const ba = await dh(bob.dhPair, alice.dhPair.publicKey);
  assertEquals(hexLocal(ab), hexLocal(ba), 'ECDH must agree');
  assertEquals(ab.length, 32);
});

test('M4: signed prekey signature verifies and detects tampering', async () => {
  const bob = await Identity.create('bob');
  const bundle = await bob.bundle();
  const vk = await importSignPublic(bundle.sign);
  assert(await verifyBundleWith(bundle, vk), 'valid bundle must verify');
  const tampered = { ...bundle, spk: b64(new Uint8Array(32).fill(7)) };
  assert(!(await verifyBundleWith(tampered, vk)), 'swapped prekey must fail verification');
  const badSig = { ...bundle, spkSig: b64(new Uint8Array(bundle.spkSig.length).fill(0)) };
  assert(!(await verifyBundleWith(badSig, vk)), 'forged signature must fail');
});

test('M4: the bundle check the handshake runs rejects forged and swapped prekeys', async () => {
  // This is the exact call the app makes before deriving any key material
  // (initCrypto -> Identity/verifyBundleWith). It used to run only in tests,
  // which meant a spliced prekey bundle was accepted in practice.
  const bob = await Identity.create('bob');
  const bundle = await bob.bundle();
  assert(await bob.verifyBundle(bundle), 'a well-formed bundle verifies against its advertised key');
  assert(
    await bob.verifyBundle(bundle, await importSignPublic(unb64(bundle.sign))),
    'verification against an explicitly supplied trusted key agrees',
  );
  assert(
    !(await bob.verifyBundle({ ...bundle, spkSig: b64(new Uint8Array(unb64(bundle.spkSig).length)) })),
    'a forged signature must abort the handshake',
  );
  assert(
    !(await bob.verifyBundle({ ...bundle, spk: b64(new Uint8Array(32).fill(9)) })),
    'a swapped signed prekey must abort the handshake',
  );
  // A bundle produced by a different identity, presented as bob's own key.
  const mallory = await Identity.create('mallory');
  const foreign = await mallory.bundle();
  assert(
    !(await bob.verifyBundle({ ...foreign, sign: bundle.sign })),
    'a foreign bundle must not verify against the claimed identity key',
  );
});

test('M4: X3DH derives the same root key on both sides', async () => {
  const alice = await Identity.create('alice');
  const bob = await Identity.create('bob');
  await bob.createOneTimePrekeys(1);
  const opk = bob.oneTimePrekeys[0];
  const bundle = await bob.bundle();
  const aliceIk = b64(await exportDhPublic(alice.dhPair));

  const { root, epk } = await x3dhInitiate(alice, bundle);
  const bobRoot = await x3dhRespond(bob, aliceIk, epk, opk.pair);
  assertEquals(hexLocal(root), hexLocal(bobRoot), 'X3DH roots must match');
  assertEquals(root.length, 32);

  // Without the one-time prekey the secrets must differ (no silent downgrade).
  const bobRootNoOpk = await x3dhRespond(bob, aliceIk, epk, null);
  assert(hexLocal(root) !== hexLocal(bobRootNoOpk), 'missing OPK must change the secret');
});

test('M4: a full Double Ratchet conversation converges both directions', async () => {
  const { a, b } = await handshake();
  const m1 = await a.encrypt('hello bob');
  assertEquals(dec(await b.decrypt(m1)), 'hello bob');
  const m2 = await b.encrypt('hello alice');
  assertEquals(dec(await a.decrypt(m2)), 'hello alice');
  const m3 = await a.encrypt('third');
  const m4 = await b.encrypt('fourth');
  assertEquals(dec(await b.decrypt(m3)), 'third');
  assertEquals(dec(await a.decrypt(m4)), 'fourth');
});

test('M4: out-of-order and dropped messages still decrypt (skipped keys)', async () => {
  const { a, b } = await handshake();
  const msgs = [];
  for (let i = 0; i < 5; i += 1) msgs.push(await a.encrypt('msg-' + i));
  // Deliver 4, 3, 0 then drop 1, deliver 2.
  assertEquals(dec(await b.decrypt(msgs[4])), 'msg-4');
  assertEquals(dec(await b.decrypt(msgs[3])), 'msg-3');
  assertEquals(dec(await b.decrypt(msgs[0])), 'msg-0');
  assertEquals(dec(await b.decrypt(msgs[2])), 'msg-2');
  assertEquals(b.skipped.size, 1, 'only the dropped key should remain cached');
});

test('M4: replaying a message and tampering with ciphertext are rejected', async () => {
  const { a, b } = await handshake();
  const m = await a.encrypt('once');
  assertEquals(dec(await b.decrypt(m)), 'once');
  let replayRejected = false;
  try {
    await b.decrypt(m);
  } catch {
    replayRejected = true;
  }
  assert(replayRejected, 'a replayed message must be rejected');

  const m2 = await a.encrypt('integrity');
  const bytes = unb64(m2.ct);
  bytes[3] ^= 0x01;
  const tampered = { header: m2.header, ct: b64(bytes) };
  let tamperRejected = false;
  try {
    await b.decrypt(tampered);
  } catch {
    tamperRejected = true;
  }
  assert(tamperRejected, 'tampered ciphertext must fail AEAD verification');
});

test('M4: every message consumes a unique key pair (no nonce reuse)', async () => {
  const { a, b } = await handshake();
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) {
    const m = await a.encrypt('same plaintext every time');
    assert(!seen.has(m.ct), 'identical ciphertext means a reused (key, nonce) pair');
    seen.add(m.ct);
    assertEquals(dec(await b.decrypt(m)), 'same plaintext every time');
  }
});

test('M4: a DH ratchet step changes the sending chain (key evolution)', async () => {
  const { a, b } = await handshake();
  const m1 = await a.encrypt('before');
  await b.decrypt(m1);
  const beforeChain = hexLocal(a.ckSend);
  const reply = await b.encrypt('reply');
  await a.decrypt(reply); // forces a DH ratchet on alice
  const afterChain = hexLocal(a.ckSend);
  assert(beforeChain !== afterChain, 'ratchet step must replace the sending chain');
  assertEquals(dec(await b.decrypt(await a.encrypt('after'))), 'after');
});

test('M4: safety numbers match on both sides and detect key changes', async () => {
  const alice = await Identity.create('alice');
  const bob = await Identity.create('bob');
  const mallory = await Identity.create('mallory');
  const a = b64(await exportDhPublic(alice.dhPair));
  const b = b64(await exportDhPublic(bob.dhPair));
  const m = b64(await exportDhPublic(mallory.dhPair));

  const snAB = await safetyNumber(a, b);
  const snBA = await safetyNumber(b, a);
  assertEquals(snAB, snBA, 'safety number must be order independent');
  assertEquals(snAB.length, 60, 'safety number is 60 digits');
  assert(await safetyNumber(a, m) !== snAB, 'a swapped identity key must change it');
  assert(/^(\d{5} ){11}\d{5}$/.test(formatSafetyNumber(snAB)), 'groups of five digits');
});

test('M4: group messages round-trip and are bound to sender + index', async () => {
  const contributions = [b64(randomBytes(32)), b64(randomBytes(32))];
  const epoch = await createGroupEpoch(contributions);
  const sender = await GroupSender.create(epoch, 'room-1', 0, 'alice');
  const aliceRecv = new GroupReceiver(epoch, 'room-1', 0);
  const bobRecv = new GroupReceiver(epoch, 'room-1', 0);

  const m0 = await sender.encrypt('first');
  const m1 = await sender.encrypt('second');
  const m2 = await sender.encrypt('third');
  assertEquals(dec(await bobRecv.decrypt(m2)), 'third'); // out of order
  assertEquals(dec(await bobRecv.decrypt(m0)), 'first');
  assertEquals(dec(await bobRecv.decrypt(m1)), 'second');

  // A receiver must not be able to decrypt its own echo twice (replay bound).
  let replayed = false;
  try {
    const bobRecv2 = new GroupReceiver(epoch, 'room-1', 0);
    await bobRecv2.decrypt(m1);
    await bobRecv2.decrypt(m1); // same index again -> chain already advanced
  } catch {
    replayed = true;
  }
  assert(replayed, 'replaying a group frame must fail');
});

test('M4: kicking a member rotates the epoch so old keys cannot read on', async () => {
  const c1 = b64(randomBytes(32));
  const c2 = b64(randomBytes(32));
  const c3 = b64(randomBytes(32));
  const epoch0 = await createGroupEpoch([c1, c2, c3]);

  const sender0 = await GroupSender.create(epoch0, 'room', 0, 'alice');
  const kickedRecv = new GroupReceiver(epoch0, 'room', 0);
  assertEquals(dec(await kickedRecv.decrypt(await sender0.encrypt('pre-kick'))), 'pre-kick');

  // carol leaves: remaining members re-key with fresh randomness.
  const epoch1 = await rotateGroupEpoch(epoch0, [b64(randomBytes(32)), b64(randomBytes(32))]);
  assert(hexLocal(epoch1) !== hexLocal(epoch0), 'epoch secret must change');

  const sender1 = await GroupSender.create(epoch1, 'room', 1, 'alice');
  const fresh = new GroupReceiver(epoch1, 'room', 1);
  const laterMessage = await sender1.encrypt('post-kick');
  assertEquals(dec(await fresh.decrypt(laterMessage)), 'post-kick');

  let kickedBlocked = false;
  try {
    await kickedRecv.decrypt(laterMessage);
  } catch {
    kickedBlocked = true;
  }
  assert(kickedBlocked, 'a kicked member must not read post-kick traffic');
});

test('M4: chunked file AEAD round-trips 1 MiB with bounded frames', async () => {
  const secret = randomBytes(32);
  const size = 1024 * 1024;
  const data = randomBytes(size);
  const chunk = 256 * 1024;
  const frames = await encryptFile(secret, data, chunk);
  assertEquals(frames.length, 4, 'expected 4 independently authenticated frames');
  assertEquals(frames[0].n, 0);
  assertEquals(frames[3].final, true);

  const round = await decryptFile(secret, frames);
  assertEquals(round.length, size);
  assert(hexLocal(await sha256(round)) === hexLocal(await sha256(data)), 'content mismatch');
});

test('M4: a reordered or tampered file frame fails closed', async () => {
  const secret = randomBytes(32);
  const frames = await encryptFile(secret, randomBytes(768 * 1024), 256 * 1024);
  assertEquals(frames.length, 3);

  const swapped = [frames[1], frames[0], frames[2]];
  let reorderRejected = false;
  try {
    await decryptFile(secret, swapped);
  } catch {
    reorderRejected = true;
  }
  assert(reorderRejected, 'reordered frames must fail (index is authenticated + ordered)');

  const dropped = [frames[0], frames[2]];
  let dropRejected = false;
  try {
    await decryptFile(secret, dropped);
  } catch {
    dropRejected = true;
  }
  assert(dropRejected, 'a dropped frame must fail');

  const bad = frames.map((f) => ({ ...f }));
  const bytes = unb64(bad[2].ct);
  bytes[10] ^= 0xff;
  bad[2].ct = b64(bytes);
  let tamperRejected = false;
  try {
    await decryptFile(secret, bad);
  } catch {
    tamperRejected = true;
  }
  assert(tamperRejected, 'a tampered frame must fail');
});

test('M4: the wrong secret cannot open a file stream', async () => {
  const frames = await encryptFile(randomBytes(32), randomBytes(70000), 4096);
  let failed = false;
  try {
    await decryptFile(randomBytes(32), frames);
  } catch {
    failed = true;
  }
  assert(failed, 'decryption with the wrong key must fail');
});

test('M4: private keys round-trip through passphrase sealing', async () => {
  const id = await Identity.create('alice');
  const sealed = await sealPrivateKeys(id, 'correct horse battery staple');
  const reopened = await openPrivateKeys(sealed, 'correct horse battery staple', 'alice');
  // Public keys must survive the round trip.
  const origPub = await exportDhPublic(id.dhPair);
  const newPub = await exportDhPublic(reopened.dhPair);
  assertEquals(b64(origPub), b64(newPub), 'dh public key must survive seal/open');
  // The reopened identity can still do DH.
  const bob = await Identity.create('bob');
  const a = await dh(id.dhPair, bob.dhPair.publicKey);
  const b = await dh(reopened.dhPair, bob.dhPair.publicKey);
  assertEquals(b64(a), b64(b), 'reopened identity must agree on DH');
});

test('M4: wrong passphrase fails to open sealed keys', async () => {
  const id = await Identity.create('alice');
  const sealed = await sealPrivateKeys(id, 'right-passphrase');
  let failed = false;
  try {
    await openPrivateKeys(sealed, 'wrong-passphrase', 'alice');
  } catch {
    failed = true;
  }
  assert(failed, 'wrong passphrase must fail to decrypt');
});

test('M4: the sealed blob carries its KDF work factor and both key bindings', async () => {
  const id = await Identity.create('alice');
  const sealed = await sealPrivateKeys(id, 'a long enough passphrase');
  assertEquals(sealed.v, 2, 'sealed blob version');
  assertEquals(sealed.kdf, 'PBKDF2-SHA256', 'KDF name must travel with the blob');
  assertEquals(sealed.iterations, 600000, 'default PBKDF2 iterations');
  assert(sealed.ik && sealed.sign, 'both identity public keys must be bound into the blob');
  const reopened = await openPrivateKeys(sealed, 'a long enough passphrase', 'alice');
  assertEquals(reopened.dhPair.privateKey.extractable, false, 'DH private key must be non-extractable after import');
  assertEquals(reopened.signPair.privateKey.extractable, false, 'signing private key must be non-extractable after import');
});

test('M4: tampering with either identity key binding fails closed', async () => {
  const id = await Identity.create('alice');
  const other = await Identity.create('mallory');
  const sealed = await sealPrivateKeys(id, 'a long enough passphrase');
  for (const field of ['ik', 'sign']) {
    const tampered = { ...sealed, [field]: field === 'ik' ? b64(await exportDhPublic(other.dhPair)) : b64(await exportSignPublic(other.signPair)) };
    let failed = false;
    try {
      await openPrivateKeys(tampered, 'a long enough passphrase', 'alice');
    } catch {
      failed = true;
    }
    assert(failed, `a swapped ${field} binding must fail the AEAD check`);
  }
});

test('M4: an out-of-range KDF work factor and a short passphrase are refused', async () => {
  const id = await Identity.create('alice');
  const sealed = await sealPrivateKeys(id, 'a long enough passphrase');
  let failed = false;
  try {
    await openPrivateKeys({ ...sealed, iterations: 1000 }, 'a long enough passphrase', 'alice');
  } catch {
    failed = true;
  }
  assert(failed, 'a KDF work factor below the floor must be refused');
  failed = false;
  try {
    await sealPrivateKeys(id, 'short');
  } catch {
    failed = true;
  }
  assert(failed, 'a passphrase shorter than 8 characters must be refused');
});

test('M4: export/import private keys round-trips', async () => {
  const id = await Identity.create('alice');
  await id.rotateSignedPrekey();
  const bytes = await exportIdentityPrivate(id);
  const restored = await importIdentityPrivate(bytes, 'alice');
  const origPub = await exportDhPublic(id.dhPair);
  const newPub = await exportDhPublic(restored.dhPair);
  assertEquals(b64(origPub), b64(newPub), 'dh public key must survive export/import');
  // signed prekey must survive too
  assert(restored.spkPair !== null, 'signed prekey must survive export/import');
});
