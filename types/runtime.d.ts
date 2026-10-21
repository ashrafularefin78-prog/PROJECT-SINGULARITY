/** Type definitions for the runtime modules. */
export declare class CompileError extends Error {}
export declare const KEYWORDS: Set<string>;
export declare const TYPE_KEYWORDS: Set<string>;
export declare function tokenize(source: any, options?: any): any;
export declare function parse(source: any): any;
export declare function formatPrintf(fmt: any, args: any): string;
export declare class Runtime {
  constructor(...args: any[]);
  [key: string]: any;
}
export declare function interpret(source: any, options?: any): any;
export declare class Preprocessor {
  constructor(...args: any[]);
  [key: string]: any;
}
export declare class Sandbox {
  constructor(...args: any[]);
  [key: string]: any;
}
export declare function evalIfExpression(...args: any[]): any;
export declare function joinContinuations(...args: any[]): any;