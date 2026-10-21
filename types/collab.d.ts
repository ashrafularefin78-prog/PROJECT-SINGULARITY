/** Type definitions for the collab modules. */
export declare class Mesh { constructor(...args: any[]); [key: string]: any; peers(): any[]; }
export declare class CiphertextRelay { constructor(...args: any[]); [key: string]: any; }
export declare class RelayCarrier { constructor(...args: any[]); [key: string]: any; status(): any; }
export declare class RtcCarrier { constructor(...args: any[]); [key: string]: any; }
export declare function planTopology(ids: any, options?: any): any;
export declare function neighbors(plan: any, id: any): any;
export declare function forwardTargets(plan: any, selfId: any, fromId?: any): any;
export declare function describeTopology(plan: any): any;
export declare const DEFAULT_ICE_SERVERS: any[];
export declare function turnServers(options?: any): any;
export declare function iceServersWithTurn(turn: any): any;
export declare function encodeSignal(kind: any, sdp: any): string;
export declare function decodeSignal(code: any): any;