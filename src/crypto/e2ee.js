/**
 * M4 - End-to-end encrypted layer. WebCrypto only. No third-party primitives,
 * no invented cryptography: we compose standard primitives with explicit,
 * documented domain separation.
 *
 * Composition
 *   Identity      X25519 (ECDH) identity key + Ed25519 signing key
 *                 (falls back to P-256 ECDH / ECDSA where X25519/Ed25519 are
 *                  unavailable - the API surface is identical)
 *   Key agreement X3DH: DH(IK_a,SPK_b) || DH(EK_a,IK_b) || DH(EK_a,SPK_b)
 *                 || DH(EK_a,OPK_b) -> HKDF-SHA256 -> root key
 *   Messages      Double Ratchet: DH ratchet (post-compromise security) +
 *                 symmetric chain (forward secrecy) + skipped-message keys
 *   AEAD          AES-256-GCM. The per-message nonce is *derived* from the
 *                 unique message key, never reused: [key||iv] = HKDF(mk).
 *   Groups        Sender-key style epochs; join/leave/kick rotate the epoch
 *                 secret so a removed member cannot read later traffic.
 *   Files         2 GB+ chunked streaming: one AEAD frame per 256 KiB chunk,
 *                 counter nonces, AAD binds stream id + index + final flag.
 *
 * Threat notes / explicit non-goals are in docs/THREAT_MODEL.md.
 */

const subtle = () => globalThis.crypto.subtle;
const TEXT = new TextEncoder();

export const MAX_SKIP = 1000; // skipped-message-key DoS bound
export const CHUNK_SIZE = 256 * 1024;

// ------------------------------------------------------------------ utilities

/** CSPRNG bytes. getRandomValues caps at 65536 bytes per call, so we loop. */
export function randomBytes(n) {
  const b = new Uint8Array(n);
  const MAX = 65536;
  for (let off = 0; off < n; off += MAX) {
    globalThis.crypto.getRandomValues(b.subarray(off, Math.min(off + MAX, n)));
  }
  return b;
}

