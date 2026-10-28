import { test, assert, assertEquals, assertDeepEquals } from './harness.js';
import {
  Identity,
  Ratchet,
  SenderChain,
  MAX_SKIP,
  randomBytes,
  GroupReceiver,
  GroupSender,
  b64,
  unb64,
  createGroupEpoch,
  decryptFile,
  encryptFile,
  dh,
  dhVariantInfo,
  exportDhPublic,
  importDhPublic,
  exportSignPublic,
  importSignPublic,
  exportIdentityPrivate,
  importIdentityPrivate,
  sealPrivateKeys,
  openPrivateKeys,
} from '../src/crypto/e2ee.js';
import { openLocalStore } from '../src/storage/db.js';
import { dec, handshake } from './crypto-helpers.js';

async function expectRejected(promise, pattern = null) {
  try {
    await promise;
  } catch (error) {
    if (pattern) assert(pattern.test(error.message), `unexpected rejection: ${error.message}`);
    return;
  }
  assert(false, 'expected a rejection');
}

function tamper(message) {
  const bytes = unb64(message.ct);
  bytes[0] ^= 0x80;
  return { ...message, ct: b64(bytes) };
}

const ratchetFields = [
  'rootKey', 'dhSelf', 'dhRemote', 'ckSend', 'ckRecv',
  'nSend', 'nRecv', 'pn', 'skipped', 'usedMessageKeys',
];
const skippedEntries = (skipped) => [...skipped].map(([n, key]) => [n, b64(key)]);

function ratchetState(r) {
  return {
    ...Object.fromEntries(ratchetFields.map((field) => [field, r[field]])),
    skippedEntries: skippedEntries(r.skipped),
    usedEntries: [...r.usedMessageKeys],
  };
}

function assertRatchetUnchanged(r, before) {
  for (const field of ratchetFields) assertEquals(r[field], before[field], `${field} changed before authentication`);
  assertDeepEquals(skippedEntries(r.skipped), before.skippedEntries, 'skipped keys changed before authentication');
  assertDeepEquals([...r.usedMessageKeys], before.usedEntries, 'replay records changed before authentication');
}

function chainState(chain) {
  return { chainKey: chain.chainKey, n: chain.n, skipped: chain.skipped, entries: skippedEntries(chain.skipped) };
}

function assertChainUnchanged(chain, before) {
  assertEquals(chain.chainKey, before.chainKey, 'chain key changed before authentication');
  assertEquals(chain.n, before.n, 'chain counter changed before authentication');
  assertEquals(chain.skipped, before.skipped, 'skipped map replaced before authentication');
  assertDeepEquals(skippedEntries(chain.skipped), before.entries, 'skipped group keys changed before authentication');
}

const invalidCounters = [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined, {}, []];

test('M4: DH primitive is symmetric and uses a real curve', async () => {
  const a = await Identity.create('a');
  const b = await Identity.create('b');
  const ap = await exportDhPublic(a.dhPair);
  const bp = await exportDhPublic(b.dhPair);
  const bPub = await importDhPublic(bp);
  const aPub = await importDhPublic(ap);
  const ak = await dh(a.dhPair, bPub);
  const bk = await dh(b.dhPair, aPub);
  assertEquals(b64(ak), b64(bk), 'both sides derive the same shared secret');
  const v = await dhVariantInfo();
  assert(v.bits >= 255, `DH is at least 255-bit (${v.name})`);
});

test('M4: the bundle check the handshake runs rejects forged and swapped prekeys', async () => {
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
  const mallory = await Identity.create('mallory');
  const foreign = await mallory.bundle();
  assert(
    !(await bob.verifyBundle({ ...foreign, sign: bundle.sign })),
    'a foreign bundle must not verify against the claimed identity key',
  );
});

test('M4: wrong passphrase fails to open sealed keys', async () => {
  const id = await Identity.create('alice');
  const sealed = await sealPrivateKeys(id, 'correct horse battery staple');
  let threw = false;
  try {
    await openPrivateKeys(sealed, 'wrong password');
  } catch {
    threw = true;
  }
  assert(threw, 'a wrong passphrase must refuse to unseal the identity');
});

