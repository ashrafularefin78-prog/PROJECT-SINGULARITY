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

const truthy = (v) => (typeof v === 'string' ? v.length > 0 : (v | 0) !== 0);

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
  }

  // ------------------------------------------------------------- entry point

  run(program) {
    for (const fn of program.funcs) this.functions.set(fn.name, fn);
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

  _declareVars(env, stmt) {
    for (const d of stmt.decls) {
      let value;
      if (d.array) {
        const size = d.size ? Math.trunc(this._eval(d.size, env)) : 0;
        if (!Number.isFinite(size) || size < 0 || size > 40_000_000) {
          throw this._err(`invalid array size '${size}'`, d);
        }
        this._chargeHeap(size * 8, d);
        const arr = new Array(size).fill(0);
        if (d.init && d.init.type === 'InitList') {
          d.init.items.forEach((item, i) => {
            if (i < size && item.type !== 'InitList') arr[i] = Math.trunc(this._eval(item, env));
          });
        }
        value = arr;
      } else if (d.init) {
        value = this._eval(d.init, env);
        if (typeof value === 'number') value = Math.trunc(value);
        if (typeof value === 'string') this._chargeHeap(value.length * 2, d);
      } else {
        value = 0; // uninitialised C scalars are zero here (deterministic sandbox)
      }
      env.declare(d.name, { type: stmt.declType, value, isArray: !!d.array });
    }
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
        return typeof target === 'string' ? target.charCodeAt(i) : target[i];
      }
      case 'Addr':
        return this._lvalue(node.operand, env);
      case 'Deref': {
        const pointer = this._eval(node.operand, env);
        if (!(pointer instanceof Ref)) throw this._err('cannot dereference a non-pointer value', node);
        return pointer.get();
      }
      case 'Call':
        return this._call(node, env);
      default:
        throw this._err(`unsupported expression '${node.type}'`, node);
    }
  }

  _resolveIndex(node, target, env) {
    const raw = typeof node.index === 'object' && node.index.type ? this._eval(node.index, env) : node.index;
    const i = Math.trunc(raw);
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
    if (node.type === 'Index') {
      const target = this._eval(node.array, env);
      if (typeof target === 'string') throw this._err('cannot assign into a string literal', node);
      const i = this._resolveIndex(node, target, env);
      return new Ref(
        () => target[i],
        (v) => {
          target[i] = typeof v === 'number' ? Math.trunc(v) : v;
        },
      );
    }
    if (node.type === 'Deref') {
      const pointer = this._eval(node.operand, env);
      if (!(pointer instanceof Ref)) throw this._err('cannot write through a non-pointer value', node);
      return pointer;
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
        let value = args[i] === undefined ? (p.type.ptr > 0 ? 0 : 0) : args[i];
        if (typeof value === 'number') value = Math.trunc(value);
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

// --------------------------------------------------------------- stdio subset

const BUILTINS = {
  printf(args, rt) {
    const fmt = args.length ? String(args[0]) : '';
    rt.onOutput(formatPrintf(fmt, args.slice(1)));
    return fmt.length;
  },
  puts(args, rt) {
    const s = args.length ? String(args[0]) : '';
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
  strlen(args) {
    return args.length && args[0] != null ? String(args[0]).length : 0;
  },
  atoi(args) {
    const v = parseInt(String(args[0] ?? '0'), 10);
    return Number.isNaN(v) ? 0 : v;
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
