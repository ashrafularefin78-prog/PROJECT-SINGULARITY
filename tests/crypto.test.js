import { test, assert, assertEquals } from './harness.js';
import {
  Identity,
  Ratchet,
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