test('M4: tampering with either identity key binding fails closed', async () => {
  const id = await Identity.create('alice');
  const sealed = await sealPrivateKeys(id, 'correct horse battery staple');
  const tampered = { ...sealed, ct: b64(new Uint8Array(unb64(sealed.ct).length).fill(0)) };
  let threw1 = false;
  try {
    await openPrivateKeys(tampered, 'correct horse battery staple');
  } catch {
    threw1 = true;
  }
  assert(threw1, 'a tampered sealed blob must refuse to unseal');
  const forged = { v: 2, kdf: 'PBKDF2-SHA256', iterations: 600000, salt: b64(new Uint8Array(16)), iv: b64(new Uint8Array(12)), ik: b64(new Uint8Array(32)), sign: b64(new Uint8Array(32)), ct: b64(new Uint8Array(32)) };
  let threw2 = false;
  try {
    await openPrivateKeys(forged, 'correct horse battery staple');
  } catch {
    threw2 = true;
  }
  assert(threw2, 'a blob that is not a sealed identity must refuse to unseal');
});

test('M4: key pairs export/import round-trip', async () => {
  const id = await Identity.create('alice');
  const bytes = await exportIdentityPrivate(id);
  const restored = await importIdentityPrivate(bytes, 'alice');
  const origPub = await exportDhPublic(id.dhPair);
  const newPub = await exportDhPublic(restored.dhPair);
  assertEquals(b64(origPub), b64(newPub), 'dh public key must survive export/import');
  assert(restored.spkPair !== null, 'signed prekey must survive export/import');
});

test('M4: parallel ratchet sends use distinct counters and keys; concurrent receives decrypt', async () => {
  const { a, b } = await handshake();
  const messages = await Promise.all(Array.from({ length: 12 }, () => a.encrypt('same plaintext')));
  assertDeepEquals(messages.map((m) => m.header.n), Array.from({ length: 12 }, (_, n) => n));
  // Ignore GCM tags: different AAD can change a tag even when a key is reused.
  assertEquals(new Set(messages.map((m) => b64(unb64(m.ct).slice(0, -16)))).size, messages.length, 'AEAD key/nonce reused');
  const opened = await Promise.all([...messages].reverse().map((m) => b.decrypt(m)));
  for (const plaintext of opened) assertEquals(dec(plaintext), 'same plaintext');
  const next = await a.encrypt('next');
  assertEquals(next.header.n, 12);
  assertEquals(dec(await b.decrypt(next)), 'next');
});

test('M4: ratchet send and receive share a rejection-recovering queue across DH commits', async () => {
  const { a, b } = await handshake();
  const first = await a.encrypt('first');
  const results = await Promise.allSettled([
    b.encrypt('too early'), b.decrypt(first), b.encrypt('reply'),
  ]);
  assertEquals(results[0].status, 'rejected');
  assertEquals(results[1].status, 'fulfilled');
  assertEquals(dec(results[1].value), 'first');
  assertEquals(results[2].status, 'fulfilled');
  const reply = results[2].value;
  const [opened, outgoing] = await Promise.all([a.decrypt(reply), a.encrypt('after DH')]);
  assertEquals(dec(opened), 'reply');
  assert(outgoing.header.dh !== first.header.dh, 'send must observe committed DH state');
  assertEquals(outgoing.header.n, 0);
  assertEquals(outgoing.header.pn, 1);
  assertEquals(dec(await b.decrypt(outgoing)), 'after DH');

  const nextReply = await b.encrypt('next reply');
  const [before, received, after] = await Promise.all([
    a.encrypt('before DH'), a.decrypt(nextReply), a.encrypt('after next DH'),
  ]);
  assertEquals(dec(received), 'next reply');
  assertEquals(before.header.n, 1);
  assertEquals(after.header.n, 0);
  assertEquals(after.header.pn, 2);
  const plaintexts = await Promise.all([b.decrypt(after), b.decrypt(before)]);
  assertDeepEquals(plaintexts.map(dec), ['after next DH', 'before DH']);
  await expectRejected(a.encrypt(null));
  assertEquals(dec(await b.decrypt(await a.encrypt('after failed send'))), 'after failed send');
});

