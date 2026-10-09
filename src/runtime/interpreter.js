/**
 * M2 - In-browser C compiler: stage 3, the interpreter.
 *
 * Executes the AST with hard resource budgets, which is what makes "infinite
 * loops must be killable instantly" a guarantee rather than a hope:
 *   - step budget      : every statement and expression node costs one step
 *   - heap budget      : array allocations are charged against a byte cap
 *   - recursion depth  : bounded call stack
 * Plus the whole thing runs inside a Web Worker that the main thread can
 * terminate() at any moment (see src/runtime/worker.js).
 */
import { CompileError } from './lexer.js';
import { parse } from './parser.js';

class ReturnSignal {
  constructor(value) {
    this.value = value;
  }
}
class ExitSignal {}

const BREAK = { break: true };
const CONTINUE = { continue: true };

class Ref {
  constructor(get, set) {
    this.get = get;
    this.set = set;
  }
}

class Env {
  constructor(parent = null) {
    this.vars = new Map();
    this.parent = parent;
  }

  declare(name, entry) {
    this.vars.set(name, entry);
  }

  resolve(name) {
    let e = this;
    while (e) {
      if (e.vars.has(name)) return e;
      e = e.parent;
    }
    return null;
  }
}

/**
 * Heap pointers and struct values are plain objects carrying a hidden marker,
 * so they can travel through the same environment as numbers and strings.
 */
const isPtr = (v) => !!v && typeof v === 'object' && v.__ptr === true;
const isStruct = (v) => !!v && typeof v === 'object' && typeof v.__struct === 'string';
const isUnion = (v) => isStruct(v) && v.__union === true;

/**
 * A union value is a record whose storage is one shared buffer, so writing
 * `u.i` and reading `u.c` sees the same bytes - the point of a union. A union
 * carries `__struct` as well, which keeps every other part of the runtime
 * (sizeof, member lookup, truthiness) working on it unchanged.
 */
const unionBytes = (buf, field) => {
  const dv = new DataView(buf);
  if (field.base === 'char') return dv.getUint8(0);
  if (field.base === 'float') return dv.getFloat32(0, true);
  return dv.getInt32(0, true);
};

/** The integer a pointer (or a local address) stands for in a comparison. */
const ptrValue = (v) =>
  isPtr(v) ? (v.isNull ? 0 : v.offset) : isView(v) ? 1 + v.i : v instanceof Ref ? 1 : v;

/** A null pointer: no arena offset, no extent, and false in a condition. */
/**
 * A pointer carries its own `base` and `size` as well as the current `offset`,
 * so `p + 5` can never escape the allocation's bounds check: the limits stay
 * pinned to the block that malloc handed out.
 */
const makePtr = (offset, elem = 4, structName = null, size = 0) => ({
  __ptr: true,
  base: offset,
  offset,
  elem,
  struct: structName,
  size,
  isNull: offset === 0 && size === 0,
});

/**
 * A pointer into a local array - what `strchr(s, 'o')`, `&s[3]` and
 * `char *p = s;` hand back. Local arrays live as plain JS arrays rather than in
 * the malloc arena, so a pointer into one is a (array, index) pair instead of
 * an arena offset. Everything a C program does with such a pointer (indexing,
 * dereferencing, `p++`, `%s`, `strlen`, comparison with NULL, difference of two
 * pointers) goes through the same helpers as an arena pointer.
 */
/**
 * A string literal has no arena address (it is a JS string), so a `char *`
 * field that holds one stores this tag and keeps the text in a side table.
 * The tag is far outside the arena (which is at most a few MiB), so it can
 * never collide with a real allocation offset.
 */
const STRING_TAG = 0x7fffffff;

const isView = (v) => !!v && typeof v === 'object' && v.__view === true;
const makeView = (arr, i) => ({ __view: true, arr, i });

/** A function used as a value: `int (*fp)(int, int) = add;` is a named handle. */
const isFnPtr = (v) => !!v && typeof v === 'object' && typeof v.__fn === 'string';
/** The function a pointer value names. */
const fnPtrName = (v) => (isFnPtr(v) ? v.__fn : null);
const makeFnPtr = (name, fn) => ({
  __fn: name,
  params: (fn && fn.params) || [],
  retType: (fn && fn.retType) || null,
});

/** Text from a view to the end of the array (or its NUL). */
function viewText(view) {
  let out = '';
  for (let i = Math.max(0, view.i); i < view.arr.length; i += 1) {
    const ch = view.arr[i];
    if (!ch) break;
    out += String.fromCharCode(ch & 0xff);
  }
  return out;
}

/** The array indefinite article: 'an int[]' reads better than 'a int[]'. */
const charCodes = (text) => Array.from(String(text), (c) => c.charCodeAt(0) & 0xff);

/** Read a NUL-terminated C string out of a char array. */
function cStr(value) {
  if (isView(value)) return viewText(value);
  if (Array.isArray(value)) {
    let out = '';
    for (const ch of value) {
      if (!ch) break;
      out += String.fromCharCode(ch & 0xff);
    }
    return out;
  }
  return value == null ? '' : String(value);
}

const truthy = (v) => {
  if (isPtr(v)) return !v.isNull;
  if (isView(v)) return true; // a pointer into an array is never NULL
  if (isFnPtr(v)) return true; // a function address is never NULL
  if (typeof v === 'string') return v.length > 0;
  if (isStruct(v)) return true;
  return (v | 0) !== 0;
};

