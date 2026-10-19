export declare const DB_NAME: string;
export declare const DB_VERSION: number;
export declare const MIGRATIONS: Array<(db: IDBDatabase, tx?: IDBTransaction) => void>;

export declare function openDatabase(name?: string, version?: number): Promise<IDBDatabase>;

export interface LocalStore {
  db: IDBDatabase | null;
  memory: any;
  persistent: boolean;
  reason?: string;
  appendOps(docId: string, ops: any[]): Promise<number>;
  loadOps(docId: string): Promise<any[]>;
  countOps(docId: string): Promise<number>;
  compact(docId: string, snapshotText: string): Promise<boolean>;
  saveDoc(docId: string, text: string): Promise<boolean>;
  loadDoc(docId: string): Promise<{ id: string; text: string; at: number } | null>;
  setMeta(key: string, value: any): Promise<boolean>;
  getMeta(key: string, fallback?: any): Promise<any>;
  putFileFrame(frame: any): Promise<boolean>;
  listFileFrames(streamId: string): Promise<any[]>;
  estimate(): Promise<{ usage: number; quota: number; supported: boolean }>;
  requestPersistence(): Promise<boolean>;
  close(): void;
}

export declare function openLocalStore(name?: string): Promise<LocalStore>;