test('M4: tampered first ratchet frame leaves all state intact and original authenticates', async () => {
  const { a, b } = await handshake();
  const first = await a.encrypt('first');
  const before = ratchetState(b);
  await expectRejected(b.decrypt(tamper(first)));
  assertRatchetUnchanged(b, before);
  const next = await a.encrypt('next');
  const opened = await Promise.all([b.decrypt(first), b.decrypt(next)]);
  assertDeepEquals(opened.map(dec), ['first', 'next']);
  const settled = ratchetState(b);
  await expectRejected(b.decrypt(first), /replay/);
  assertRatchetUnchanged(b, settled);
});

test('M4: tampered new-DH frame cannot rotate state or park previous-chain keys', async () => {
  const { a, b } = await handshake();
  const old = await Promise.all(['old 0', 'old 1', 'old 2'].map((text) => a.encrypt(text)));
  await b.decrypt(old[0]);
  await a.decrypt(await b.encrypt('reply'));
  const fresh = await Promise.all(['new 0', 'new 1', 'new 2'].map((text) => a.encrypt(text)));
  assert(fresh[2].header.dh !== old[0].header.dh);
  assertEquals(fresh[2].header.pn, 3);
  const before = ratchetState(b);
  await expectRejected(b.decrypt(tamper(fresh[2])));
  assertRatchetUnchanged(b, before);
  assertEquals(dec(await b.decrypt(fresh[2])), 'new 2');

  const skipped = ratchetState(b);
  await expectRejected(b.decrypt(tamper(old[1])));
  assertRatchetUnchanged(b, skipped);
  const opened = await Promise.all([old[1], fresh[1], old[2], fresh[0]].map((m) => b.decrypt(m)));
  assertDeepEquals(opened.map(dec), ['old 1', 'new 1', 'old 2', 'new 0']);
  await expectRejected(b.decrypt(old[1]), /replay/);
  await expectRejected(b.decrypt(fresh[2]), /replay/);
});

test('M4: tampered current and skipped ratchet frames do not consume keys', async () => {
  const { a, b } = await handshake();
  const messages = await Promise.all(['zero', 'one', 'two', 'three'].map((text) => a.encrypt(text)));
  await b.decrypt(messages[0]);
  const before = ratchetState(b);
  await expectRejected(b.decrypt(tamper(messages[3])));
  assertRatchetUnchanged(b, before);
  assertEquals(dec(await b.decrypt(messages[3])), 'three');
  const parked = ratchetState(b);
  await expectRejected(b.decrypt(tamper(messages[1])));
  assertRatchetUnchanged(b, parked);
  assertEquals(dec(await b.decrypt(messages[1])), 'one');
  assertEquals(dec(await b.decrypt(messages[2])), 'two');
  await expectRejected(b.decrypt(messages[1]), /replay/);
});

test('M4: ratchet rejects invalid n/pn and unavailable old counters without state changes', async () => {
  const { a, b } = await handshake();
  const messages = await Promise.all(['zero', 'one', 'two'].map((text) => a.encrypt(text)));
  const before = ratchetState(b);
  for (const field of ['n', 'pn']) {
    await Promise.all(invalidCounters.map((n) => expectRejected(
      b.decrypt({ ...messages[0], header: { ...messages[0].header, [field]: n } }),
      /nonnegative safe integer/,
    )));
  }
  assertRatchetUnchanged(b, before);
  await expectRejected(b.decrypt({ ...messages[0], header: { ...messages[0].header, n: MAX_SKIP + 1 } }), /skipped/);
  assertRatchetUnchanged(b, before);
  assertEquals(dec(await b.decrypt(messages[2])), 'two');
  // Model an old key no longer retained; it must not consume the current key.
  b.skipped.delete(`${messages[1].header.dh}:${messages[1].header.n}`);
  const settled = ratchetState(b);
  await expectRejected(b.decrypt(messages[1]), /old counter/);
  assertRatchetUnchanged(b, settled);
  assertEquals(dec(await b.decrypt(messages[0])), 'zero');
  assertEquals(dec(await b.decrypt(await a.encrypt('next'))), 'next');
});