/** A printf-compatible formatter: flags, width, precision, length modifiers. */
export function formatPrintf(fmt, args) {
  let out = '';
  let ai = 0;
  for (let i = 0; i < fmt.length; i += 1) {
    const c = fmt[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    if (fmt[i + 1] === '%') {
      out += '%';
      i += 1;
      continue;
    }
    let j = i + 1;
    let flags = '';
    while ('-+ 0#'.includes(fmt[j])) {
      flags += fmt[j];
      j += 1;
    }
    let width = '';
    while (fmt[j] >= '0' && fmt[j] <= '9') {
      width += fmt[j];
      j += 1;
    }
    let prec = null;
    if (fmt[j] === '.') {
      j += 1;
      let p = '';
      while (fmt[j] >= '0' && fmt[j] <= '9') {
        p += fmt[j];
        j += 1;
      }
      prec = parseInt(p || '0', 10);
    }
    while ('hlLzjt'.includes(fmt[j])) j += 1;
    const conv = fmt[j];
    i = j;
    const arg = args[ai];
    ai += 1;
    const asInt = () => Math.trunc(typeof arg === 'number' ? arg : Number(arg) || 0);
    let text;
    switch (conv) {
      case 'd':
      case 'i': {
        const v = asInt();
        text = v < 0 && flags.includes('+') ? `+${v}` : String(v);
        break;
      }
      case 'u':
        text = String(Math.abs(asInt()));
        break;
      case 'c':
        text = typeof arg === 'string' ? arg[0] || '' : String.fromCharCode(asInt() & 0xff);
        break;
      case 's':
        text = arg === undefined || arg === null ? '(null)' : String(arg);
        break;
      case 'x':
        text = (asInt() >>> 0).toString(16);
        break;
      case 'X':
        text = (asInt() >>> 0).toString(16).toUpperCase();
        break;
      case 'o':
        text = (asInt() >>> 0).toString(8);
        break;
      case 'f':
        text = Number(arg ?? 0).toFixed(prec == null ? 6 : prec);
        break;
      case 'g':
      case 'G': {
        // %g is the shortest of %e and %f: at most `prec` significant digits
        // (6 by default) with trailing zeros removed.
        const digits = prec == null ? 6 : Math.max(1, prec);
        let text2 = Number(arg ?? 0).toPrecision(digits);
        if (text2.includes('e')) {
          // toPrecision switches to exponential form for very large or small
          // values, which is what C prints too - just without the '+0' padding.
          text2 = text2.replace(/e([+-])0*?(-?\d+)/, 'e$1$2');
        } else if (text2.includes('.')) {
          text2 = text2.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        }
        text = conv === 'G' ? text2.toUpperCase() : text2;
        break;
      }
      default:
        text = `%${conv}`;
    }
    if (prec != null && conv === 's') text = String(arg ?? '').slice(0, prec);
    if (width) {
      const w = parseInt(width, 10);
      const zeroPad = flags.includes('0') && !flags.includes('-');
      while (text.length < w) text = flags.includes('-') ? `${text} ` : (zeroPad ? `0${text}` : ` ${text}`);
    }
    out += text;
  }
  return out;
}

export class Runtime {
  constructor(options = {}) {
    this.onOutput = options.onOutput || (() => {});
    this.stdin = options.stdin || '';
    this.stdinPos = 0;
    this.maxSteps = options.maxSteps ?? 5_000_000;
    this.maxDepth = options.maxDepth ?? 200;
    this.maxHeapBytes = options.maxHeapBytes ?? 32 * 1024 * 1024;
    this.heapBytes = 0;
    this.steps = 0;
    this.depth = 0;
    this.globals = new Env();
    this.functions = new Map();
    /** Registered `struct` definitions, by name. */
    this.structs = new Map();
    this._layoutStack = new Set();
    /**
     * One arena for the whole malloc family. A pointer is an (offset, size)
     * pair into this single buffer, which is what lets a pointer stored in a
     * struct field still be valid after the expression that created it -
     * the classic `node->next` linked list. Allocations are 4-byte aligned,
     * freed blocks are recycled, and every access is bounds-checked.
     */
    this.arenaLimit = Math.min(this.maxHeapBytes, 16 * 1024 * 1024);
    this.arena = null;
    // The first four bytes are reserved as the null page, so a live allocation
    // can never sit at offset 0 and 0 stays an unambiguous NULL.
    this.arenaTop = 4;
    this.arenaFree = [];
    this.liveAllocs = 0;
    /** Live allocation extents by arena offset: lets a pointer read back out
     *  of memory recover its size and stay fully bounds-checked. */
    this.allocMap = new Map();
    /** String literals stored in pointer fields, by field address. */
    this.stringPtrs = new Map();
  }

  _arena() {
    if (!this.arena) this.arena = new ArrayBuffer(this.arenaLimit);
    return this.arena;
  }

  // ------------------------------------------------------------- entry point

  run(program) {
    for (const fn of program.funcs) this.functions.set(fn.name, fn);
    for (const def of program.structs || []) this._registerStruct(def);
    // Predeclared constants, so the ordinary C idioms compile without a header.
    this.globals.declare('NULL', { type: { base: 'int', ptr: 1 }, value: makePtr(0) });
    this.globals.declare('EOF', { type: { base: 'int' }, value: -1 });
    for (const decl of program.globals) this._declareVars(this.globals, decl);
    const main = this.functions.get('main');
    if (!main) {
      throw new CompileError('Link', 'no entry point found: define int main()', 1, 1);
    }
    try {
      this._callFunction(main, []);
    } catch (err) {
      if (!(err instanceof ReturnSignal) && err !== EXIT_OK) throw err;
    }
    return { steps: this.steps, heapBytes: this.heapBytes };
  }

  // ---------------------------------------------------------------- budgets

  _tick(line) {
    this.steps += 1;
    if (this.steps > this.maxSteps) {
      throw new CompileError(
        'Runtime',
        `step limit exceeded after ${this.maxSteps} operations - infinite loop?`,
        line || 1,
        1,
      );
    }
  }

  _chargeHeap(bytes, node) {
    this.heapBytes += bytes;
    if (this.heapBytes > this.maxHeapBytes) {
      throw new CompileError(
        'Runtime',
        `heap limit exceeded (${Math.round(this.maxHeapBytes / 1048576)} MiB) - allocation refused`,
        (node && node.line) || 1,
        1,
      );
    }
  }

  _err(message, node) {
    return new CompileError('Runtime', message, (node && node.line) || 1, 1);
  }

  // -------------------------------------------------------------- statements

  _exec(stmt, env) {
    this._tick(stmt.line);
    switch (stmt.type) {
      case 'Block': {
        const scope = new Env(env);
        for (const s of stmt.body) this._exec(s, scope);
        return;
      }
      case 'Empty':
        return;
      case 'StructDef':
        for (const def of stmt.defs) this._registerStruct(def);
        return;
      case 'VarDecl':
        this._declareVars(env, stmt);
        return;
      case 'ExprStmt':
        this._eval(stmt.expr, env);
        return;
      case 'If': {
        const scope = new Env(env);
        if (truthy(this._eval(stmt.test, env))) this._exec(stmt.then, scope);
        else if (stmt.alt) this._exec(stmt.alt, scope);
        return;
      }
      case 'While': {
        for (;;) {
          this._tick(stmt.line);
          if (!truthy(this._eval(stmt.test, env))) break;
          try {
            this._exec(stmt.body, new Env(env));
          } catch (signal) {
            if (signal === BREAK) break;
            if (signal !== CONTINUE) throw signal;
          }
        }
        return;
      }
      case 'For': {
        const scope = new Env(env);
        if (stmt.init) this._exec(stmt.init, scope);
        for (;;) {
          this._tick(stmt.line);
          if (stmt.test && !truthy(this._eval(stmt.test, scope))) break;
          try {
            this._exec(stmt.body, new Env(scope));
          } catch (signal) {
            if (signal === BREAK) break;
            if (signal !== CONTINUE) throw signal;
          }
          if (stmt.update) this._eval(stmt.update, scope);
        }
        return;
      }
      case 'DoWhile': {
        for (;;) {
          this._tick(stmt.line);
          try {
            this._exec(stmt.body, new Env(env));
          } catch (signal) {
            if (signal === BREAK) break;
            if (signal !== CONTINUE) throw signal;
          }
          if (!truthy(this._eval(stmt.test, env))) break;
        }
        return;
      }
      case 'Switch': {
        const scope = new Env(env);
        const disc = Math.trunc(this._eval(stmt.disc, scope));
        let start = -1;
        let fallback = -1;
        stmt.cases.forEach((c, i) => {
          if (c.test === null) {
            fallback = i;
            return;
          }
          if (start === -1 && Math.trunc(this._eval(c.test, scope)) === disc) start = i;
        });
        if (start === -1) start = fallback;
        if (start === -1) return;
        try {
          // C falls through: run from the matched label to `break` or the end.
          for (let i = start; i < stmt.cases.length; i += 1) {
            for (const s of stmt.cases[i].body) this._exec(s, scope);
          }
        } catch (signal) {
          if (signal !== BREAK) throw signal;
        }
        return;
      }
      case 'Return':
        throw new ReturnSignal(stmt.value ? this._eval(stmt.value, env) : 0);
      case 'Break':
        throw BREAK;
      case 'Continue':
        throw CONTINUE;
      default:
        throw this._err(`unsupported statement '${stmt.type}'`, stmt);
    }
  }

  /** The value a fresh variable of `type` starts with (deterministic, zeroed). */
  _zeroValue(type, node, depth = 0) {
    if (!type) return 0;
    if (type.ptr > 0) return 0; // a null pointer
    if (type.base === 'struct') return this._structValue(type, node, depth);
    return 0; // uninitialised C scalars are zero here (deterministic sandbox)
  }

  _structValue(type, node, depth = 0) {
    const def = this.structs.get(type.structName);
    if (!def) throw this._err(`unknown struct type '${type.structName}'`, node);
    if (depth > 16) throw this._err(`struct '${type.structName}' nests too deeply`, node);
    if (def.kind === 'union') {
      const size = this._structLayout(type.structName, node).size;
      const value = { __struct: type.structName, __union: true, __buf: new ArrayBuffer(size) };
      for (const f of def.fields) {
        // A nested struct or an array member is held as a value of its own;
        // every scalar member shares the buffer, and that is the storage that
        // makes reading a union through another member behave like C.
        if (f.array) value[f.name] = this._fieldArrayValue(f);
        else if (f.type.base === 'struct') value[f.name] = this._zeroValue(f.type, node, depth + 1);
      }
      return value;
    }
    const value = { __struct: type.structName };
    for (const f of def.fields) {
      value[f.name] = f.array ? this._fieldArrayValue(f) : this._zeroValue(f.type, node, depth + 1);
    }
    return value;
  }

  /**
   * The dimension list of an array declarator or member: every element is a
   * constant expression (C requires it), evaluated against the globals.
   */
  _dimsOf(spec) {
    const nodes = spec.dims || [spec.size];
    const dims = nodes.map((n) => (n ? Math.trunc(this._eval(n, this.globals)) : 4));
    if (!dims.length) dims.push(4);
    for (const size of dims) {
      if (!Number.isFinite(size) || size < 0 || size > 40_000_000) {
        throw new CompileError('Runtime', `invalid array size '${size}'`, spec.line || 1, 1);
      }
    }
    return dims;
  }

  /** A fresh (zeroed) array value for a struct or union member. */
  _fieldArrayValue(field) {
    const dims = this._dimsOf(field);
    const elemSize = field.type && field.type.ptr > 0 ? 8 : field.type && field.type.base === 'char' ? 1 : 4;
    const isFloat = !!(field.type && field.type.base === 'float');
    const build = (level) => {
      const arr = new Array(dims[level]);
      for (let i = 0; i < arr.length; i += 1) {
        arr[i] = level + 1 < dims.length ? build(level + 1) : this._zeroValue(field.type, field, 1);
      }
      const rowBytes = elemSize * dims.slice(level + 1).reduce((a, b) => a * b, 1);
      Object.defineProperty(arr, '__elem', { value: rowBytes, enumerable: false });
      if (isFloat && level === dims.length - 1) {
        Object.defineProperty(arr, '__float', { value: true, enumerable: false });
      }
      return arr;
    };
    return build(0);
  }

  _fieldNames(type) {
    if (!type || type.base !== 'struct') return [];
    const def = this.structs.get(type.structName);
    return def ? def.fields.map((f) => f.name) : [];
  }

  /** Positional initialiser lists: `struct Point p = {1, 2};` */
  _fromInitList(type, list, env, node) {
    const value = this._structValue(type, node, 0);
    const names = this._fieldNames(type);
    // C initialises a union through its first member only.
    const limit = this.structs.get(type.structName)?.kind === 'union' ? 1 : names.length;
    list.items.slice(0, limit).forEach((item, i) => {
      if (!names[i]) return;
      value[names[i]] = item.type === 'InitList'
        ? this._fromInitList(this._fieldType(type, names[i]), item, env, node)
        : this._eval(item, env);
    });
    return value;
  }

  _fieldType(type, name) {
    const def = this.structs.get(type.structName);
    const field = def ? def.fields.find((f) => f.name === name) : null;
    return field ? field.type : null;
  }

  _fieldTypeByName(structName, name) {
    const def = this.structs.get(structName);
    const field = def ? def.fields.find((f) => f.name === name) : null;
    return field ? field.type : null;
  }

  /**
   * Field offsets for a struct: a linear, unpadded layout (C rounds to
   * alignment; we document the simplification and stay self-consistent, so
   * `sizeof` and heap field access always agree with each other).
   */
  _structLayout(name, node) {
    const def = this.structs.get(name);
    if (!def) throw this._err(`unknown struct type '${name}'`, node);
    if (def.__layout) return def.__layout;
    if (this._layoutStack.has(name)) throw this._err(`struct '${name}' contains itself by value`, node);
    this._layoutStack.add(name);
    try {
      const isUnionKind = def.kind === 'union';
      let offset = 0;
      let widest = 0;
      const fields = def.fields.map((f) => {
        const ptr = f.type.ptr > 0;
        let size;
        if (ptr) size = 4; // pointers occupy 4 bytes on the heap
        else if (f.type.base === 'char') size = 1;
        else if (f.type.base === 'struct') size = this._structLayout(f.type.structName, node).size;
        else size = 4;
        // An array member takes as many bytes as its dimensions ask for
        // (`int grid[2][3]` is 24), not a fixed 4.
        if (f.array) size *= this._dimsOf(f).reduce((a, b) => a * b, 1);
        // Every union member starts at offset 0 and the record is as wide as
        // its widest member - so writing one member and reading another is the
        // type punning C guarantees.
        const entry = {
          name: f.name,
          offset: isUnionKind ? 0 : offset,
          size,
          ptr,
          base: f.type.base,
          structName: f.type.structName || null,
        };
        widest = Math.max(widest, size);
        offset += size;
        return entry;
      });
      def.__layout = { fields, size: Math.max(4, isUnionKind ? widest : offset), union: isUnionKind };
      return def.__layout;
    } finally {
      this._layoutStack.delete(name);
    }
  }

  /** Register a record type, and any record defined inside it. */
  _registerStruct(def) {
    this.structs.set(def.name, def);
    for (const nested of def.nested || []) this._registerStruct(nested);
  }

  _declareVars(env, stmt) {
    // A struct definition can arrive attached to a declaration.
    if (stmt.declType && stmt.declType.structDef) this._registerStruct(stmt.declType.structDef);
    for (const d of stmt.decls) {
      const declType = { ...stmt.declType, ptr: (stmt.declType.ptr || 0) + (d.ptr || 0) };
      let value;
      if (d.array) {
        const size = d.size ? Math.trunc(this._eval(d.size, env)) : 0;
        const dims = (d.dims || [d.size]).map((n) => (n ? Math.trunc(this._eval(n, env)) : 0));
        for (const dim of dims) {
          if (!Number.isFinite(dim) || dim < 0 || dim > 40_000_000) {
            throw this._err(`invalid array size '${dim}'`, d);
          }
        }
        const total = dims.reduce((a, b) => a * b, 1);
        this._chargeHeap(Math.max(size * 8, total * 4), d);
        const elemSize = declType.ptr > 0 ? 8 : declType.base === 'char' ? 1 : 4;
        const isFloat = declType.base === 'float';
        // Rows are built from the inside out, so `int m[2][3]` is two arrays of
        // three ints - exactly what `m[i][j]` and `sizeof(m[0])` expect.
        const build = (level, source) => {
          const count = dims[level];
          const arr = new Array(count);
          for (let i = 0; i < count; i += 1) {
            const item = source && i < source.length ? source[i] : null;
            if (level + 1 < dims.length) {
              if (item && item.type === 'Str' && declType.base === 'char') {
                // `char grid[2][8] = {"ab", "cd"};` - a string initialises a row.
                const row = build(level + 1, null);
                for (let k = 0; k < row.length; k += 1) {
                  row[k] = k < item.value.length ? item.value.charCodeAt(k) : 0;
                }
                arr[i] = row;
              } else {
                arr[i] = build(level + 1, item && item.type === 'InitList' ? item.items : null);
              }
            } else if (item) {
              const itemValue = item.type === 'InitList'
                ? this._fromInitList(declType, item, env, d)
                : this._eval(item, env);
              // An int array truncates on store; a double array keeps the value.
              arr[i] = typeof itemValue === 'number' && !isFloat ? Math.trunc(itemValue) : itemValue;
            } else {
              arr[i] = this._zeroValue(declType, d, 1);
            }
          }
          // Non-enumerable so iteration and equality are unaffected, but
          // `sizeof` can report real byte sizes for int and char arrays alike.
          const rowBytes = elemSize * dims.slice(level + 1).reduce((a, b) => a * b, 1);
          Object.defineProperty(arr, '__elem', { value: rowBytes, enumerable: false });
          if (isFloat && level + 1 === dims.length) {
            Object.defineProperty(arr, '__float', { value: true, enumerable: false });
          }
          return arr;
        };
        if (d.init && d.init.type === 'InitList') {
          value = build(0, d.init.items);
        } else if (d.init && d.init.type === 'Str' && declType.base === 'char') {
          const text = d.init.value;
          const arr = build(0, null);
          for (let i = 0; i < dims[0]; i += 1) arr[i] = i < text.length ? text.charCodeAt(i) : 0;
          value = arr;
        } else {
          value = build(0, null);
        }
      } else if (d.init && d.init.type === 'InitList') {
        value = this._fromInitList(declType, d.init, env, d);
      } else if (d.init) {
        value = this._eval(d.init, env);
        if (isUnion(value)) value = this._cloneUnion(value);
        if (typeof value === 'number' && declType.base !== 'float') value = Math.trunc(value);
        if (typeof value === 'string') this._chargeHeap(value.length * 2, d);
      } else {
        value = this._zeroValue(declType, d, 0);
      }
      env.declare(d.name, { type: declType, value, isArray: !!d.array });
    }
  }

  // ------------------------------------------------------- heap pointer ops

  /**
   * Function pointers that live inside arena-allocated structs get a stable
   * negative id, because an arena field holds an int and a function is not an
   * address in this runtime.
   */
  _fnPtrId(name) {
    if (!this.fnPtrIds) {
      this.fnPtrIds = new Map();
      this.fnPtrNames = new Map();
    }
    if (!this.fnPtrIds.has(name)) {
      const id = this.fnPtrIds.size;
      this.fnPtrIds.set(name, id);
      this.fnPtrNames.set(id, name);
    }
    return -(this.fnPtrIds.get(name) + 1);
  }

  _alloc(bytes, node) {
    const size = Math.max(4, Math.ceil(bytes / 4) * 4);
    this._chargeHeap(size, node);
    const buf = this._arena();
    for (let i = 0; i < this.arenaFree.length; i += 1) {
      const block = this.arenaFree[i];
      if (block.size >= size) {
        this.arenaFree.splice(i, 1);
        new Uint8Array(buf, block.offset, size).fill(0);
        this.liveAllocs += 1;
        this.allocMap.set(block.offset, size);
        return makePtr(block.offset, 4, null, size);
      }
    }
    if (this.arenaTop + size > buf.byteLength) {
      throw this._err(
        `heap exhausted: the sandbox arena is ${(buf.byteLength / 1048576).toFixed(1)} MiB (free memory before allocating more)`,
        node,
      );
    }
    const offset = this.arenaTop;
    this.arenaTop += size;
    this.liveAllocs += 1;
    this.allocMap.set(offset, size);
    return makePtr(offset, 4, null, size);
  }

  /** Read a NUL-terminated string from a char array, a view or a heap pointer. */
  _cStr(value, node) {
    if (isView(value)) return viewText(value);
    if (Array.isArray(value) || !isPtr(value)) return cStr(value);
    if (value.isNull) return '(null)';
    const elem = value.elem;
    const limit = value.size ? Math.floor(value.size / elem) : 0;
    const dv = new DataView(this._arena());
    let out = '';
    for (let i = 0; i < limit; i += 1) {
      const at = value.base + i * elem;
      const ch = elem === 1 ? dv.getUint8(at) : dv.getInt32(at, true);
      if (!ch) break;
      out += String.fromCharCode(ch & 0xff);
    }
    return out;
  }

  _arenaAt(ptr, node) {
    if (!isPtr(ptr) || ptr.isNull) throw this._err('null pointer dereference', node);
    return ptr;
  }

  _allocCheck(ptr, at, size, node) {
    if (ptr.size && (at < ptr.base || at + size > ptr.base + ptr.size)) {
      throw this._err('heap access past the end of the allocation', node);
    }
  }

  _arenaCheck(ptr, at, size, node) {
    this._arenaAt(ptr, node);
    if (at < 0 || at + size > this.arenaLimit) throw this._err('heap access outside the sandbox arena', node);
    this._allocCheck(ptr, at, size, node);
  }

  /** Bounds-checked read/write at `view.i + index`. */
  _viewIndex(view, index, node) {
    const at = view.i + index;
    if (!Number.isFinite(at) || at < 0 || at >= view.arr.length) {
      throw this._err(`array index ${at} out of bounds (length ${view.arr.length})`, node);
    }
    return at;
  }

  _viewRead(view, index, node) {
    return view.arr[this._viewIndex(view, index, node)];
  }

  _viewWrite(view, index, value, node) {
    const at = this._viewIndex(view, index, node);
    view.arr[at] = typeof value === 'number' && !view.arr.__float ? Math.trunc(value) : value;
  }

  _ptrRead(ptr, node) {
    if (isView(ptr)) return this._viewRead(ptr, 0, node);
    const p = this._arenaAt(ptr, node);
    const dv = new DataView(this._arena());
    if (p.elem === 1) {
      this._arenaCheck(p, p.offset, 1, node);
      return dv.getUint8(p.offset);
    }
    this._arenaCheck(p, p.offset, 4, node);
    if (p.float) return dv.getFloat32(p.offset, true);
    return dv.getInt32(p.offset, true);
  }

  _ptrWrite(ptr, value, node) {
    if (isView(ptr)) return this._viewWrite(ptr, 0, value, node);
    const p = this._arenaAt(ptr, node);
    const dv = new DataView(this._arena());
    if (p.elem === 1) {
      this._arenaCheck(p, p.offset, 1, node);
      dv.setUint8(p.offset, Math.trunc(value) & 0xff);
      return;
    }
    this._arenaCheck(p, p.offset, 4, node);
    if (p.float && !isPtr(value) && !isView(value)) {
      dv.setFloat32(p.offset, Number(value) || 0, true);
      return;
    }
    const raw = isPtr(value) ? ptrValue(value) : isView(value) ? ptrValue(value) : Math.trunc(value);
    dv.setInt32(p.offset, raw | 0, true);
  }

  /** `p[i]` for a typed pointer: element size comes from the pointee type. */
  _ptrElem(ptr, index, node) {
    if (isView(ptr)) return makeView(ptr.arr, ptr.i + Math.trunc(index));
    const p = this._arenaAt(ptr, node);
    return { ...p, offset: p.offset + Math.trunc(index) * p.elem };
  }

  _freePtr(ptr, node) {
    const p = this._arenaAt(ptr, node);
    this.arenaFree.push({ offset: p.base, size: p.size });
    this.allocMap.delete(p.base);
    // Drop any string literals that lived in this block, so freeing a node
    // really frees everything it referenced.
    for (const at of [...this.stringPtrs.keys()]) {
      if (at >= p.base && at < p.base + p.size) this.stringPtrs.delete(at);
    }
    this.heapBytes = Math.max(0, this.heapBytes - p.size);
    this.liveAllocs -= 1;
    // A freed handle becomes a null pointer, so a use-after-free is a clean
    // 'null pointer dereference' rather than silent corruption.
    ptr.isNull = true;
    ptr.size = 0;
    ptr.freed = true;
  }

  /** Pointer arithmetic and comparison when either side points into an array. */
  _viewBinary(op, a, b, node) {
    const va = isView(a) ? a : null;
    const vb = isView(b) ? b : null;
    if (op === '+' && va && typeof b === 'number') return makeView(va.arr, va.i + Math.trunc(b));
    if (op === '+' && typeof a === 'number' && vb) return makeView(vb.arr, vb.i + Math.trunc(a));
    if (op === '-' && va && typeof b === 'number') return makeView(va.arr, va.i - Math.trunc(b));
    if (op === '-' && va && vb) {
      if (va.arr !== vb.arr) throw this._err('cannot subtract pointers into two different arrays', node);
      return va.i - vb.i;
    }
    if (op === '==' || op === '!=') {
      // Two pointers are the same address only when they point at the same
      // element of the same array; anything else (including NULL) differs.
      const same = !!(va && vb && va.arr === vb.arr && va.i === vb.i);
      return op === '==' ? (same ? 1 : 0) : same ? 0 : 1;
    }
    if (['<', '<=', '>', '>='].includes(op)) {
      const x = ptrValue(a);
      const y = ptrValue(b);
      if (op === '<') return x < y ? 1 : 0;
      if (op === '<=') return x <= y ? 1 : 0;
      if (op === '>') return x > y ? 1 : 0;
      return x >= y ? 1 : 0;
    }
    throw this._err(`operator '${op}' is not defined for pointers`, node);
  }

  _ptrBinary(op, a, b, node) {
    if (isFnPtr(a) || isFnPtr(b)) {
      if (op === '==' || op === '!=') {
        const same = isFnPtr(a) && isFnPtr(b) && fnPtrName(a) === fnPtrName(b);
        return op === '==' ? (same ? 1 : 0) : same ? 0 : 1;
      }
      throw this._err(`operator '${op}' is not defined for function pointers`, node);
    }
    // An array name decays to a pointer to its first element, so `p - b` and
    // `b + 1` mean what they mean in C.
    if (Array.isArray(a)) a = makeView(a, 0);
    if (Array.isArray(b)) b = makeView(b, 0);
    if (isView(a) || isView(b)) return this._viewBinary(op, a, b, node);
    const isAddr = (v) => isPtr(v) || v instanceof Ref;
    if (op === '+' && isAddr(a) && typeof b === 'number') {
      const p = this._arenaAt(a, node);
      return { ...p, offset: p.offset + Math.trunc(b) * p.elem };
    }
    if (op === '+' && typeof a === 'number' && isAddr(b)) {
      const p = this._arenaAt(b, node);
      return { ...p, offset: p.offset + Math.trunc(a) * p.elem };
    }
    if (op === '-' && isAddr(a) && typeof b === 'number') {
      const p = this._arenaAt(a, node);
      return { ...p, offset: p.offset - Math.trunc(b) * p.elem };
    }
    if (op === '-' && isPtr(a) && isPtr(b)) {
      const p = this._arenaAt(a, node);
      const q = this._arenaAt(b, node);
      return Math.trunc((p.offset - q.offset) / p.elem);
    }
    if (['==', '!='].includes(op)) {
      const x = ptrValue(a);
      const y = ptrValue(b);
      return (op === '==' ? x === y : x !== y) ? 1 : 0;
    }
    if (['<', '<=', '>', '>='].includes(op)) {
      const x = ptrValue(a);
      const y = ptrValue(b);
      if (op === '<') return x < y ? 1 : 0;
      if (op === '<=') return x <= y ? 1 : 0;
      if (op === '>') return x > y ? 1 : 0;
      return x >= y ? 1 : 0;
    }
    throw this._err(`operator '${op}' is not defined for pointers`, node);
  }

  // ------------------------------------------------------------- expressions

  _eval(node, env) {
    this._tick(node.line);
    switch (node.type) {
      case 'Num':
        return node.value;
      case 'Str':
        return node.value;
      case 'Ident': {
        const scope = env.resolve(node.name);
        if (!scope) {
          // A function name used as a value is its address: `int (*fp)(int) = square;`
          const fn = this.functions.get(node.name);
          if (fn) return makeFnPtr(node.name, fn);
          throw this._err(`use of undeclared identifier '${node.name}'`, node);
        }
        return scope.vars.get(node.name).value;
      }
      case 'Cond':
        return truthy(this._eval(node.test, env))
          ? this._eval(node.then, env)
          : this._eval(node.alt, env);
      case 'Cast':
        return this._cast(node, this._eval(node.operand, env));
      case 'Sizeof':
        return this._sizeOf(node, env);
      case 'Member':
      case 'MemberPtr':
        return this._memberRef(node, env).get();
      case 'Binary':
        return this._binary(node, env);
      case 'Unary': {
        const v = this._eval(node.operand, env);
        // Negating a floating expression keeps its fraction: `-fabs(3.5)` is
        // -3.5, not -3. Bitwise operators always work on integers.
        const real = this._floatish(node.operand, env);
        const num = real ? Number(v) : Math.trunc(v);
        if (node.op === '-') return -num;
        if (node.op === '+') return num;
        if (node.op === '!') return truthy(v) ? 0 : 1;
        if (node.op === '~') return ~Math.trunc(v);
        throw this._err(`unsupported unary '${node.op}'`, node);
      }
      case 'Assign': {
        const ref = this._lvalue(node.target, env);
        const value = this._eval(node.value, env);
        const stored = this._coerce(ref, value);
        ref.set(stored);
        return stored;
      }
      case 'CompoundAssign': {
        const ref = this._lvalue(node.target, env);
        const real =
          (ref.type && ref.type.base === 'float') || this._floatish(node.value, env);
        const next = this._applyBinary(node.op, ref.get(), this._eval(node.value, env), node, real);
        const stored = this._coerce(ref, next);
        ref.set(stored);
        return stored;
      }
      case 'Update': {
        const ref = this._lvalue(node.operand, env);
        const delta = node.op === '++' ? 1 : -1;
        const current = ref.get();
        if (isPtr(current) || isView(current)) {
          const next = this._ptrBinary('+', current, delta, node);
          ref.set(next);
          return node.prefix ? next : current;
        }
        const next = Math.trunc(current) + delta;
        ref.set(next);
        return node.prefix ? next : next - delta;
      }
      case 'Index': {
        const target = this._eval(node.array, env);
        if (isView(target)) return this._viewRead(target, Math.trunc(this._eval(node.index, env)), node);
        const i = this._resolveIndex(node, target, env);
        if (isPtr(target)) return this._ptrRead(this._ptrElem(target, i, node), node);
        return typeof target === 'string' ? target.charCodeAt(i) : target[i];
      }
      case 'Addr':
        return this._addressOf(node, env);
      case 'Deref': {
        const pointer = this._eval(node.operand, env);
        // `(*fp)(x)`: dereferencing a function pointer yields the function.
        if (isFnPtr(pointer)) return pointer;
        if (pointer instanceof Ref) return pointer.get();
        if (isPtr(pointer)) return this._ptrRead(pointer, node);
        if (typeof pointer === 'number') throw this._err('null pointer dereference (the pointer is 0)', node);
        throw this._err('cannot dereference a non-pointer value', node);
      }
      case 'Call':
        return this._call(node, env);
      default:
        throw this._err(`unsupported expression '${node.type}'`, node);
    }
  }

  /**
   * `&x` is a reference (writable location); `&a[i]` is a pointer into the
   * array. Both are address-like values a C program can store and pass.
   */
  _addressOf(node, env) {
    const operand = node.operand;
    // `&square` is the address of a function, exactly like a bare `square`.
    if (operand.type === 'Ident') {
      const fn = this.functions.get(operand.name);
      if (fn && !env.resolve(operand.name)) return makeFnPtr(operand.name, fn);
    }
    if (operand.type === 'Index') {
      const target = this._eval(operand.array, env);
      const i = Math.trunc(this._eval(operand.index, env));
      if (Array.isArray(target)) {
        if (i < 0 || i >= target.length) {
          throw this._err(`address of a[${i}] is out of bounds (length ${target.length})`, node);
        }
        return makeView(target, i);
      }
      if (isView(target)) return makeView(target.arr, target.i + i);
      return this._lvalue(node, env);
    }
    return this._lvalue(operand, env);
  }

  /** A union copy owns its bytes; sharing the buffer would alias two records. */
  _cloneUnion(value) {
    const copy = { ...value, __buf: value.__buf.slice(0) };
    // Aggregate members are values, so they need their own shallow copies too.
    const def = this.structs.get(value.__struct);
    for (const f of (def && def.fields) || []) {
      if (f.array) copy[f.name] = this._cloneArray(value[f.name]);
      else if (f.type.base === 'struct') copy[f.name] = { ...value[f.name] };
    }
    return copy;
  }

  _cloneArray(arr) {
    if (!Array.isArray(arr)) return arr;
    return arr.map((row) => (Array.isArray(row) ? this._cloneArray(row) : row));
  }

  /** Store through a Ref: floats keep their fraction, integers truncate. */
  _coerce(ref, value) {
    if (typeof value !== 'number') {
      // `b = a` on a union copies the bytes, it does not alias the other record.
      return isUnion(value) ? this._cloneUnion(value) : value;
    }
    if (ref && ref.type && ref.type.base === 'float') return value;
    return Math.trunc(value);
  }

  /**
   * Is this expression floating point? The runtime stores numbers, not tagged
   * values, so this is decided from the source: a float literal, a float
   * variable/field, a float cast, or a call to a function that returns one.
   * It is what makes `int a = 7 / 2` yield 3 and `double d = 7.0 / 2` yield 3.5.
   */
  _floatish(node, env) {
    if (!node) return false;
    switch (node.type) {
      case 'Num':
        return !!node.isFloat;
      case 'Cast':
        return !!(node.castType && node.castType.base === 'float');
      case 'Ident': {
        const scope = env.resolve(node.name);
        const type = scope ? scope.vars.get(node.name).type : null;
        return !!(type && type.base === 'float');
      }
      case 'Member':
      case 'MemberPtr': {
        const t = this._memberType(node, env);
        return !!(t && t.base === 'float');
      }
      case 'Index':
      case 'Unary':
      case 'Addr':
      case 'Deref':
        return this._floatish(node.array || node.operand, env);
      case 'Binary':
        return this._floatish(node.left, env) || this._floatish(node.right, env);
      case 'Cond':
        return this._floatish(node.then, env) || this._floatish(node.alt, env);
      case 'Assign':
      case 'CompoundAssign':
        return this._floatish(node.target, env) || this._floatish(node.value, env);
      case 'Call':
        return this._floatishCall(node, env);
      default:
        return false;
    }
  }

  _floatishCall(node, env) {
    if (node.callee.type === 'Ident') {
      if (FLOAT_BUILTINS.has(node.callee.name)) return true;
      const fn = this.functions.get(node.callee.name);
      if (fn) return fn.retType && fn.retType.base === 'float';
      const scope = env.resolve(node.callee.name);
      const value = scope ? scope.vars.get(node.callee.name).value : null;
      if (isFnPtr(value)) {
        const target = this.functions.get(fnPtrName(value));
        return !!(target && target.retType && target.retType.base === 'float');
      }
      return false;
    }
    // The callee may be an expression (`ops[i].fn(x)`, `(*fp)(x)`); this is a
    // pure question about types, so a callee that cannot be read yet simply
    // answers "not floating point" instead of raising from inside a predicate.
    try {
      const callee = this._eval(node.callee, env);
      if (isFnPtr(callee)) {
        const target = this.functions.get(fnPtrName(callee));
        return !!(target && target.retType && target.retType.base === 'float');
      }
    } catch {
      return false;
    }
    return false;
  }

  /** The declared type of a member expression, for the float test above. */
  _memberType(node, env) {
    if (node.type === 'Member') {
      const obj = this._eval(node.object, env);
      if (isStruct(obj)) return this._fieldTypeByName(obj.__struct, node.name);
      return null;
    }
    const raw = this._eval(node.object, env);
    const target = raw instanceof Ref ? raw.get() : raw;
    if (isStruct(target)) return this._fieldTypeByName(target.__struct, node.name);
    if (isPtr(target) && target.struct) {
      const layout = this._structLayout(target.struct, node);
      const field = layout.fields.find((f) => f.name === node.name);
      return field ? { base: field.base, ptr: field.ptr ? 1 : 0 } : null;
    }
    return null;
  }

  /** Cast semantics: numeric truncation, pointer retyping, `(void)` passthrough. */
  _cast(node, value) {
    const t = node.castType;
    if (t.base === 'void') return value || 0;
    if (t.ptr > 0) {
      if (isPtr(value))
        return { ...value, elem: t.base === 'char' ? 1 : 4, float: t.base === 'float', struct: t.structName || null };
      if (isView(value)) return value; // a pointer into an array stays one
      if (value instanceof Ref) return value; // an address is already an address
      if (typeof value === 'number') return value === 0 ? makePtr(0) : value;
      return value;
    }
    if (typeof value === 'number') {
      // `(char)` narrows to a signed byte, exactly like C on a signed-char target.
      if (t.base === 'char') return ((Math.trunc(value) & 0xff) << 24) >> 24;
      if (t.base === 'float') return value; // `(double)` keeps the fraction
      return Math.trunc(value);
    }
    if (isPtr(value)) return ptrValue(value);
    if (value instanceof Ref) return 1;
    if (typeof value === 'string') return Math.trunc(Number(value) || 0);
    return 0;
  }

  _sizeOf(node, env) {
    if (node.sizeofType) {
      const t = node.sizeofType;
      let size;
      if (t.ptr > 0) size = 8;
      else if (t.base === 'char') size = 1;
      else if (t.base === 'struct') size = this._structLayout(t.structName, node).size;
      else size = 4;
      // `typedef int Row[4];` - sizeof(Row) is the whole array, not one element.
      if (t.arraySize) return size * Math.trunc(this._eval(t.arraySize, env));
      return size;
    }
    const v = this._eval(node.operand, env);
    if (typeof v === 'string') return v.length + 1;
    if (Array.isArray(v)) return v.length * (v.__elem || 4);
    if (isStruct(v)) return this._structLayout(v.__struct, node).size;
    if (isPtr(v) || isView(v)) return 8;
    return 4;
  }

  /**
   * One implementation for `s.x` and `p->x`, returning an assignable Ref so
   * reads and writes share exactly the same resolution (including the
   * bounds check for a field on the heap).
   */
  _memberRef(node, env) {
    if (node.type === 'Member') {
      const obj = this._eval(node.object, env);
      // `heap->pair.a`: a nested record inside a heap allocation. The member
      // itself is not a pointer in C, so a dot is right, and the access still
      // resolves through the same bounds-checked heap path.
      if (isPtr(obj) && obj.__nested) return this._heapMemberRef(obj, node);
      if (isPtr(obj) || obj instanceof Ref) {
        throw this._err(`that expression is a pointer, not a struct - use '->' to reach '${node.name}'`, node);
      }
      if (!isStruct(obj)) throw this._err('member access on a non-struct value', node);
      if (isUnion(obj)) return this._unionMemberRef(obj, node);
      if (!(node.name in obj)) throw this._err(`struct '${obj.__struct}' has no member '${node.name}'`, node);
      const ref = new Ref(
        () => obj[node.name],
        (v) => {
          obj[node.name] = v;
        },
      );
      ref.type = this._fieldTypeByName(obj.__struct, node.name);
      return ref;
    }
    const raw = this._eval(node.object, env);
    // `->` needs an address: either a heap pointer or `&value` (which evaluates
    // to a Ref). A plain struct value must use '.', exactly as in C.
    if (isStruct(raw)) {
      throw this._err(`'->' needs a pointer to a struct - use '.' for the struct value '${raw.__struct}'`, node);
    }
    const target = raw instanceof Ref ? raw.get() : raw;
    if (isUnion(target)) return this._unionMemberRef(target, node);
    if (isStruct(target)) {
      if (!(node.name in target)) throw this._err(`struct '${target.__struct}' has no member '${node.name}'`, node);
      const ref = new Ref(
        () => target[node.name],
        (v) => {
          target[node.name] = v;
        },
      );
      ref.type = this._fieldTypeByName(target.__struct, node.name);
      return ref;
    }
    if (isPtr(target)) return this._heapMemberRef(target, node);
    throw this._err("the left side of '->' must be a pointer to a struct", node);
  }

  /** `p->field` for a pointer into the arena allocation behind `p`. */
  _heapMemberRef(target, node) {
    {
      const layout = this._structLayout(target.struct, node);
      const field = layout.fields.find((f) => f.name === node.name);
      if (!field) throw this._err(`struct '${target.struct}' has no member '${node.name}'`, node);
      const at = target.offset + field.offset;
      // A nested record inside a heap allocation is reached as a pointer to
      // that member, so `node->inner.value` walks two levels of offsets and
      // every access stays bounds-checked against the same allocation.
      if (field.base === 'struct' && !field.ptr) {
        return new Ref(
          () => ({ ...target, offset: at, struct: field.structName, __nested: true }),
          () => {
            throw this._err(
              `assigning the whole nested struct '${node.name}' on the heap is not supported - assign its members instead`,
              node,
            );
          },
        );
      }
      const ref = new Ref(
        () => this._heapFieldRead(target, at, field, node),
        (v) => this._heapFieldWrite(target, at, field, v, node),
      );
      ref.type = { base: field.base, ptr: field.ptr ? 1 : 0 };
      return ref;
    }
  }

  /**
   * A member of a union *value*: reads and writes land in the record's single
   * shared buffer, at offset 0, sized by the member's own type.
   */
  _unionMemberRef(union, node) {
    const def = this.structs.get(union.__struct);
    const field = def ? def.fields.find((f) => f.name === node.name) : null;
    if (!field) throw this._err(`union '${union.__struct}' has no member '${node.name}'`, node);
    const layout = this._structLayout(union.__struct, node);
    const entry = layout.fields.find((f) => f.name === node.name);
    const buf = union.__buf;
    if (!buf) throw this._err(`union '${union.__struct}' has no storage`, node);
    if (field.array || field.type.base === 'struct') {
      const ref = new Ref(
        () => union[node.name],
        (v) => {
          union[node.name] = v;
        },
      );
      ref.type = field.type;
      return ref;
    }
    const ref = new Ref(
      () => {
        if (entry.ptr) {
          // Always the full 32-bit word: a `char *` member is an address, not
          // a character, so it must not be read as one byte.
          const raw = new DataView(buf).getInt32(0, true);
          if (raw === 0) return makePtr(0);
          if (raw === STRING_TAG && typeof union[node.name] === 'string') return union[node.name];
          if (raw < 0) {
            const name = this.fnPtrNames ? this.fnPtrNames.get(-raw - 1) : null;
            if (name && this.functions.has(name)) return makeFnPtr(name, this.functions.get(name));
            return makePtr(0);
          }
          return makePtr(raw, 4, entry.structName, this.allocMap.get(raw) || 0);
        }
        return unionBytes(buf, entry);
      },
      (value) => {
        const dv = new DataView(buf);
        if (entry.ptr) {
          if (typeof value === 'string') {
            union[node.name] = value;
            dv.setInt32(0, STRING_TAG, true);
            return;
          }
          if (isFnPtr(value)) dv.setInt32(0, this._fnPtrId(fnPtrName(value)), true);
          else if (isPtr(value) || isView(value)) dv.setInt32(0, ptrValue(value) | 0, true);
          else dv.setInt32(0, Math.trunc(Number(value) || 0) | 0, true);
          return;
        }
        if (entry.base === 'char') dv.setUint8(0, Math.trunc(Number(value) || 0) & 0xff);
        else if (entry.base === 'float') dv.setFloat32(0, Number(value) || 0, true);
        else dv.setInt32(0, Math.trunc(Number(value) || 0) | 0, true);
      },
    );
    ref.type = { base: entry.base, ptr: entry.ptr ? 1 : 0 };
    return ref;
  }

  _heapFieldRead(ptr, at, field, node) {
    this._arenaCheck(ptr, at, field.size, node);
    const dv = new DataView(this._arena());
    const raw = field.size === 1 ? dv.getUint8(at) : dv.getInt32(at, true);
    // A pointer field is stored as an arena offset, so it comes back as a
    // usable pointer into the same arena.
    if (field.ptr) {
      if (raw === 0) return makePtr(0);
      if (raw === STRING_TAG) return this.stringPtrs.get(at) ?? '';
      if (raw < 0) {
        const name = this.fnPtrNames ? this.fnPtrNames.get(-raw - 1) : null;
        if (name && this.functions.has(name)) return makeFnPtr(name, this.functions.get(name));
        throw this._err('that function pointer does not name a function any more', node);
      }
      return makePtr(raw, 4, field.structName, this.allocMap.get(raw) || 0);
    }
    // A `double` field is stored as IEEE-754 in the arena, so a struct can
    // carry fractional values the same way a local does.
    if (field.base === 'float') return dv.getFloat32(at, true);
    return raw;
  }

  _heapFieldWrite(ptr, at, field, value, node) {
    this._arenaCheck(ptr, at, field.size, node);
    const dv = new DataView(this._arena());
    if (field.ptr) {
      let raw = 0;
      // A string literal is not an arena address either: remember the text
      // against this field's address and store the tag.
      if (typeof value === 'string') {
        this.stringPtrs.set(at, value);
        dv.setInt32(at, STRING_TAG, true);
        return;
      }
      // A function pointer cannot be an arena address, so it is stored as a
      // small negative id and resolved back through the function table.
      if (isFnPtr(value)) raw = this._fnPtrId(fnPtrName(value));
      else if (isPtr(value) || isView(value)) raw = ptrValue(value);
      else if (typeof value === 'number') raw = Math.trunc(value);
      else throw this._err('a pointer field can only hold a pointer (or 0 for NULL)', node);
      dv.setInt32(at, raw | 0, true);
      return;
    }
    if (field.size === 1) {
      dv.setUint8(at, Math.trunc(value) & 0xff);
      return;
    }
    if (field.base === 'float') {
      dv.setFloat32(at, Number(value) || 0, true);
      return;
    }
    dv.setInt32(at, Math.trunc(value) | 0, true);
  }

  _resolveIndex(node, target, env) {
    const raw = typeof node.index === 'object' && node.index.type ? this._eval(node.index, env) : node.index;
    const i = Math.trunc(raw);
    if (isPtr(target)) {
      if (!Number.isFinite(i) || i < 0) throw this._err(`pointer index ${i} is not valid`, node);
      return i;
    }
    const len = target == null ? 0 : target.length;
    if (!Number.isFinite(i) || i < 0 || i >= len) {
      throw this._err(`array index ${i} out of bounds (length ${len})`, node);
    }
    return i;
  }

  _lvalue(node, env) {
    if (node.type === 'Ident') {
      const scope = env.resolve(node.name);
      if (!scope) throw this._err(`assignment to undeclared identifier '${node.name}'`, node);
      const entry = scope.vars.get(node.name);
      const ref = new Ref(
        () => entry.value,
        (v) => {
          entry.value = v;
        },
      );
      ref.type = entry.type || null;
      return ref;
    }
    if (node.type === 'Member' || node.type === 'MemberPtr') return this._memberRef(node, env);
    if (node.type === 'Index') {
      const target = this._eval(node.array, env);
      if (isView(target)) {
        const raw = Math.trunc(this._eval(node.index, env));
        const viewRef = new Ref(
          () => this._viewRead(target, raw, node),
          (v) => this._viewWrite(target, raw, v, node),
        );
        viewRef.type = target.arr.__float ? { base: 'float' } : null;
        return viewRef;
      }
      const i = this._resolveIndex(node, target, env);
      if (isPtr(target)) {
        const sub = this._ptrElem(target, i, node);
        return new Ref(
          () => this._ptrRead(sub, node),
          (v) => this._ptrWrite(sub, v, node),
        );
      }
      if (typeof target === 'string') throw this._err('cannot assign into a string literal', node);
      const elemRef = new Ref(
        () => target[i],
        (v) => {
          target[i] = typeof v === 'number' && !target.__float ? Math.trunc(v) : v;
        },
      );
      // Tell the store whether this slot holds a double, so `series[0] = 1.5`
      // keeps its fraction (the element check above would otherwise truncate).
      elemRef.type = target.__float ? { base: 'float' } : null;
      return elemRef;
    }
    if (node.type === 'Deref') {
      const pointer = this._eval(node.operand, env);
      if (pointer instanceof Ref) return pointer;
      if (isView(pointer)) {
        return new Ref(
          () => this._viewRead(pointer, 0, node),
          (v) => this._viewWrite(pointer, 0, v, node),
        );
      }
      if (isPtr(pointer)) {
        return new Ref(
          () => this._ptrRead(pointer, node),
          (v) => this._ptrWrite(pointer, v, node),
        );
      }
      throw this._err('cannot write through a non-pointer value', node);
    }
    throw this._err('expression is not assignable', node);
  }

  _binary(node, env) {
    if (node.op === '&&') {
      if (!truthy(this._eval(node.left, env))) return 0;
      return truthy(this._eval(node.right, env)) ? 1 : 0;
    }
    if (node.op === '||') {
      if (truthy(this._eval(node.left, env))) return 1;
      return truthy(this._eval(node.right, env)) ? 1 : 0;
    }
    const a = this._eval(node.left, env);
    const b = this._eval(node.right, env);
    const real = this._floatish(node.left, env) || this._floatish(node.right, env);
    return this._applyBinary(node.op, a, b, node, real);
  }

  _applyBinary(op, a, b, node, real = false) {
    if (
      isPtr(a) || isPtr(b) || isView(a) || isView(b) || isFnPtr(a) || isFnPtr(b) ||
      Array.isArray(a) || Array.isArray(b)
    ) {
      return this._ptrBinary(op, a, b, node);
    }
    if (op === '+') {
      if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b);
      return real ? Number(a) + Number(b) : Math.trunc(a) + Math.trunc(b);
    }
    if (real && ['-', '*', '/', '%'].includes(op)) {
      const rx = Number(a);
      const ry = Number(b);
      if ((op === '/' || op === '%') && ry === 0) {
        throw this._err(op === '/' ? 'division by zero' : 'modulo by zero', node);
      }
      if (op === '/') return rx / ry;
      if (op === '%') return rx % ry;
      return op === '-' ? rx - ry : rx * ry;
    }
    if (real && ['<', '<=', '>', '>=', '==', '!='].includes(op)) {
      const rx = Number(a);
      const ry = Number(b);
      if (op === '<') return rx < ry ? 1 : 0;
      if (op === '<=') return rx <= ry ? 1 : 0;
      if (op === '>') return rx > ry ? 1 : 0;
      if (op === '>=') return rx >= ry ? 1 : 0;
      return (op === '==' ? rx === ry : rx !== ry) ? 1 : 0;
    }
    const x = Math.trunc(a);
    const y = Math.trunc(b);
    switch (op) {
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        if (y === 0) throw this._err('division by zero', node);
        return Math.trunc(x / y);
      case '%':
        if (y === 0) throw this._err('modulo by zero', node);
        return x % y;
      case '<':
        return x < y ? 1 : 0;
      case '<=':
        return x <= y ? 1 : 0;
      case '>':
        return x > y ? 1 : 0;
      case '>=':
        return x >= y ? 1 : 0;
      case '==':
        return x === y ? 1 : 0;
      case '!=':
        return x !== y ? 1 : 0;
      case '&':
        return x & y;
      case '|':
        return x | y;
      case '^':
        return x ^ y;
      case '<<':
        return x << y;
      case '>>':
        return x >> y;
      default:
        throw this._err(`unsupported operator '${op}'`, node);
    }
  }

  _call(node, env) {
    const args = node.args.map((a) => this._eval(a, env));
    if (node.callee.type === 'Ident') {
      const name = node.callee.name;
      const builtin = BUILTINS[name];
      if (builtin) return builtin(args, this, node);
      const fn = this.functions.get(name);
      if (fn) return this._callFunction(fn, args);
      // Same syntax, but the name may be a variable holding a function address.
      const scope = env.resolve(name);
      if (scope) return this._callFunction(this._resolveCallable(scope.vars.get(name).value, name, node), args);
      throw this._err(`call to undefined function '${name}'`, node);
    }
    // `fp(x)`, `ops[i].fn(x)`, `(*fp)(x)`: the callee is an expression.
    const callee = this._eval(node.callee, env);
    return this._callFunction(this._resolveCallable(callee, null, node), args);
  }

  /** The function a callable value refers to, with a useful message if not. */
  _resolveCallable(value, name, node) {
    if (isFnPtr(value)) {
      const named = fnPtrName(value);
      const fn = this.functions.get(named);
      if (!fn) throw this._err(`the function pointer names '${named}', which is not defined`, node);
      return fn;
    }
    if (typeof value === 'string' && this.functions.has(value)) return this.functions.get(value);
    throw this._err(
      name
        ? `'${name}' is not a function (it holds ${value === null ? 'null' : typeof value}) - a function pointer holds a function name`
        : 'this expression is not a function - a function pointer holds a function name',
      node,
    );
  }

  _callFunction(fn, args) {
    this.depth += 1;
    if (this.depth > this.maxDepth) {
      this.depth -= 1;
      throw this._err(`stack depth limit exceeded calling '${fn.name}' (runaway recursion?)`, fn);
    }
    try {
      const env = new Env(this.globals);
      fn.params.forEach((p, i) => {
        let value = args[i] === undefined ? 0 : args[i];
        // Integer parameters truncate; `double` parameters keep the fraction.
        if (typeof value === 'number' && p.type.base !== 'float') value = Math.trunc(value);
        // C passes structs by value: copy, so a callee cannot mutate the
        // caller's object through a plain (non-pointer) parameter. A union's
        // bytes are copied too, so the two records stay independent.
        if (isUnion(value)) value = this._cloneUnion(value);
        else if (isStruct(value)) value = { ...value };
        env.declare(p.name, { type: p.type, value, isArray: !!p.isArray });
      });
      try {
        this._exec(fn.body, env);
      } catch (signal) {
        if (signal instanceof ReturnSignal) return signal.value;
        throw signal;
      }
      return 0;
    } finally {
      this.depth -= 1;
    }
  }
}