export function concat(...arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function b64(bytes) {
  let s = '';
  const b = new Uint8Array(bytes);
  for (let i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function unb64(str) {
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function hex(bytes) {
  return Array.from(new Uint8Array(bytes))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

/** HKDF-SHA256 as a thin, explicit wrapper (no hand-rolled KDF). */
export async function hkdf(ikm, salt, info, len = 32) {
  const key = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: TEXT.encode(info) },
    key,
    len * 8,
  );
  return new Uint8Array(bits);
}

async function hmac(keyBytes, data) {
  const key = await subtle().importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', key, data));
}

// --------------------------------------------------------- primitive adapters

let dhVariant = null;

/** Pick X25519, falling back to NIST P-256 ECDH. Cached after first probe. */
export async function dhVariantInfo() {
  if (dhVariant) return dhVariant;
  try {
    await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
    dhVariant = { name: 'X25519', bits: 256, alg: { name: 'X25519' } };
  } catch {
    dhVariant = { name: 'ECDH-P256', bits: 256, alg: { name: 'ECDH', namedCurve: 'P-256' } };
  }
  return dhVariant;
}

export async function generateDhPair() {
  const v = await dhVariantInfo();
  return subtle().generateKey(v.alg, true, ['deriveBits']);
}

/** Accepts either a CryptoKeyPair or a bare public CryptoKey. */
export async function exportDhPublic(keyOrPair) {
  const key = keyOrPair && keyOrPair.publicKey ? keyOrPair.publicKey : keyOrPair;
  return new Uint8Array(await subtle().exportKey('raw', key));
}

/** Accepts raw bytes or a base64 string. */
export function toBytes(value) {
  return typeof value === 'string' ? unb64(value) : value;
}

export async function importDhPublic(raw) {
  const v = await dhVariantInfo();
  return subtle().importKey('raw', toBytes(raw), v.alg, true, []);
}

export async function dh(privPair, pubKey) {
  const v = await dhVariantInfo();
  const bits = await subtle().deriveBits({ ...v.alg, public: pubKey }, privPair.privateKey, v.bits);
  return new Uint8Array(bits);
}

let signVariant = null;

async function signVariantInfo() {
  if (signVariant) return signVariant;
  try {
    await subtle().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    signVariant = { name: 'Ed25519', sign: { name: 'Ed25519' }, verify: { name: 'Ed25519' } };
  } catch {
    signVariant = {
      name: 'ECDSA-P256',
      sign: { name: 'ECDSA', hash: 'SHA-256' },
      verify: { name: 'ECDSA', hash: 'SHA-256' },
    };
  }
  return signVariant;
}

export async function generateSignPair() {
  const v = await signVariantInfo();
  const alg = v.name === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
  return subtle().generateKey(alg, true, ['sign', 'verify']);
}

export async function sign(signPair, data) {
  const v = await signVariantInfo();
  return new Uint8Array(await subtle().sign(v.sign, signPair.privateKey, data));
}

export async function verify(signPair, sig, data) {
  const v = await signVariantInfo();
  return subtle().verify(v.verify, signPair.publicKey, sig, data);
}

export async function exportSignPublic(keyPair) {
  return new Uint8Array(await subtle().exportKey('raw', keyPair.publicKey));
}

export async function importSignPublic(raw) {
  const v = await signVariantInfo();
  const alg = v.name === 'Ed25519' ? { name: 'Ed25519' } : { name: 'ECDSA', namedCurve: 'P-256' };
  return subtle().importKey('raw', toBytes(raw), alg, true, ['verify']);
}

// ------------------------------------------------------------------ AEAD

/** [aesKey(32) || nonce(12)] derived from an already-unique message key. */
async function aeadFromMessageKey(messageKey) {
  const material = await hkdf(messageKey, new Uint8Array(32), 'Singularity|AEAD|v1', 44);
  const key = await subtle().importKey('raw', material.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, nonce: material.slice(32, 44) };
}

export async function aeadEncrypt(messageKey, plaintext, aad) {
  const { key, nonce } = await aeadFromMessageKey(messageKey);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, plaintext);
  return new Uint8Array(ct);
}

export async function aeadDecrypt(messageKey, ciphertext, aad) {
  const { key, nonce } = await aeadFromMessageKey(messageKey);
  const pt = await subtle().decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, key, ciphertext);
  return new Uint8Array(pt);
}

// ------------------------------------------------------------------ identity

export class Identity {
  constructor(name, dhPair, signPair) {
    this.name = name;
    this.dhPair = dhPair;
    this.signPair = signPair;
    this.spkPair = null;
    this.oneTimePrekeys = [];
    this._spkIndex = 0;
  }

  static async create(name = 'anon') {
    const id = new Identity(name, await generateDhPair(), await generateSignPair());
    await id.rotateSignedPrekey();
    return id;
  }

  /** Signed prekey rotation (SPK is used as the responder's first ratchet key). */
  async rotateSignedPrekey() {
    this.spkPair = await generateDhPair();
    const spkPub = await exportDhPublic(this.spkPair);
    this.spkSig = await sign(this.signPair, concat(TEXT.encode('Singularity|SPK|v1'), spkPub));
    return this.spkPair;
  }

  async createOneTimePrekeys(n = 5) {
    for (let i = 0; i < n; i += 1) {
      const pair = await generateDhPair();
      this.oneTimePrekeys.push({ id: `${this.name}-${this._spkIndex++}`, pair });
    }
    return this.oneTimePrekeys;
  }

  /** Exactly what the untrusted server is allowed to hand out: public bytes. */
  async bundle() {
    if (!this.oneTimePrekeys.length) await this.createOneTimePrekeys(3);
    const opk = this.oneTimePrekeys.shift();
    return {
      name: this.name,
      ik: b64(await exportDhPublic(this.dhPair)),
      spk: b64(await exportDhPublic(this.spkPair)),
      spkSig: b64(this.spkSig),
      opk: opk ? { id: opk.id, key: b64(await exportDhPublic(opk.pair)) } : null,
      sign: b64(await exportSignPublic(this.signPair)),
    };
  }

  /** Local verification that a bundle really is signed by the claimed identity. */
  async verifyBundle(bundle) {
    const ourVk = this.signPair.publicKey;
    const spkPub = unb64(bundle.spk);
    const ok = await verify(
      { publicKey: ourVk },
      unb64(bundle.spkSig),
      concat(TEXT.encode('Singularity|SPK|v1'), spkPub),
    );
    return ok;
  }
}

export function verifyBundleWith(bundle, verifyKey) {
  const spkPub = unb64(bundle.spk);
  return verify(
    { publicKey: verifyKey },
    unb64(bundle.spkSig),
    concat(TEXT.encode('Singularity|SPK|v1'), spkPub),
  );
}

// ------------------------------------------------------------------- X3DH

const X3DH_INFO = 'Singularity|X3DH|v1';

/**
 * Sender side of X3DH. Returns the root key plus the ephemeral public key that
 * must travel with the first message.
 */
export async function x3dhInitiate(identity, bundle) {
  const ikB = await importDhPublic(unb64(bundle.ik));
  const spkB = await importDhPublic(unb64(bundle.spk));
  const ekPair = await generateDhPair();
  const parts = [
    new Uint8Array(32), // 32 zero bytes: X3DH's domain separator for curve 25519
    await dh(identity.dhPair, spkB),
    await dh(ekPair, ikB),
    await dh(ekPair, spkB),
  ];
  if (bundle.opk) parts.push(await dh(ekPair, await importDhPublic(unb64(bundle.opk.key))));
  const root = await hkdf(concat(...parts), new Uint8Array(32), X3DH_INFO, 32);
  return { root, epk: b64(await exportDhPublic(ekPair)), opkId: bundle.opk ? bundle.opk.id : null };
}

/** Receiver side of X3DH: must supply the matching private keys. */
export async function x3dhRespond(identity, initiatorIkPub, ephemeralPub, oneTimePair) {
  const ikA = await importDhPublic(unb64(initiatorIkPub));
  const ekA = await importDhPublic(unb64(ephemeralPub));
  const parts = [
    new Uint8Array(32),
    await dh(identity.spkPair, ikA),
    await dh(identity.dhPair, ekA),
    await dh(identity.spkPair, ekA),
  ];
  if (oneTimePair) parts.push(await dh(oneTimePair, ekA));
  return hkdf(concat(...parts), new Uint8Array(32), X3DH_INFO, 32);
}

// ------------------------------------------------------------ double ratchet

const RATCHET_INFO = 'Singularity|Ratchet|v1';

async function kdfRoot(rootKey, dhOut) {
  const out = await hkdf(dhOut, rootKey, RATCHET_INFO, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

async function kdfChain(chainKey) {
  const messageKey = await hmac(chainKey, new Uint8Array([1]));
  const nextChainKey = await hmac(chainKey, new Uint8Array([2]));
  return [nextChainKey, messageKey];
}

const headerAad = (h) => TEXT.encode(`Singularity|DR|v1|${h.dh}|${h.pn}|${h.n}`);

export class Ratchet {
  constructor() {
    this.rootKey = null;
    this.dhSelf = null;
    this.dhRemote = null;
    this.ckSend = null;
    this.ckRecv = null;
    this.nSend = 0;
    this.nRecv = 0;
    this.pn = 0;
    this.skipped = new Map();
    this.usedMessageKeys = new Set();
  }

  /** Alice: after X3DH, ratchet immediately against Bob's signed prekey. */
  static async initiator(rootKey, remoteSpkPub) {
    const r = new Ratchet();
    r.rootKey = rootKey;
    r.dhSelf = await generateDhPair();
    r.dhRemote = await importDhPublic(remoteSpkPub);
    const [rk, ck] = await kdfRoot(r.rootKey, await dh(r.dhSelf, r.dhRemote));
    r.rootKey = rk;
    r.ckSend = ck;
    return r;
  }

  /** Bob: his signed prekey pair is the initial ratchet key. */
  static async responder(rootKey, spkPair) {
    const r = new Ratchet();
    r.rootKey = rootKey;
    r.dhSelf = spkPair;
    return r;
  }

  async encrypt(plaintext) {
    if (!this.ckSend) throw new Error('ratchet has no sending chain yet');
    const [next, messageKey] = await kdfChain(this.ckSend);
    this.ckSend = next;
    const header = { dh: b64(await exportDhPublic(this.dhSelf)), pn: this.pn, n: this.nSend };
    const data = typeof plaintext === 'string' ? TEXT.encode(plaintext) : plaintext;
    const ct = await aeadEncrypt(messageKey, data, headerAad(header));
    this.nSend += 1;
    return { header, ct: b64(ct) };
  }

  async decrypt(message) {
    const { header } = message;
    const key = `${header.dh}:${header.n}`;
    if (this.usedMessageKeys.has(key)) throw new Error('message key already used (replay)');

    let messageKey = this.skipped.get(key);
    if (messageKey) {
      this.skipped.delete(key);
    } else {
      // A new remote ratchet key means a new DH ratchet step is due.
      if (!this.ckRecv || header.dh !== (await this._remoteB64())) {
        await this._skipMessageKeys(header.pn);
        await this._dhRatchet(header.dh);
      }
      await this._skipMessageKeys(header.n);
      const [next, mk] = await kdfChain(this.ckRecv);
      this.ckRecv = next;
      this.nRecv += 1;
      messageKey = mk;
    }

    const plaintext = await aeadDecrypt(messageKey, unb64(message.ct), headerAad(header));
    this.usedMessageKeys.add(key);
    return plaintext;
  }

  async _remoteB64() {
    return this.dhRemote ? b64(await exportDhPublic(this.dhRemote)) : '';
  }

  async _dhRatchet(remotePubB64) {
    this.pn = this.nSend;
    this.nSend = 0;
    this.nRecv = 0;
    this.dhRemote = await importDhPublic(unb64(remotePubB64));
    const [rk1, ckr] = await kdfRoot(this.rootKey, await dh(this.dhSelf, this.dhRemote));
    this.rootKey = rk1;
    this.ckRecv = ckr;
    this.dhSelf = await generateDhPair();
    const [rk2, cks] = await kdfRoot(this.rootKey, await dh(this.dhSelf, this.dhRemote));
    this.rootKey = rk2;
    this.ckSend = cks;
  }

  async _skipMessageKeys(until) {
    if (!this.ckRecv) return; // no receiving chain yet: nothing to skip
    if (until - this.nRecv > MAX_SKIP) throw new Error('too many skipped messages');
    while (this.nRecv < until) {
      const [next, mk] = await kdfChain(this.ckRecv);
      this.ckRecv = next;
      const remote = await this._remoteB64();
      this.skipped.set(`${remote}:${this.nRecv}`, mk);
      this.nRecv += 1;
    }
  }
}

// ------------------------------------------------------------ safety numbers

/**
 * Signal-style safety number: both parties compute the same 60 digits from the
 * pair of identity keys (sorted) and compare them out of band.
 */
export async function safetyNumber(pubA, pubB) {
  const a = typeof pubA === 'string' ? pubA : b64(pubA);
  const b = typeof pubB === 'string' ? pubB : b64(pubB);
  const [x, y] = a <= b ? [a, b] : [b, a];
  const digest = await sha256(TEXT.encode(`Singularity|SafetyNumber|v1|${x}|${y}`));
  let digits = '';
  for (let i = 0; i < 12; i += 1) {
    const chunk = digest.slice(i * 2, i * 2 + 2);
    const n = ((chunk[0] << 8) | chunk[1]) % 100000;
    digits += String(n).padStart(5, '0');
  }
  return digits;
}

export function formatSafetyNumber(digits) {
  return digits.match(/.{1,5}/g).join(' ');
}

// ------------------------------------------------------------------- groups

/**
 * Per-sender symmetric chain. Each (epoch, sender) pair gets its own chain, and
 * every message number consumes a distinct message key - which keeps the AEAD
 * nonce unique by construction.
 */
export class SenderChain {
  constructor(chainKey, n = 0) {
    this.chainKey = chainKey;
    this.n = n;
    this.skipped = new Map();
  }

  static async create(epochSecret, senderId) {
    const chainKey = await hkdf(epochSecret, new Uint8Array(32), `Singularity|SenderKey|${senderId}`, 32);
    return new SenderChain(chainKey, 0);
  }

  /**
   * Receiving side: return the key for message number `n`, parking the keys of
   * any messages we jumped over so out-of-order delivery still decrypts.
   */
  async keyFor(n) {
    const parked = this.skipped.get(n);
    if (parked) {
      this.skipped.delete(n);
      return parked;
    }
    if (n < this.n) throw new Error(`message key ${n} was already used (replay?)`);
    if (n - this.n > MAX_SKIP) throw new Error('too many skipped group messages');
    while (this.n < n) {
      const [next, mk] = await kdfChain(this.chainKey);
      this.chainKey = next;
      this.skipped.set(this.n, mk);
      this.n += 1;
    }
    const [next, mk] = await kdfChain(this.chainKey);
    this.chainKey = next;
    this.n += 1;
    return mk;
  }

  /** Sending side: consume the next key in the chain. */
  async next() {
    const [next, mk] = await kdfChain(this.chainKey);
    this.chainKey = next;
    const n = this.n;
    this.n += 1;
    return { n, messageKey: mk };
  }
}

/**
 * Rotate a group epoch secret. Every remaining member contributes fresh
 * randomness, so a member removed in this step cannot derive the new epoch
 * (they know the old secret and all old contributions).
 */
export async function rotateGroupEpoch(prevSecret, contributions) {
  if (!contributions.length) throw new Error('an epoch rotation needs at least one contributor');
  const ikm = concat(prevSecret, ...contributions.map((c) => unb64(c)));
  return hkdf(ikm, new Uint8Array(32), 'Singularity|GroupEpoch|v1', 32);
}

export async function createGroupEpoch(contributions) {
  if (!contributions.length) throw new Error('a group needs at least one member');
  return hkdf(concat(...contributions.map((c) => unb64(c))), new Uint8Array(32), 'Singularity|GroupEpoch|v1', 32);
}

const groupAad = (m) => TEXT.encode(`Singularity|Group|v1|${m.groupId}|${m.epochId}|${m.senderId}|${m.n}`);

/** Sending half of a group epoch. One instance per (epoch, group, member). */
export class GroupSender {
  static async create(epochSecret, groupId, epochId, senderId) {
    const s = new GroupSender();
    s.epochSecret = epochSecret;
    s.groupId = groupId;
    s.epochId = epochId;
    s.senderId = senderId;
    s.chain = await SenderChain.create(epochSecret, senderId);
    return s;
  }

  async encrypt(plaintext) {
    const { n, messageKey } = await this.chain.next();
    const material = await hkdf(messageKey, new Uint8Array(32), 'Singularity|AEAD|v1', 44);
    const key = await subtle().importKey('raw', material.slice(0, 32), 'AES-GCM', false, ['encrypt']);
    const message = {
      groupId: this.groupId,
      epochId: this.epochId,
      senderId: this.senderId,
      n,
    };
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv: material.slice(32, 44), additionalData: groupAad(message) },
      key,
      typeof plaintext === 'string' ? TEXT.encode(plaintext) : plaintext,
    );
    return { ...message, ct: b64(new Uint8Array(ct)) };
  }
}

/** Receiving half: keeps one advancing chain per sender in the current epoch. */
export class GroupReceiver {
  constructor(epochSecret, groupId, epochId) {
    this.epochSecret = epochSecret;
    this.groupId = groupId;
    this.epochId = epochId;
    this.chains = new Map();
  }

  async decrypt(message) {
    if (message.epochId !== this.epochId) throw new Error('message from a different epoch');
    if (message.groupId !== this.groupId) throw new Error('message from a different group');
    let chain = this.chains.get(message.senderId);
    if (!chain) {
      chain = await SenderChain.create(this.epochSecret, message.senderId);
      this.chains.set(message.senderId, chain);
    }
    const messageKey = await chain.keyFor(message.n);
    const material = await hkdf(messageKey, new Uint8Array(32), 'Singularity|AEAD|v1', 44);
    const key = await subtle().importKey('raw', material.slice(0, 32), 'AES-GCM', false, ['decrypt']);
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: material.slice(32, 44), additionalData: groupAad(message) },
      key,
      unb64(message.ct),
    );
    return new Uint8Array(pt);
  }
}