test('M4: concurrent duplicate ratchet receives authenticate only once', async () => {
  const { a, b } = await handshake();
  const message = await a.encrypt('once');
  const results = await Promise.allSettled([b.decrypt(message), b.decrypt(message)]);
  assertEquals(results[0].status, 'fulfilled');
  assertEquals(dec(results[0].value), 'once');
  assertEquals(results[1].status, 'rejected');
  assert(/replay/.test(results[1].reason.message));
  assertEquals(dec(await b.decrypt(await a.encrypt('next'))), 'next');
});

test('M4: SenderChain serializes next/keyFor together and recovers after rejection', async () => {
  const seed = randomBytes(32);
  const send = new SenderChain(seed);
  const keys = await Promise.all(Array.from({ length: 12 }, () => send.next()));
  assertDeepEquals(keys.map((k) => k.n), Array.from({ length: 12 }, (_, n) => n));
  assertEquals(new Set(keys.map((k) => b64(k.messageKey))).size, keys.length);
  const receive = new SenderChain(seed);
  const order = [5, 0, 4, 1, 3, 2, 11, 6, 10, 7, 9, 8];
  const opened = await Promise.all(order.map((n) => receive.keyFor(n)));
  assertDeepEquals(opened.map(b64), order.map((n) => b64(keys[n].messageKey)));
  await expectRejected(receive.keyFor(0), /already used/);

  const mixed = new SenderChain(seed);
  const [zero, two, three, one] = await Promise.all([
    mixed.next(), mixed.keyFor(2), mixed.next(), mixed.keyFor(1),
  ]);
  assertEquals(zero.n, 0);
  assertEquals(three.n, 3);
  assertDeepEquals([zero.messageKey, one, two, three.messageKey].map(b64), keys.slice(0, 4).map((k) => b64(k.messageKey)));
  const before = chainState(mixed);
  await Promise.all(invalidCounters.map((n) => expectRejected(mixed.keyFor(n), /nonnegative safe integer/)));
  await expectRejected(mixed.keyFor(1), /already used/);
  await expectRejected(mixed.keyFor(mixed.n + MAX_SKIP + 1), /skipped/);
  assertChainUnchanged(mixed, before);
  assertEquals(b64((await mixed.next()).messageKey), b64(keys[4].messageKey));
});

test('M4: parallel group sends use distinct counters and keys; concurrent receives decrypt', async () => {
  const secret = randomBytes(32);
  const sender = await GroupSender.create(secret, 'group', 'epoch', 'alice');
  const receiver = new GroupReceiver(secret, 'group', 'epoch');
  const messages = await Promise.all(Array.from({ length: 12 }, () => sender.encrypt('same plaintext')));
  assertDeepEquals(messages.map((m) => m.n), Array.from({ length: 12 }, (_, n) => n));
  assertEquals(new Set(messages.map((m) => b64(unb64(m.ct).slice(0, -16)))).size, messages.length, 'group AEAD key/nonce reused');
  const opened = await Promise.all([...messages].reverse().map((m) => receiver.decrypt(m)));
  for (const plaintext of opened) assertEquals(dec(plaintext), 'same plaintext');
  await expectRejected(receiver.decrypt(messages[0]), /already used/);
  assertEquals(dec(await receiver.decrypt(await sender.encrypt('next'))), 'next');
});

test('M4: tampered first/new-sender group frames never install a chain', async () => {
  const secret = randomBytes(32);
  const receiver = new GroupReceiver(secret, 'group', 'epoch');
  for (const senderId of ['alice', 'bob']) {
    const sender = await GroupSender.create(secret, 'group', 'epoch', senderId);
    const first = await sender.encrypt(senderId);
    const size = receiver.chains.size;
    await expectRejected(receiver.decrypt(tamper(first)));
    assertEquals(receiver.chains.size, size);
    assert(!receiver.chains.has(senderId), 'unauthenticated chain was installed');
    assertEquals(dec(await receiver.decrypt(first)), senderId);
    await expectRejected(receiver.decrypt(first), /already used/);
  }
});

