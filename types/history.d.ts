import type { RGA, RgaOp } from './rga.d.ts';

export interface ReplayStep {
  ops: number;
  text: string;
  digest: string;
  buffered: number;
}

export interface ReplayOrder {
  digest: string;
  chars: number;
  buffered: number;
}

export interface ReplayReport {
  ops: number;
  agree: boolean;
  digest: string;
  buffered: number;
  orders: {
    forward: ReplayOrder;
    reverse: ReplayOrder;
    shuffled: ReplayOrder;
  };
}

/** Canonical serialization of the visible state: ids, order and text. */
export function canonicalState(rga: RGA): string;

/** 16-hex-character structural fingerprint of the visible state. */
export function stateDigest(rga: RGA): string;

/** Rebuild the state produced by the first `upTo` ops of `log`. */
export function replayTo(log: RgaOp[], upTo?: number): ReplayStep;

/** Seeded, non-mutating permutation used by the order-independence proof. */
export function shuffleOps(log: RgaOp[], seed?: number): RgaOp[];

/** Replay the log forward, reversed and shuffled; `agree` requires one digest. */
export function replayReport(log: RgaOp[], options?: { seed?: number }): ReplayReport;