const EXIT_OK = new ExitSignal();

// ----------------------------------------------------- scanf-style scanning

const isSpaceChar = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

/** Write one scanned value through a pointer, a `&x` reference, or an array. */
function writeScalar(target, value, rt, node) {
  if (target instanceof Ref) {
    const current = target.get();
    if (Array.isArray(current)) {
      current[0] = typeof value === 'number' ? Math.trunc(value) : value;
      return;
    }
    target.set(typeof value === 'number' ? Math.trunc(value) : value);
    return;
  }
  if (isPtr(target)) {
    rt._ptrWrite(target, value, node);
    return;
  }
  throw rt._err('scanf needs an address to write into - pass &var (or a pointer)', node);
}

/**
 * Where a C string function may write: a local array, a pointer into one, or
 * `&x` on such an array. Returns the backing array and the first writable slot,
 * or null when the destination is a heap pointer (handled separately).
 */
function bufferTarget(target) {
  if (isView(target)) return { arr: target.arr, start: target.i };
  if (Array.isArray(target)) return { arr: target, start: 0 };
  if (target instanceof Ref) {
    const current = target.get();
    if (Array.isArray(current)) return { arr: current, start: 0 };
    if (isView(current)) return { arr: current.arr, start: current.i };
  }
  return null;
}

