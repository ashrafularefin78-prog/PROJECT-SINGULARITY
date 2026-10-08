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

/** The integer a pointer (or a local address) stands for in a comparison. */
const ptrValue = (v) => (isPtr(v) ? (v.isNull ? 0 : v.offset) : v instanceof Ref ? 1 : v);

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

/** Read a NUL-terminated C string out of a char array. */
function cStr(value) {
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
      case 'g':
        text = Number(arg ?? 0).toFixed(prec == null ? 6 : prec);
        break;
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
  }

  _arena() {
    if (!this.arena) this.arena = new ArrayBuffer(this.arenaLimit);
    return this.arena;
  }

  // ------------------------------------------------------------- entry point

  run(program) {
    for (const fn of program.funcs) this.functions.set(fn.name, fn);
    for (const def of program.structs || []) this.structs.set(def.name, def);
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
        for (const def of stmt.defs) this.structs.set(def.name, def);
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
    const value = { __struct: type.structName };
    for (const f of def.fields) {
      value[f.name] = f.array ? new Array(4).fill(0) : this._zeroValue(f.type, node, depth + 1);
    }
    return value;
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
    list.items.forEach((item, i) => {
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
      let offset = 0;
      const fields = def.fields.map((f) => {
        const ptr = f.type.ptr > 0;
        let size;
        if (ptr) size = 4; // pointers occupy 4 bytes on the heap
        else if (f.type.base === 'char') size = 1;
        else if (f.type.base === 'struct') size = this._structLayout(f.type.structName, node).size;
        else size = 4;
        if (f.array) size *= 4;
        const entry = { name: f.name, offset, size, ptr, base: f.type.base, structName: f.type.structName || null };
        offset += size;
        return entry;
      });
      def.__layout = { fields, size: Math.max(4, offset) };
      return def.__layout;
    } finally {
      this._layoutStack.delete(name);
    }
  }

  _declareVars(env, stmt) {
    // A struct definition can arrive attached to a declaration.
    if (stmt.declType && stmt.declType.structDef) this.structs.set(stmt.declType.structDef.name, stmt.declType.structDef);
    for (const d of stmt.decls) {
      const declType = { ...stmt.declType, ptr: (stmt.declType.ptr || 0) + (d.ptr || 0) };
      let value;
      if (d.array) {
        const size = d.size ? Math.trunc(this._eval(d.size, env)) : 0;
        if (!Number.isFinite(size) || size < 0 || size > 40_000_000) {
          throw this._err(`invalid array size '${size}'`, d);
        }
        this._chargeHeap(size * 8, d);
        const elemSize = declType.ptr > 0 ? 8 : declType.base === 'char' ? 1 : 4;
        const arr = new Array(size);
        for (let i = 0; i < size; i += 1) arr[i] = this._zeroValue(declType, d, 1);
        // Non-enumerable so iteration and equality are unaffected, but `sizeof`
        // can report real byte sizes for int and char arrays alike.
        Object.defineProperty(arr, '__elem', { value: elemSize, enumerable: false });
        if (d.init && d.init.type === 'InitList') {
          d.init.items.forEach((item, i) => {
            if (i >= size) return;
            arr[i] = item.type === 'InitList'
              ? this._fromInitList(declType, item, env, d)
              : this._eval(item, env);
          });
        } else if (d.init && d.init.type === 'Str' && declType.base === 'char') {
          const text = d.init.value;
          for (let i = 0; i < size; i += 1) arr[i] = i < text.length ? text.charCodeAt(i) : 0;
        }
        value = arr;
      } else if (d.init && d.init.type === 'InitList') {
        value = this._fromInitList(declType, d.init, env, d);
      } else if (d.init) {
        value = this._eval(d.init, env);
        if (typeof value === 'number') value = Math.trunc(value);
        if (typeof value === 'string') this._chargeHeap(value.length * 2, d);
      } else {
        value = this._zeroValue(declType, d, 0);
      }
      env.declare(d.name, { type: declType, value, isArray: !!d.array });
    }
  }

  // ------------------------------------------------------- heap pointer ops

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

  /** Read a NUL-terminated string from a char array or a heap pointer. */
  _cStr(value, node) {
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

  _ptrRead(ptr, node) {
    const p = this._arenaAt(ptr, node);
    const dv = new DataView(this._arena());
    if (p.elem === 1) {
      this._arenaCheck(p, p.offset, 1, node);
      return dv.getUint8(p.offset);
    }
    this._arenaCheck(p, p.offset, 4, node);
    return dv.getInt32(p.offset, true);
  }

  _ptrWrite(ptr, value, node) {
    const p = this._arenaAt(ptr, node);
    const dv = new DataView(this._arena());
    if (p.elem === 1) {
      this._arenaCheck(p, p.offset, 1, node);
      dv.setUint8(p.offset, Math.trunc(value) & 0xff);
      return;
    }
    this._arenaCheck(p, p.offset, 4, node);
    const raw = isPtr(value) ? ptrValue(value) : Math.trunc(value);
    dv.setInt32(p.offset, raw | 0, true);
  }

  /** `p[i]` for a typed pointer: element size comes from the pointee type. */
  _ptrElem(ptr, index, node) {
    const p = this._arenaAt(ptr, node);
    return { ...p, offset: p.offset + Math.trunc(index) * p.elem };
  }

  _freePtr(ptr, node) {
    const p = this._arenaAt(ptr, node);
    this.arenaFree.push({ offset: p.base, size: p.size });
    this.allocMap.delete(p.base);
    this.heapBytes = Math.max(0, this.heapBytes - p.size);
    this.liveAllocs -= 1;
    // A freed handle becomes a null pointer, so a use-after-free is a clean
    // 'null pointer dereference' rather than silent corruption.
    ptr.isNull = true;
    ptr.size = 0;
    ptr.freed = true;
  }

  _ptrBinary(op, a, b, node) {
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
        if (!scope) throw this._err(`use of undeclared identifier '${node.name}'`, node);
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
        if (node.op === '-') return -Math.trunc(v);
        if (node.op === '+') return Math.trunc(v);
        if (node.op === '!') return truthy(v) ? 0 : 1;
        if (node.op === '~') return ~Math.trunc(v);
        throw this._err(`unsupported unary '${node.op}'`, node);
      }
      case 'Assign': {
        const ref = this._lvalue(node.target, env);
        const value = this._eval(node.value, env);
        ref.set(typeof value === 'number' ? Math.trunc(value) : value);
        return typeof value === 'number' ? Math.trunc(value) : value;
      }
      case 'CompoundAssign': {
        const ref = this._lvalue(node.target, env);
        const next = this._applyBinary(node.op, ref.get(), this._eval(node.value, env), node);
        ref.set(next);
        return next;
      }
      case 'Update': {
        const ref = this._lvalue(node.operand, env);
        const next = Math.trunc(ref.get()) + (node.op === '++' ? 1 : -1);
        ref.set(next);
        return node.prefix ? next : next - (node.op === '++' ? 1 : -1);
      }
      case 'Index': {
        const target = this._eval(node.array, env);
        const i = this._resolveIndex(node, target, env);
        if (isPtr(target)) return this._ptrRead(this._ptrElem(target, i, node), node);
        return typeof target === 'string' ? target.charCodeAt(i) : target[i];
      }
      case 'Addr':
        return this._lvalue(node.operand, env);
      case 'Deref': {
        const pointer = this._eval(node.operand, env);
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

  /** Cast semantics: numeric truncation, pointer retyping, `(void)` passthrough. */
  _cast(node, value) {
    const t = node.castType;
    if (t.base === 'void') return value || 0;
    if (t.ptr > 0) {
      if (isPtr(value)) return { ...value, elem: t.base === 'char' ? 1 : 4, struct: t.structName || null };
      if (value instanceof Ref) return value; // an address is already an address
      if (typeof value === 'number') return value === 0 ? makePtr(0) : value;
      return value;
    }
    if (typeof value === 'number') {
      // `(char)` narrows to a signed byte, exactly like C on a signed-char target.
      if (t.base === 'char') return ((Math.trunc(value) & 0xff) << 24) >> 24;
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
      if (t.ptr > 0) return 8;
      if (t.base === 'char') return 1;
      if (t.base === 'struct') return this._structLayout(t.structName, node).size;
      return 4;
    }
    const v = this._eval(node.operand, env);
    if (typeof v === 'string') return v.length + 1;
    if (Array.isArray(v)) return v.length * (v.__elem || 4);
    if (isStruct(v)) return this._structLayout(v.__struct, node).size;
    if (isPtr(v)) return 8;
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
      if (isPtr(obj) || obj instanceof Ref) {
        throw this._err(`that expression is a pointer, not a struct - use '->' to reach '${node.name}'`, node);
      }
      if (!isStruct(obj)) throw this._err('member access on a non-struct value', node);
      if (!(node.name in obj)) throw this._err(`struct '${obj.__struct}' has no member '${node.name}'`, node);
      return new Ref(
        () => obj[node.name],
        (v) => {
          obj[node.name] = v;
        },
      );
    }
    const raw = this._eval(node.object, env);
    // `->` needs an address: either a heap pointer or `&value` (which evaluates
    // to a Ref). A plain struct value must use '.', exactly as in C.
    if (isStruct(raw)) {
      throw this._err(`'->' needs a pointer to a struct - use '.' for the struct value '${raw.__struct}'`, node);
    }
    const target = raw instanceof Ref ? raw.get() : raw;
    if (isStruct(target)) {
      if (!(node.name in target)) throw this._err(`struct '${target.__struct}' has no member '${node.name}'`, node);
      return new Ref(
        () => target[node.name],
        (v) => {
          target[node.name] = v;
        },
      );
    }
    if (isPtr(target)) {
      const layout = this._structLayout(target.struct, node);
      const field = layout.fields.find((f) => f.name === node.name);
      if (!field) throw this._err(`struct '${target.struct}' has no member '${node.name}'`, node);
      const at = target.offset + field.offset;
      return new Ref(
        () => this._heapFieldRead(target, at, field, node),
        (v) => this._heapFieldWrite(target, at, field, v, node),
      );
    }
    throw this._err("the left side of '->' must be a pointer to a struct", node);
  }

  _heapFieldRead(ptr, at, field, node) {
    this._arenaCheck(ptr, at, field.size, node);
    const dv = new DataView(this._arena());
    const raw = field.size === 1 ? dv.getUint8(at) : dv.getInt32(at, true);
    // A pointer field is stored as an arena offset, so it comes back as a
    // usable pointer into the same arena.
    if (field.ptr) {
      if (raw === 0) return makePtr(0);
      return makePtr(raw, 4, field.structName, this.allocMap.get(raw) || 0);
    }
    return raw;
  }

  _heapFieldWrite(ptr, at, field, value, node) {
    this._arenaCheck(ptr, at, field.size, node);
    const dv = new DataView(this._arena());
    if (field.ptr) {
      let raw = 0;
      if (isPtr(value)) raw = ptrValue(value);
      else if (typeof value === 'number') raw = Math.trunc(value);
      else throw this._err("a pointer field can only hold a pointer (or 0 for NULL)", node);
      dv.setInt32(at, raw | 0, true);
      return;
    }
    if (field.size === 1) {
      dv.setUint8(at, Math.trunc(value) & 0xff);
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
      return new Ref(
        () => entry.value,
        (v) => {
          entry.value = v;
        },
      );
    }
    if (node.type === 'Member' || node.type === 'MemberPtr') return this._memberRef(node, env);
    if (node.type === 'Index') {
      const target = this._eval(node.array, env);
      const i = this._resolveIndex(node, target, env);
      if (isPtr(target)) {
        const sub = this._ptrElem(target, i, node);
        return new Ref(
          () => this._ptrRead(sub, node),
          (v) => this._ptrWrite(sub, v, node),
        );
      }
      if (typeof target === 'string') throw this._err('cannot assign into a string literal', node);
      return new Ref(
        () => target[i],
        (v) => {
          target[i] = typeof v === 'number' ? Math.trunc(v) : v;
        },
      );
    }
    if (node.type === 'Deref') {
      const pointer = this._eval(node.operand, env);
      if (pointer instanceof Ref) return pointer;
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
    return this._applyBinary(node.op, a, b, node);
  }

  _applyBinary(op, a, b, node) {
    if (isPtr(a) || isPtr(b)) return this._ptrBinary(op, a, b, node);
    if (op === '+') {
      if (typeof a === 'string' || typeof b === 'string') return String(a) + String(b);
      return Math.trunc(a) + Math.trunc(b);
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
    if (node.callee.type !== 'Ident') throw this._err('only named functions can be called', node);
    const name = node.callee.name;
    const args = node.args.map((a) => this._eval(a, env));
    const builtin = BUILTINS[name];
    if (builtin) return builtin(args, this, node);
    const fn = this.functions.get(name);
    if (!fn) throw this._err(`call to undefined function '${name}'`, node);
    return this._callFunction(fn, args);
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
        if (typeof value === 'number') value = Math.trunc(value);
        // C passes structs by value: copy, so a callee cannot mutate the
        // caller's object through a plain (non-pointer) parameter.
        if (isStruct(value)) value = { ...value };
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

function writeString(target, text, rt, node) {
  if (target instanceof Ref) {
    const current = target.get();
    if (Array.isArray(current)) {
      if (text.length + 1 > current.length) {
        throw rt._err(`the destination buffer holds ${current.length} characters but '${text}' needs ${text.length + 1}`, node);
      }
      for (let i = 0; i < current.length; i += 1) current[i] = i < text.length ? text.charCodeAt(i) : 0;
      return;
    }
    target.set(text);
    return;
  }
  if (Array.isArray(target)) {
    // `scanf("%s", word)` passes the char array itself, which decays to a
    // pointer in C - write the characters and NUL-terminate.
    if (text.length + 1 > target.length) {
      throw rt._err(`the destination buffer holds ${target.length} characters but '${text}' needs ${text.length + 1}`, node);
    }
    for (let i = 0; i < target.length; i += 1) target[i] = i < text.length ? text.charCodeAt(i) : 0;
    return;
  }
  if (isPtr(target)) {
    const elem = target.elem;
    const capacity = Math.floor((target.size || 0) / elem);
    if (text.length + 1 > capacity) {
      throw rt._err(`the destination buffer holds ${capacity} characters but '${text}' needs ${text.length + 1}`, node);
    }
    for (let i = 0; i < text.length; i += 1) rt._ptrWrite({ ...target, offset: target.offset + i * elem }, text.charCodeAt(i), node);
    rt._ptrWrite({ ...target, offset: target.offset + text.length * elem }, 0, node);
    return;
  }
  throw rt._err('a %s conversion needs a writable buffer (an array or a pointer)', node);
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
    const rest = args.slice(1).map((a) => (Array.isArray(a) || isPtr(a) ? rt._cStr(a) : a));
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