// ------------------------------------------------------- chunked file stream

/**
 * Streaming AEAD for large files: one independent frame per chunk with a
 * counter nonce, so memory stays bounded (O(chunk) not O(file)) and every
 * chunk is individually authenticated and order-bound.
 */
export class ChunkEncryptor {
  constructor(keyBytes, streamId) {
    this.streamId = streamId; // null on the decrypting side: adopted from frame 0
    this.counter = 0;
    this._keyPromise = subtle().importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  /** Encrypting side: fresh 8-byte stream id, so nonces never repeat per file. */
  static async fromSecret(secret) {
    const keyBytes = await hkdf(secret, new Uint8Array(32), 'Singularity|FileKey|v1', 32);
    return new ChunkEncryptor(keyBytes, randomBytes(8));
  }

  /** Decrypting side: adopts the stream id from the first frame it sees. */
  static async openFromSecret(secret) {
    const keyBytes = await hkdf(secret, new Uint8Array(32), 'Singularity|FileKey|v1', 32);
    return new ChunkEncryptor(keyBytes, null);
  }

  _nonce(counter) {
    const n = new Uint8Array(12);
    n.set(this.streamId, 0);
    n[8] = (counter / 2 ** 24) & 0xff;
    n[9] = (counter >>> 16) & 0xff;
    n[10] = (counter >>> 8) & 0xff;
    n[11] = counter & 0xff;
    return n;
  }

  _aad(counter, final) {
    return concat(this.streamId, new Uint8Array([counter & 0xff, final ? 1 : 0]));
  }

  async pushChunk(chunk, { final = false } = {}) {
    const key = await this._keyPromise;
    const counter = this.counter;
    this.counter += 1;
    const ct = await subtle().encrypt(
      { name: 'AES-GCM', iv: this._nonce(counter), additionalData: this._aad(counter, final) },
      key,
      chunk,
    );
    return { streamId: b64(this.streamId), n: counter, final, ct: b64(new Uint8Array(ct)) };
  }

  /**
   * Decrypt one frame. Frames are strictly ordered: the stream id is pinned by
   * the first frame, the index must be the next expected one, and the AAD binds
   * both the index and the final flag. Any swap, drop or splice fails closed.
   */
  async openFrame(frame) {
    if (this.streamId === null) {
      this.streamId = unb64(frame.streamId);
    } else if (frame.streamId !== b64(this.streamId)) {
      throw new Error('frame belongs to another stream');
    }
    if (frame.n !== this.counter) {
      throw new Error(`frame out of order: expected ${this.counter}, got ${frame.n}`);
    }
    const key = await this._keyPromise;
    const pt = await subtle().decrypt(
      { name: 'AES-GCM', iv: this._nonce(frame.n), additionalData: this._aad(frame.n, frame.final) },
      key,
      unb64(frame.ct),
    );
    this.counter += 1;
    return new Uint8Array(pt);
  }
}

/** Convenience helper for tests/demos; production code streams frame by frame. */
export async function encryptFile(secret, bytes, chunkSize = CHUNK_SIZE) {
  const enc = await ChunkEncryptor.fromSecret(secret);
  const frames = [];
  for (let off = 0; off < bytes.length; off += chunkSize) {
    const chunk = bytes.slice(off, Math.min(off + chunkSize, bytes.length));
    frames.push(await enc.pushChunk(chunk, { final: off + chunkSize >= bytes.length }));
  }
  return frames;
}

export async function decryptFile(secret, frames) {
  const dec = await ChunkEncryptor.openFromSecret(secret);
  const parts = [];
  for (const frame of frames) parts.push(await dec.openFrame(frame));
  return concat(...parts);
}
