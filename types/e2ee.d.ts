export declare const MAX_SKIP: number;
export declare const CHUNK_SIZE: number;
export declare const SEAL_MIN_ITERATIONS: number;
export declare const SEAL_DEFAULT_ITERATIONS: number;

export declare function randomBytes(n: number): Uint8Array;
export declare function concat(...arrays: ArrayLike<number>[]): Uint8Array;
export declare function b64(bytes: ArrayLike<number>): string;
export declare function unb64(str: string): Uint8Array;
export declare function hex(bytes: ArrayLike<number>): string;
export declare function sha256(bytes: ArrayLike<number>): Promise<Uint8Array>;
export declare function hkdf(ikm: ArrayLike<number>, salt: ArrayLike<number> | null, info: ArrayLike<number> | string, len?: number): Promise<Uint8Array>;
export declare function dhVariantInfo(): Promise<any>;
export declare function generateDhPair(): Promise<any>;
export declare function exportDhPublic(keyOrPair: any): Promise<Uint8Array>;
export declare function toBytes(value: any): Uint8Array;
export declare function importDhPublic(raw: ArrayLike<number>): Promise<any>;
export declare function dh(privPair: any, pubKey: any): Promise<Uint8Array>;
export declare function generateSignPair(): Promise<any>;
export declare function sign(signPair: any, data: ArrayLike<number>): Promise<Uint8Array>;
export declare function verify(signPair: any, sig: ArrayLike<number>, data: ArrayLike<number>): Promise<boolean>;
export declare function exportSignPublic(keyPair: any): Promise<Uint8Array>;
export declare function importSignPublic(raw: ArrayLike<number>): Promise<any>;
export declare function aeadEncrypt(messageKey: any, plaintext: ArrayLike<number>, aad?: ArrayLike<number>): Promise<Uint8Array>;
export declare function aeadDecrypt(messageKey: any, ciphertext: ArrayLike<number>, aad?: ArrayLike<number>): Promise<Uint8Array>;
export declare function safetyNumber(pubA: ArrayLike<number>, pubB: ArrayLike<number>): Promise<string>;
export declare function formatSafetyNumber(digits: string): string;
export declare function rotateGroupEpoch(prevSecret: any, contributions: any[]): Promise<any>;
export declare function createGroupEpoch(contributions: any[]): Promise<any>;
export declare function encryptFile(secret: any, bytes: ArrayLike<number>, chunkSize?: number): Promise<any[]>;
export declare function encryptStream(secret: any, source: any, chunkSize?: number): AsyncIterable<any>;
export declare function decryptStream(secret: any, frames: any): AsyncIterable<Uint8Array>;
export declare function decryptFile(secret: any, frames: any[]): Promise<Uint8Array>;
export declare function exportIdentityPrivate(identity: any): Promise<Uint8Array>;
export declare function importIdentityPrivate(bytes: ArrayLike<number>, name?: string): Promise<any>;
export declare function derivePassphraseKey(passphrase: string, salt: ArrayLike<number>, iterations?: number): Promise<any>;
export declare function sealPrivateKeys(identity: any, passphrase: string, iterations?: number): Promise<any>;
export declare function openPrivateKeys(sealed: any, passphrase: string, name?: string): Promise<any>;
export declare function verifyBundleWith(bundle: any, verifyKey: any): boolean;
export declare function x3dhInitiate(identity: any, bundle: any): Promise<any>;
export declare function x3dhRespond(identity: any, initiatorIkPub: any, ephemeralPub: any, oneTimePair?: any): Promise<any>;

export declare class Identity {
  constructor(name?: string);
  name: string;
  [key: string]: any;
  static generate(name?: string): Promise<Identity>;
}

export declare class Ratchet {
  constructor(...args: any[]);
  [key: string]: any;
}

export declare class SenderChain {
  constructor(...args: any[]);
  [key: string]: any;
}

export declare class GroupSender {
  constructor(...args: any[]);
  [key: string]: any;
}

export declare class GroupReceiver {
  constructor(...args: any[]);
  [key: string]: any;
}

export declare class ChunkEncryptor {
  constructor(...args: any[]);
  [key: string]: any;
}
