export type RgaId = [number, string];

export interface RgaOp {
  t: 'ins' | 'del' | 'undel';
  id: RgaId;
  o?: RgaId | null;
  c?: string;
  ts?: number;
}

export function compareId(a: RgaId, b: RgaId): number;
export function idKey(id: RgaId): string;

export class RGA {
  constructor(replica?: string);
  replica: string;
  clock: number;
  nodes: Map<string, any>;
  head: any;
  tail: any;
  visible: number;
  tombstones: number;
  log: RgaOp[];
  logTrimmed: number;
  walkSteps: number;
  undoStack: any[];
  redoStack: any[];
  localInsert(index: number, text: string): RgaOp[];
  localDelete(index: number, count: number): RgaOp[];
  undo(): RgaOp[];
  redo(): RgaOp[];
  apply(op: RgaOp): boolean;
  merge(ops: RgaOp[]): number;
  text(): string;
  nodeAtVisible(index: number): any;
  visibleIndexOf(id: RgaId): number;
  stats(): {
    visible: number;
    tombstones: number;
    items: number;
    buffered: number;
    ops: number;
    clock: number;
    reclaimed: number;
    seenPruned: number;
    seen: number;
    logTrimmed: number;
  };
  collect(options?: { safeTs?: number; pruneSeen?: boolean }): number;
  static safeWatermark(peerClocks?: number[]): number;
  trimLog(keep?: number): number;
}