function writeString(target, text, rt, node) {
  const codes = charCodes(text);
  const buf = bufferTarget(target);
  if (buf) {
    // `scanf("%s", word)` passes the char array itself, which decays to a
    // pointer in C - write the characters and NUL-terminate. The rest of the
    // buffer is zeroed so no stale characters survive a shorter write.
    const room = buf.arr.length - buf.start;
    if (codes.length + 1 > room) {
      throw rt._err(`the destination buffer holds ${room} characters but '${text}' needs ${codes.length + 1}`, node);
    }
    for (let i = buf.start; i < buf.arr.length; i += 1) buf.arr[i] = 0;
    for (let i = 0; i < codes.length; i += 1) buf.arr[buf.start + i] = codes[i];
    return;
  }
  if (target instanceof Ref) {
    target.set(text);
    return;
  }
  if (isPtr(target)) {
    const elem = target.elem;
    const capacity = Math.floor((target.size || 0) / elem);
    if (codes.length + 1 > capacity) {
      throw rt._err(`the destination buffer holds ${capacity} characters but '${text}' needs ${codes.length + 1}`, node);
    }
    for (let i = 0; i < codes.length; i += 1) rt._ptrWrite({ ...target, offset: target.offset + i * elem }, codes[i], node);
    rt._ptrWrite({ ...target, offset: target.offset + codes.length * elem }, 0, node);
    return;
  }
  throw rt._err('a %s conversion needs a writable buffer (an array or a pointer)', node);
}

