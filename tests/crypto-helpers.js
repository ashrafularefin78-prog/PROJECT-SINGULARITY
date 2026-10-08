// Shared crypto test helpers. Two suites need a full X3DH handshake
// (crypto.test.js and fuzz.test.js), and a second copy of the handshake would
// drift out of step with the first the moment the protocol changes.
import {
  Identity,
  Ratchet,
  b64,
  exportDhPublic,
  unb64,
  x3dhInitiate,
  x3dhRespond,
} from '../src/crypto/e2ee.js';

export const dec = (bytes) => new TextDecoder().decode(bytes);

export const hexLocal = (bytes) =>
  Array.from(new Uint8Array(bytes))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

/** Run a full X3DH handshake and return both ratchets plus the identities. */
export async function handshake(names = ['alice', 'bob']) {
  const alice = await Identity.create(names[0]);
  const bob = await Identity.create(names[1]);
  await bob.createOneTimePrekeys(1);
  const opk = bob.oneTimePrekeys[0];
  const bundle = await bob.bundle(); // publishes the OPK, signed with the IK
  const aliceIk = b64(await exportDhPublic(alice.dhPair));
  const { root, epk } = await x3dhInitiate(alice, bundle);
  const bobRoot = await x3dhRespond(bob, aliceIk, epk, opk.pair);
  const a = await Ratchet.initiator(root, unb64(bundle.spk));
  const b = await Ratchet.responder(bobRoot, bob.spkPair);
  return { alice, bob, a, b, bundle, opk };
}
