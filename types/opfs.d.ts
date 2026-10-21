/** Browser- and Node-facing shape of a parsed OPFS batch file. */
export interface OpfsBatch {
  seq: number;
  at: string;
  ops: any[];
}

export interface OpfsSnapshot {
  text: string;
  at: string | null;
  ops: number;
}

export interface OpfsState {
  supported: boolean;
  error: string | null;
  seq: number;
  batches: number;
  bytes: number;
  lastWriteAt: number | null;
}

export interface OpfsMirrorStatus {
  supported: boolean;
  available: boolean;
  batches: number;
  bytes: number;
  snapshot: boolean;
  seq: number;
  error: string | null;
}

export interface OpfsMirror {
  state: OpfsState;

  appendBatch(docId: string, ops: any[]): Promise<number>;
  writeSnapshot(docId: string, docText: string, opCount?: number): Promise<boolean>;
  readSnapshot(docId: string): Promise<OpfsSnapshot | null>;
  readBatches(docId: string): Promise<{ ops: any[]; batches: number; corrupt: number }>;
  pruneBatches(docId: string, keep?: number): Promise<number>;
  removeDoc(docId: string): Promise<boolean>;
  status(docId: string): Promise<OpfsMirrorStatus>;
}

export declare const OPFS_ROOT: string;

export declare function safeDocId(docId: any): string;
export declare function batchFileName(seq: number): string;
export declare function parseBatch(text: string): OpfsBatch | null;
export declare function parseSnapshot(text: string): OpfsSnapshot | null;
export declare function opfsSupported(scope?: any): boolean;
export declare function openOpfsMirror(scope?: any): Promise<OpfsMirror>;