/**
 * `strncpy` semantics exactly: copy at most `n` bytes, and when the source is
 * shorter pad with NULs up to `n`. No implicit terminator when it is not.
 */
function writeBytes(target, text, n, rt, node) {
  if (!Number.isFinite(n) || n < 0) throw rt._err(`strncpy needs a non-negative count, got ${n}`, node);
  const codes = charCodes(text).slice(0, n);
  while (codes.length < n) codes.push(0);
  const buf = bufferTarget(target);
  if (buf) {
    const room = buf.arr.length - buf.start;
    if (n > room) throw rt._err(`the destination buffer holds ${room} characters but ${n} are needed`, node);
    for (let i = 0; i < n; i += 1) buf.arr[buf.start + i] = codes[i];
    return;
  }
  if (isPtr(target)) {
    const capacity = Math.floor((target.size || 0) / target.elem);
    if (n > capacity) throw rt._err(`the destination buffer holds ${capacity} characters but ${n} are needed`, node);
    for (let i = 0; i < n; i += 1) rt._ptrWrite({ ...target, offset: target.offset + i * target.elem }, codes[i], node);
    return;
  }
  throw rt._err('strncpy needs a writable char buffer (an array or a pointer)', node);
}

/** Byte-wise string comparison, as <string.h> defines it. */
function compareCStrings(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = (a.charCodeAt(i) & 0xff) - (b.charCodeAt(i) & 0xff);
    if (d !== 0) return d;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

/**
 * A pointer to `text[index]` inside whatever the caller passed in.
 * A string literal is immutable, so the pointer to it is the remainder of the
 * literal itself; an array or a view becomes a real (array, index) pointer, so
 * writes through it land back in the caller's buffer.
 */
function offsetPointer(original, text, index) {
  if (typeof original === 'string') return text.slice(index);
  if (isView(original)) return makeView(original.arr, original.i + index);
  if (Array.isArray(original)) return makeView(original, index);
  if (isPtr(original)) return { ...original, offset: original.offset + index * original.elem };
  return makePtr(0);
}

/**
 * The scanning engine behind scanf and sscanf. Returns how many conversions
 * succeeded and how much of the source was consumed, so scanf can advance the
 * shared stdin cursor by exactly that much.
 */
function scanFmt(format, source, targets, rt, node) {
  let si = 0;
  let ti = 0;
  let assigned = 0;
  const skipSpace = () => {
    while (si < source.length && isSpaceChar(source[si])) si += 1;
  };
  for (let fi = 0; fi < format.length; fi += 1) {
    const fc = format[fi];
    if (isSpaceChar(fc)) {
      skipSpace();
      continue;
    }
    if (fc !== '%') {
      if (source[si] !== fc) break;
      si += 1;
      continue;
    }
    fi += 1;
    if (format[fi] === '%') {
      if (source[si] !== '%') break;
      si += 1;
      continue;
    }
    let width = '';
    while (format[fi] >= '0' && format[fi] <= '9') {
      width += format[fi];
      fi += 1;
    }
    const maxLen = width ? parseInt(width, 10) : Infinity;
    while ('hlLzjt'.includes(format[fi])) fi += 1;
    const conv = format[fi];
    if (conv !== 'c') skipSpace();
    const target = targets[ti];
    ti += 1;
    if (conv === 'd' || conv === 'i' || conv === 'u' || conv === 'x' || conv === 'X' || conv === 'o') {
      const start = si;
      if (conv !== 'x' && conv !== 'X' && conv !== 'o' && (source[si] === '+' || source[si] === '-')) si += 1;
      const re = conv === 'x' || conv === 'X' ? /[0-9a-fA-F]/ : conv === 'o' ? /[0-7]/ : /[0-9]/;
      while (si < source.length && si - start < maxLen && re.test(source[si])) si += 1;
      const text = source.slice(start, si);
      if (!/[0-9a-fA-F]/.test(text[text.length - 1] || '')) {
        si = start;
        break;
      }
      const radix = conv === 'x' || conv === 'X' ? 16 : conv === 'o' ? 8 : 10;
      writeScalar(target, parseInt(text, radix), rt, node);
      assigned += 1;
    } else if (conv === 'f' || conv === 'g' || conv === 'e') {
      const window = source.slice(si, si + (maxLen === Infinity ? 64 : maxLen));
      const m = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(window);
      if (!m) break;
      si += m[0].length;
      writeScalar(target, parseFloat(m[0]), rt, node);
      assigned += 1;
    } else if (conv === 'c') {
      if (si >= source.length) break;
      writeScalar(target, source.charCodeAt(si), rt, node);
      si += 1;
      assigned += 1;
    } else if (conv === 's') {
      const start = si;
      while (si < source.length && !isSpaceChar(source[si]) && si - start < maxLen) si += 1;
      if (si === start) break;
      writeString(target, source.slice(start, si), rt, node);
      assigned += 1;
    } else {
      break;
    }
  }
  return { assigned, consumed: si };
}

// --------------------------------------------------------------- stdio subset

const BUILTINS = {
  printf(args, rt) {
    const fmt = args.length ? rt._cStr(args[0]) : '';
    // Char arrays and char pointers print as text, not as '[object Object]'.
    const rest = args
      .slice(1)
      .map((a) => (Array.isArray(a) || isPtr(a) || isView(a) ? rt._cStr(a) : a));
    rt.onOutput(formatPrintf(fmt, rest));
    return fmt.length;
  },
  puts(args, rt) {
    const s = rt._cStr(args[0]);
    rt.onOutput(s + '\n');
    return s.length + 1;
  },
  putchar(args, rt) {
    const c = args.length ? args[0] : 0;
    rt.onOutput(typeof c === 'string' ? c[0] : String.fromCharCode(Math.trunc(c) & 0xff));
    return c;
  },
  getchar(args, rt) {
    if (rt.stdinPos >= rt.stdin.length) return -1;
    const ch = rt.stdin.charCodeAt(rt.stdinPos);
    rt.stdinPos += 1;
    return ch;
  },
  strlen(args, rt) {
    return rt._cStr(args[0]).length;
  },
  // ------------------------------------------------------------ <string.h>
  strcpy(args, rt, node) {
    writeString(args[0], rt._cStr(args[1]), rt, node);
    return args[0];
  },
  strncpy(args, rt, node) {
    writeBytes(args[0], rt._cStr(args[1]), Math.trunc(Number(args[2]) || 0), rt, node);
    return args[0];
  },
  strcat(args, rt, node) {
    const joined = rt._cStr(args[0]) + rt._cStr(args[1]);
    writeString(args[0], joined, rt, node);
    return args[0];
  },
  strncat(args, rt, node) {
    const n = Math.trunc(Number(args[2]) || 0);
    const joined = rt._cStr(args[0]) + rt._cStr(args[1]).slice(0, Math.max(0, n));
    writeString(args[0], joined, rt, node);
    return args[0];
  },
  strcmp(args, rt) {
    return compareCStrings(rt._cStr(args[0]), rt._cStr(args[1]));
  },
  strncmp(args, rt) {
    const n = Math.max(0, Math.trunc(Number(args[2]) || 0));
    return compareCStrings(rt._cStr(args[0]).slice(0, n), rt._cStr(args[1]).slice(0, n));
  },
  strchr(args, rt) {
    const hay = rt._cStr(args[0]);
    const at = hay.indexOf(String.fromCharCode(Math.trunc(Number(args[1]) || 0) & 0xff));
    return at === -1 ? makePtr(0) : offsetPointer(args[0], hay, at);
  },
  strrchr(args, rt) {
    const hay = rt._cStr(args[0]);
    const needle = String.fromCharCode(Math.trunc(Number(args[1]) || 0) & 0xff);
    const at = hay.lastIndexOf(needle);
    return at === -1 ? makePtr(0) : offsetPointer(args[0], hay, at);
  },
  strstr(args, rt) {
    const hay = rt._cStr(args[0]);
    const at = hay.indexOf(rt._cStr(args[1]));
    return at === -1 ? makePtr(0) : offsetPointer(args[0], hay, at);
  },
  // ------------------------------------------------------------- <ctype.h>
  // The C functions below are classified by the C standard for the ASCII
  // range; outside it they answer 0 rather than guessing a locale.
  isdigit(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c >= 48 && c <= 57 ? 1 : 0;
  },
  isalpha(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0;
  },
  isalnum(args) {
    return BUILTINS.isalpha(args) || BUILTINS.isdigit(args) ? 1 : 0;
  },
  isspace(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c === 32 || (c >= 9 && c <= 13) ? 1 : 0;
  },
  isupper(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c >= 65 && c <= 90 ? 1 : 0;
  },
  islower(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c >= 97 && c <= 122 ? 1 : 0;
  },
  ispunct(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c >= 33 && c <= 126 && !BUILTINS.isalnum(args) ? 1 : 0;
  },
  toupper(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c >= 97 && c <= 122 ? c - 32 : c;
  },
  tolower(args) {
    const c = Math.trunc(Number(args[0]) || 0);
    return c >= 65 && c <= 90 ? c + 32 : c;
  },
  atoi(args, rt) {
    const v = parseInt(rt._cStr(args[0]) || '0', 10);
    return Number.isNaN(v) ? 0 : v;
  },
  atof(args, rt) {
    const v = parseFloat(rt._cStr(args[0]) || '0');
    return Number.isNaN(v) ? 0 : v;
  },
  abs(args) {
    return Math.abs(Math.trunc(Number(args[0]) || 0));
  },
  /**
   * scanf/sscanf share one engine. scanf consumes from the same stdin cursor as
   * getchar, so `scanf` and `getchar` can be mixed in one program.
   */
  scanf(args, rt, node) {
    const fmt = args.length ? rt._cStr(args[0]) : '';
    const { assigned, consumed } = scanFmt(fmt, rt.stdin.slice(rt.stdinPos), args.slice(1), rt, node);
    rt.stdinPos += consumed;
    return assigned;
  },
  sscanf(args, rt, node) {
    const source = args.length ? rt._cStr(args[0]) : '';
    const fmt = args.length > 1 ? rt._cStr(args[1]) : '';
    return scanFmt(fmt, source, args.slice(2), rt, node).assigned;
  },
  // ------------------------------------------------------------ malloc family
  malloc(args, rt, node) {
    const size = Math.trunc(Number(args[0]) || 0);
    if (size <= 0) throw rt._err(`malloc(${args[0]}) is not a valid size`, node);
    return rt._alloc(size, node);
  },
  calloc(args, rt, node) {
    const count = Math.trunc(Number(args[0]) || 0);
    const size = Math.trunc(Number(args[1]) || 1);
    if (count <= 0 || size <= 0) throw rt._err('calloc needs a positive element count and element size', node);
    const ptr = rt._alloc(count * size, node);
    new Uint8Array(rt._arena(), ptr.offset, ptr.size).fill(0);
    return ptr;
  },
  realloc(args, rt, node) {
    const ptr = args[0];
    const size = Math.trunc(Number(args[1]) || 0);
    if (size <= 0) throw rt._err(`realloc(${args[1]}) is not a valid size`, node);
    if (!isPtr(ptr) || ptr.isNull) return rt._alloc(size, node);
    const next = rt._alloc(size, node);
    const copy = Math.min(ptr.size, next.size);
    new Uint8Array(rt._arena(), next.offset, copy).set(new Uint8Array(rt._arena(), ptr.offset, copy));
    rt._freePtr(ptr, node);
    return next;
  },
  free(args, rt, node) {
    const ptr = args[0];
    if (isPtr(ptr) && !ptr.isNull) rt._freePtr(ptr, node);
    return 0;
  },
  memset(args, rt, node) {
    const ptr = args[0];
    const n = Math.trunc(Number(args[2]) || 0);
    if (!isPtr(ptr)) throw rt._err('memset expects a pointer as its first argument', node);
    rt._arenaCheck(ptr, ptr.offset, n, node);
    new Uint8Array(rt._arena(), ptr.offset, n).fill(Math.trunc(Number(args[1]) || 0) & 0xff);
    return ptr;
  },
  memcpy(args, rt, node) {
    const dst = args[0];
    const src = args[1];
    const n = Math.trunc(Number(args[2]) || 0);
    if (!isPtr(dst) || !isPtr(src)) throw rt._err('memcpy expects two pointers', node);
    rt._arenaCheck(dst, dst.offset, n, node);
    rt._arenaCheck(src, src.offset, n, node);
    new Uint8Array(rt._arena(), dst.offset, n).set(new Uint8Array(rt._arena(), src.offset, n));
    return dst;
  },
  exit() {
    throw EXIT_OK;
  },
};

// -------------------------------------------------------------- <math.h>
// Every function here works in double precision and marks the expression as
// floating point, so `double r = sqrt(2);` keeps 1.4142135623730951 instead of
// being truncated to 1 on the way into the variable.
const MATH_FNS = {
  sqrt: Math.sqrt,
  cbrt: Math.cbrt,
  pow: Math.pow,
  fabs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  fmod: (a, b) => a % b,
  fmin: Math.min,
  fmax: Math.max,
  hypot: Math.hypot,
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  trunc: Math.trunc,
};

for (const [name, fn] of Object.entries(MATH_FNS)) {
  BUILTINS[name] = (args) => fn.apply(Math, args.map((a) => Number(a) || 0));
}

/** Builtins whose result is floating point (used by the float-expression test). */
const FLOAT_BUILTINS = new Set(Object.keys(MATH_FNS));

// ------------------------------------------------------------------ facade

/**
 * Compile + run a C program. Returns a structured result instead of throwing,
 * so both the worker and the tests can report errors with positions.
 */
export function interpret(source, options = {}) {
  const chunks = [];
  const emit = (text) => {
    chunks.push(text);
    if (options.onOutput) options.onOutput(text);
  };
  const runtime = new Runtime({ ...options, onOutput: emit });
  try {
    const ast = parse(source);
    const stats = runtime.run(ast);
    return {
      ok: true,
      output: chunks.join(''),
      steps: stats.steps,
      heapBytes: stats.heapBytes,
      liveAllocs: runtime.liveAllocs,
    };
  } catch (err) {
    return {
      ok: false,
      output: chunks.join(''),
      steps: runtime.steps,
      heapBytes: runtime.heapBytes,
      error: {
        stage: err.stage || 'Runtime',
        message: err.reason || err.message,
        line: err.line || 1,
        col: err.col || 1,
      },
    };
  }
}