test('M4: tampered current/skipped group frames leave existing chain state intact', async () => {
  const secret = randomBytes(32);
  const sender = await GroupSender.create(secret, 'group', 'epoch', 'alice');
  const receiver = new GroupReceiver(secret, 'group', 'epoch');
  const messages = await Promise.all(['zero', 'one', 'two', 'three'].map((text) => sender.encrypt(text)));
  await receiver.decrypt(messages[0]);
  const chain = receiver.chains.get('alice');
  const before = chainState(chain);
  await expectRejected(receiver.decrypt(tamper(messages[3])));
  assertEquals(receiver.chains.get('alice'), chain);
  assertChainUnchanged(chain, before);
  assertEquals(dec(await receiver.decrypt(messages[3])), 'three');

  const parkedChain = receiver.chains.get('alice');
  const parked = chainState(parkedChain);
  await expectRejected(receiver.decrypt(tamper(messages[1])));
  assertEquals(receiver.chains.get('alice'), parkedChain);
  assertChainUnchanged(parkedChain, parked);
  const opened = await Promise.all([receiver.decrypt(messages[1]), receiver.decrypt(messages[2])]);
  assertDeepEquals(opened.map(dec), ['one', 'two']);
  await expectRejected(receiver.decrypt(messages[1]), /already used/);
});

test('M4: group invalid counters and concurrent replays fail without consuming authentic keys', async () => {
  const secret = randomBytes(32);
  const sender = await GroupSender.create(secret, 'group', 'epoch', 'alice');
  const receiver = new GroupReceiver(secret, 'group', 'epoch');
  const message = await sender.encrypt('once');
  await Promise.all(invalidCounters.map((n) => expectRejected(receiver.decrypt({ ...message, n }), /nonnegative safe integer/)));
  await expectRejected(receiver.decrypt({ ...message, n: MAX_SKIP + 1 }), /skipped/);
  assertEquals(receiver.chains.size, 0);
  const results = await Promise.allSettled([receiver.decrypt(message), receiver.decrypt(message)]);
  assertEquals(results[0].status, 'fulfilled');
  assertEquals(dec(results[0].value), 'once');
  assertEquals(results[1].status, 'rejected');
  assert(/already used/.test(results[1].reason.message));
  const chain = receiver.chains.get('alice');
  const before = chainState(chain);
  await expectRejected(receiver.decrypt({ ...message, n: -1 }), /nonnegative safe integer/);
  assertEquals(receiver.chains.get('alice'), chain);
  assertChainUnchanged(chain, before);
  assertEquals(dec(await receiver.decrypt(await sender.encrypt('next'))), 'next');
});

test('M8: the build produces an integrity manifest and checks one entry against the checked-in file', async () => {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    assert(true);
    return;
  }

  const builtManifestPath = new URL('../dist/.integrity-manifest.json', import.meta.url).href;
  let manifest = null;
  try {
    const res = await fetch(builtManifestPath);
    if (res.ok) manifest = await res.json();
  } catch {
    /* no build artifact checked out; skip the build-specific checks */
  }

  if (manifest) {
    assert(manifest.version === 1, 'manifest schema version');
    assert(Array.isArray(manifest.files) && manifest.files.length > 0, 'manifest lists files');
    assert(typeof manifest.rootHash === 'string' && manifest.rootHash.length === 64, 'manifest has root hash');
    assert(manifest.builtAt, 'manifest has a build timestamp');
    for (const entry of manifest.files) {
      assert(typeof entry.path === 'string', `${entry.path}: has path`);
      assert(typeof entry.sha256 === 'string' && entry.sha256.length === 64, `${entry.path}: has sha256`);
      assert(typeof entry.size === 'number', `${entry.path}: has size`);
    }
  }

  const ownBytes = new TextEncoder().encode(await (await fetch(import.meta.url)).text());
  const sha256 = async (bytes) => {
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const ourHash = await sha256(ownBytes);
  assert(ourHash === await sha256(ownBytes), 'a file hash recomputed from its bytes matches');

  const tampered = new Uint8Array(ownBytes);
  if (tampered.length >= 2) tampered[0] = (tampered[0] + 7) & 0xff;
  assert(
    (await sha256(tampered)) !== ourHash,
    'a tampered file produces a different hash (tamper-evidence reads out)',
  );
}, { needs: 'dom' });
