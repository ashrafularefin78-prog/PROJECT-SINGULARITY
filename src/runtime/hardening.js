/**
 * Static hardening audit for the M2 language surface.
 *
 * The runtime sanitizer (src/runtime/sanitizer.js) can only speak about the
 * executions it sees. This module reads the program instead of running it, and
 * its whole design follows from that difference: it reports a thing only when
 * the source proves the thing. `strcpy(dst, src)` is a finding because no bound
 * appears anywhere in the call; `strcpy(dst, "abc")` with `char dst[16]` is not,
 * because 3 + 1 fits in 16 and that arithmetic is visible here. An auditor that
 * guesses is an auditor nobody re-reads, so the limits of this pass are listed
 * in NOT_CHECKED and travel to the panel with the findings.
 *
 * Findings share the runtime's vocabulary: same kinds, same severities, same CWE
 * tags, same advice. One bug should not have two names depending on which
 * checker caught it.
 */
import { parse } from './parser.js';
import { FINDING_KINDS, makeFinding } from './sanitizer.js';

export const AUDIT_VERSION = '1.0';

/**
 * What this pass deliberately does not claim. "We could not find it" and "we did
 * not look" are different sentences, and only the first is a compliment.
 */
export const NOT_CHECKED = Object.freeze([
  'a heap write past the end of a block, or a copy into a pointer whose block size the source never states - an unknown destination is not a proven-small one, so the audit stays quiet there and every arena access is bounds-checked at runtime instead',
  'use after free along a conditional path - the static pass follows straight-line code only, so the runtime is the authority there',
  'integer overflow in an allocation size - that needs the range of a variable, which this pass does not compute',
  'uninitialised local variables - the interpreter zero-fills them, so reading one is defined here even though it is not under a real compiler',
  'anything behind a call boundary - the audit reads one translation unit and does not follow a function into its callers',
]);

const ALLOCATORS = new Set(['malloc', 'calloc', 'realloc']);
/** Calls whose first pointer argument is a destination they can overrun. */
const UNBOUNDED_COPY = new Set(['strcpy', 'strcat', 'stpcpy', 'sprintf', 'vsprintf']);
/** Calls that take a count: [destination argument, count argument]. */
const COUNTED_COPY = { memcpy: [0, 2], memmove: [0, 2], memset: [0, 2], bcopy: [1, 2] };
/** The argument index that holds the format string, per input function. */
const SCAN_FORMAT = { scanf: 0, fscanf: 1, sscanf: 2 };
const PRINT_FORMAT = { printf: 0, vprintf: 0, fprintf: 1, dprintf: 1, sprintf: 2, snprintf: 3, vsnprintf: 3 };
/** Calls that read through a pointer argument, so a released handle is audible. */
const READERS = new Set(['free', 'strcpy', 'strcat', 'stpcpy', 'strlen', 'strcmp', 'memcpy', 'memmove', 'bcopy', 'memset', 'fgets', 'fputs', 'puts', 'sprintf', 'snprintf', 'vsnprintf', 'scanf', 'fscanf', 'sscanf', 'printf', 'fprintf', 'realloc']);

const bytesOf = (base) => (base === 'char' ? 1 : base === 'double' || base === 'long long' ? 8 : 4);

/**
 * The sizes this pass is willing to multiply. `long` and `short` are left out on
 * purpose: their width is the one thing a C program's buffer arithmetic gets to
 * disagree about between targets, and a wrong number here would be worse than no
 * number - it would turn an honest silence into a confident false claim.
 */
const TYPE_BYTES = Object.freeze({ char: 1, 'signed char': 1, 'unsigned char': 1, int: 4, 'unsigned int': 4, 'signed int': 4, float: 4, double: 8, 'long long': 8 });

/** A constant byte count, or null when it depends on anything this pass cannot read. */
function constBytes(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === 'Num') {
    const v = intValue(node);
    return v === null || v < 0 ? null : v;
  }
  if (node.type === 'Sizeof') {
    const t = node.sizeofType;
    if (!t || t.ptr || t.structName || t.enumName) return null;
    return Object.prototype.hasOwnProperty.call(TYPE_BYTES, t.base) ? TYPE_BYTES[t.base] : null;
  }
  if (node.type === 'Binary' && (node.op === '*' || node.op === '+')) {
    const left = constBytes(node.left);
    const right = constBytes(node.right);
    if (left === null || right === null) return null;
    return node.op === '*' ? left * right : left + right;
  }
  return null;
}

/** The room an allocator is asked for, or null when the source does not state it. */
function allocBytes(fn, args) {
  if (fn === 'calloc') {
    const count = constBytes(args[0]);
    const each = constBytes(args[1]);
    return count === null || each === null ? null : count * each;
  }
  return constBytes(fn === 'realloc' ? args[1] : args[0]);
}
const intValue = (node) => (node && node.type === 'Num' && /^-?\d+$/.test(String(node.value)) ? Number(node.value) : null);

/** The identifier a place-expression names, through the address-of, cast and deref wrappers. */
function nameOf(node) {
  if (!node) return null;
  if (node.type === 'Ident') return node.name;
  if (node.type === 'Addr' || node.type === 'Deref' || node.type === 'Cast') return nameOf(node.operand);
  if (node.type === 'Index') return nameOf(node.array);
  return null;
}

/** The widest a conversion can print, or null when it has no bound here. */
const CONV_MAX = { d: 11, i: 11, u: 10, x: 8, X: 8, c: 1 };

/**
 * The longest text a format literal can produce, or null when some part of it
 * depends on data this pass cannot bound - a `%s`, a `%f`, a `*` width. A number
 * here is a proof, so `sprintf(dst, "n=%d", n)` into `char dst[16]` is 15 bytes
 * worst case and is not a finding.
 */
function maxPrinted(format) {
  let total = 0;
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '%') {
      total += 1;
      continue;
    }
    i += 1;
    if (i >= format.length) return null;
    if (format[i] === '%') {
      total += 1;
      continue;
    }
    while (i < format.length && /[-+ #0]/.test(format[i])) {
      // '#' adds a prefix, '+' a sign, ' ' a pad: all three widen the output
      // past the table above, so the bound stops being provable.
      if ('+ #'.includes(format[i])) return null;
      i += 1;
    }
    let width = 0;
    while (i < format.length && /\d/.test(format[i])) width = width * 10 + Number(format[i++]);
    if (format[i] === '*' || format[i] === '.') return null;
    let longs = 0;
    while (i < format.length && format[i] === 'l') {
      longs += 1;
      i += 1;
    }
    while (i < format.length && format[i] === 'h') i += 1;
    if (i >= format.length) return null;
    const base = CONV_MAX[format[i]];
    if (!base) return null;
    total += Math.max(width, longs >= 2 ? 20 : base);
  }
  return total;
}

/** A conversion spec in a format literal, with its field width when one is written. */
function specs(format) {
  const out = [];
  for (let i = 0; i < format.length; i += 1) {
    if (format[i] !== '%') continue;
    i += 1;
    if (format[i] === '%') continue;
    while (i < format.length && /[-+ #0]/.test(format[i])) i += 1;
    let width = '';
    while (i < format.length && /\d/.test(format[i])) width += format[i++];
    while (i < format.length && (format[i] === 'h' || format[i] === 'l')) i += 1;
    if (i >= format.length) break;
    out.push({ conv: format[i], width: width === '' ? null : Number(width) });
  }
  return out;
}

/**
 * One function's knowledge, rebuilt for every FuncDecl.
 *
 * `buffers` knows the size of every array this function or the file declared,
 * which is the single fact most of the checks turn on. `freed` is maintained
 * only while the walk is in straight-line code: a free() inside an `if` says
 * nothing about the line after it, and pretending otherwise is how an audit
 * starts inventing findings.
 */
class FunctionAudit {
  constructor(fn, globals, emit) {
    this.fn = fn;
    this.emit = emit;
    this.buffers = new Map();
    this.locals = new Set();
    this.params = new Set();
    this.freed = new Map();
    this.allocs = new Map();
    this.checked = new Map();
    this.used = new Map();
    for (const [name, info] of globals) this.buffers.set(name, info);
    this.globals = globals;
  }

  run() {
    for (const p of this.fn.params || []) {
      const base = p.type && p.type.base;
      if (p.isArray) this.buffers.set(p.name, { array: false, bytes: 0, base });
      else if (p.type && p.type.ptr) this.buffers.set(p.name, { array: false, bytes: 0, base });
      this.params.add(p.name);
    }
    const returnsPointer = Boolean(this.fn.retType && this.fn.retType.ptr);
    this.statements(this.fn.body && this.fn.body.body, true, returnsPointer);
    this.conclude();
  }

  declare(stmt) {
    if (stmt.type !== 'VarDecl') return;
    for (const d of stmt.decls || []) {
      const type = { base: (stmt.declType && stmt.declType.base) || 'int', ptr: ((stmt.declType && stmt.declType.ptr) || 0) + (d.ptr || 0) };
      this.locals.add(d.name);
      if (d.array) {
        const count = intValue(d.size);
        this.buffers.set(d.name, { array: true, bytes: count === null ? 0 : count * bytesOf(type.base), elems: count, base: type.base });
      } else if (type.ptr) {
        this.buffers.set(d.name, { array: false, bytes: 0, base: type.base });
        this.bind(d.name, d.init, callOf(d.init));
      }
      this.expression(d.init, true);
    }
  }

  /**
   * Note what a handle points at. `malloc(16)` states the size of the block in
   * the source, so a later copy into that handle is comparable; `malloc(n)` does
   * not, and the audit says nothing about a destination whose room it cannot read.
   */
  bind(name, init, call) {
    if (!call) return;
    const fn = calleeOf(call);
    if (!ALLOCATORS.has(fn)) return;
    this.allocs.set(name, { line: call.line, call: fn });
    const bytes = allocBytes(fn, call.args || []);
    if (bytes !== null) this.buffers.set(name, { array: false, bytes, base: null, from: fn });
  }

  /**
   * Walk statements. `straight` is false inside any conditional body, so the
   * only frees and uses recorded there are the ones whose order the source
   * guarantees.
   */
  statements(body, straight, returnsPointer) {
    for (const stmt of body || []) {
      if (!stmt) continue;
      if (stmt.type === 'VarDecl') {
        this.declare(stmt);
        continue;
      }
      if (stmt.type === 'Block') {
        this.statements(stmt.body, straight, returnsPointer);
        continue;
      }
      if (stmt.type === 'If') {
        this.expression(stmt.test, straight);
        this.statements(asList(stmt.then), false, returnsPointer);
        this.statements(asList(stmt.alt), false, returnsPointer);
        if (straight) this.noteChecked(stmt.test);
        continue;
      }
      if (stmt.type === 'For') {
        this.statements(asList(stmt.init), straight, returnsPointer);
        this.expression(stmt.test, straight);
        this.expression(stmt.update, straight);
        if (straight) this.noteChecked(stmt.test);
        this.statements(asList(stmt.body), false, returnsPointer);
        continue;
      }
      if (stmt.type === 'While' || stmt.type === 'DoWhile') {
        this.expression(stmt.test, straight);
        if (straight) this.noteChecked(stmt.test);
        this.statements(asList(stmt.body), false, returnsPointer);
        continue;
      }
      if (stmt.type === 'Switch') {
        this.expression(stmt.disc, straight);
        for (const c of stmt.cases || []) this.statements(asList(c.body), false, returnsPointer);
        continue;
      }
      if (stmt.type === 'Return') {
        if (returnsPointer && stmt.value) this.escape(stmt.value);
        this.expression(stmt.value, straight);
        continue;
      }
      this.expression(stmt.expr || stmt.value || stmt.test || null, straight);
    }
  }

  noteChecked(test) {
    for (const name of namesIn(test)) {
      if (this.allocs.has(name) && !this.checked.has(name)) this.checked.set(name, test.line || 1);
    }
  }

  /** A pointer handed out of the frame it belongs to. */
  escape(value) {
    if (value.type === 'Addr') {
      const name = nameOf(value);
      if (!name || this.globals.has(name)) return;
      if (this.locals.has(name) || this.params.has(name)) {
        this.emit('stack-address-escaped', value, `${name} lives in this function's own frame, and the pointer outlives it`);
      }
      return;
    }
    if (value.type === 'Ident') {
      const info = this.buffers.get(value.name);
      if (info && info.array && this.locals.has(value.name)) {
        this.emit('stack-address-escaped', value, `${value.name} is an array in this function's own frame, and it decays to a pointer on the way out`);
      }
      return;
    }
    if (value.type === 'Cast' || value.type === 'Unary' || value.type === 'Deref') this.escape(value.operand);
    if (value.type === 'Cond') {
      this.escape(value.then);
      this.escape(value.alt);
    }
  }

  expression(node, straight) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Call') {
      this.call(node, straight);
      for (const arg of node.args || []) this.expression(arg, straight);
      return;
    }
    if (node.type === 'Assign' || node.type === 'CompoundAssign') {
      // Only `p = ...` rebinds the handle. `p[0] = ...` writes through it, which
      // is a use, and treating it as a rebinding would hide the missing NULL
      // check on the line that actually dereferences.
      const bound = node.target && node.target.type === 'Ident' ? node.target.name : null;
      if (bound) {
        this.freed.delete(bound);
        this.used.delete(bound);
        this.buffers.set(bound, { array: false, bytes: 0, base: null });
        this.bind(bound, node.value, callOf(node.value));
      }
      this.expression(node.target, straight);
      this.expression(node.value, straight);
      return;
    }
    if (node.type === 'Deref' || node.type === 'MemberPtr' || node.type === 'Index') {
      const name = nameOf(node.operand || node.object || node.array);
      if (name && straight && !this.used.has(name)) this.used.set(name, { line: node.line, node });
      if (name && straight && this.freed.has(name)) {
        this.emit('use-after-free', node, `read through ${name} here, ${node.line - this.freed.get(name)} line(s) after line ${this.freed.get(name)} released it`);
        this.freed.delete(name);
      }
    }
    if (node.type === 'Cond') {
      this.expression(node.test, straight);
      this.expression(node.then, false);
      this.expression(node.alt, false);
      return;
    }
    if (node.type === 'Binary' || node.type === 'Unary' || node.type === 'Addr' || node.type === 'Cast' || node.type === 'Deref' || node.type === 'Member' || node.type === 'Update' || node.type === 'Sizeof') {
      for (const key of ['left', 'right', 'operand', 'object', 'array', 'index', 'sizeofType']) this.expression(node[key], straight);
      return;
    }
    if (node.type === 'InitList') {
      for (const item of node.items || []) this.expression(item, straight);
    }
  }

  call(node, straight) {
    const name = calleeOf(node);
    if (!name) return;
    const args = node.args || [];
    const target = nameOf(args[0]);

    if (name === 'free') {
      if (straight && target) {
        if (this.freed.has(target)) {
          this.emit('double-free', node, `${target} is released again here, after line ${this.freed.get(target)}`);
        } else {
          this.freed.set(target, node.line);
        }
      }
      return;
    }
    if (straight && target && this.freed.has(target) && READERS.has(name)) {
      this.emit('use-after-free', node, `${name}() reads ${target} here, but line ${this.freed.get(target)} released it`);
      this.freed.delete(target);
    }

    if (name === 'gets') {
      this.emit('dangerous-function', node, 'gets() takes no destination size at all, which is why C11 deleted it');
      return;
    }

    if (UNBOUNDED_COPY.has(name)) {
      this.copy(node, name, args);
      return;
    }

    if (name === 'strncpy' || name === 'strncat') {
      this.boundedCopy(node, name, args);
      return;
    }
    if (COUNTED_COPY[name]) {
      this.counted(node, name, args, COUNTED_COPY[name]);
      return;
    }
    if (name === 'snprintf' || name === 'vsnprintf') {
      this.boundedFormat(node, name, args);
      return;
    }

    if (SCAN_FORMAT[name] !== undefined) {
      this.scan(node, name, args, SCAN_FORMAT[name]);
      return;
    }
    if (PRINT_FORMAT[name] !== undefined) {
      const fmt = args[PRINT_FORMAT[name]];
      if (fmt && fmt.type !== 'Str') {
        this.emit('format-string-from-input', node, `the format of ${name}() is not a literal, so whatever it prints chooses the conversions${fmt.type === 'Ident' ? ` (${fmt.name})` : ''}`);
      }
      return;
    }
  }

  copy(node, name, args) {
    const dst = this.info(args[0]);
    const src = args[1];
    const room = dst.bytes ? ` into ${label(args[0], dst)}, which holds ${dst.bytes} byte(s)` : '';
    if (name === 'sprintf' || name === 'vsprintf') {
      const fmt = args[1];
      if (fmt && fmt.type !== 'Str') this.emit('format-string-from-input', node, 'the format of sprintf() is not a literal');
      // A literal whose conversions are all bounded numbers has a worst case the
      // source can compute, so the destination only has to be that much bigger.
      if (fmt && fmt.type === 'Str') {
        const worst = maxPrinted(fmt.value);
        if (worst === null) {
          this.emit('unbounded-copy', node, `sprintf() with the format "${fmt.value}" prints a length this source does not bound into ${label(args[0], dst)}, and the call carries no size to stop at`);
          return;
        }
        if (!dst.bytes || worst + 1 <= dst.bytes) return;
        this.emit('unbounded-copy', node, `sprintf() prints up to ${worst} character(s) plus a NUL${room}`);
        return;
      }
      this.emit('unbounded-copy', node, `sprintf() into ${label(args[0], dst)} writes as much as its arguments produce, and the call carries no size to stop at`);
      return;
    }
    // `strcat` adds to whatever the destination already holds, and that length is
    // written by code this pass does not summarise, so the total has no bound here
    // even when the source does.
    const amount = name === 'strcat' ? null : this.srcBound(src);
    if (amount !== null && (!dst.bytes || amount <= dst.bytes)) return;
    if (amount !== null) {
      this.emit('unbounded-copy', node, `${name}() writes up to ${amount} byte(s) of ${label(src, this.info(src))}${room}`);
      return;
    }
    this.emit('unbounded-copy', node, `${name}() copies ${label(src, this.info(src))} into ${label(args[0], dst)} until the source ends${dst.bytes ? `, past the ${dst.bytes} byte(s) it holds` : ''}, and the call states no bound to stop at`);
  }

  /** The most bytes a NUL-terminated source string can occupy, or null if unstated. */
  srcBound(src) {
    if (!src) return null;
    if (src.type === 'Str') return src.value.length + 1;
    const info = this.info(src);
    return info.bytes ? info.bytes : null;
  }

  boundedCopy(node, name, args) {
    const dst = this.info(args[0]);
    const n = this.constant(args[2]);
    if (!dst.bytes || n === null) return;
    if (n > dst.bytes) {
      this.emit('unbounded-copy', node, `${name}() with n of ${n} writes past ${label(args[0], dst)}, which holds ${dst.bytes} byte(s)`);
      return;
    }
    if (name === 'strncpy' && n === dst.bytes) {
      this.emit('unterminated-string', node, `strncpy() with n of ${n} fills all ${dst.bytes} byte(s) of ${label(args[0], dst)} and writes no NUL when the source is that long`);
    }
    if (name === 'strncat' && n === dst.bytes) {
      this.emit('unbounded-copy', node, `strncat() with n of ${n} adds to what ${label(args[0], dst)} already holds, in a buffer of ${dst.bytes} byte(s)`);
    }
  }

  /** memcpy(), memmove() and memset(): the count is the whole contract with the destination. */
  counted(node, name, args, [dstIndex, countIndex]) {
    const dst = this.info(args[dstIndex]);
    const n = this.constant(args[countIndex]);
    if (!dst.bytes || n === null || n <= dst.bytes) return;
    this.emit('unbounded-copy', node, `${name}() is told ${n} byte(s) but ${label(args[dstIndex], dst)} holds ${dst.bytes}`);
  }

  /**
   * A byte count the source states: a literal, a product or sum of literals, a
   * `sizeof` of a plain type, or the `sizeof` of a buffer this function declared.
   */
  constant(node) {
    if (node && node.type === 'Sizeof' && node.operand) {
      const info = this.info(node.operand);
      return info.bytes ? info.bytes : null;
    }
    return constBytes(node);
  }

  boundedFormat(node, name, args) {
    const dst = this.info(args[0]);
    const size = intValue(args[1]);
    const fmt = args[2];
    if (fmt && fmt.type !== 'Str') this.emit('format-string-from-input', node, `the format of ${name}() is not a literal`);
    if (!dst.bytes) return;
    if (size !== null && size > dst.bytes) {
      this.emit('unbounded-copy', node, `${name}() is told ${size} byte(s) but ${label(args[0], dst)} holds ${dst.bytes}`);
    }
  }

  scan(node, name, args, fmtIndex) {
    const fmt = args[fmtIndex];
    if (!fmt) return;
    if (fmt.type !== 'Str') {
      this.emit('format-string-from-input', node, `the format passed to ${name}() is not a literal, so the input chooses the conversions`);
      return;
    }
    // Conversions before the first string one consume the non-buffer arguments
    // (&n, &c), so the buffer arguments start after them.
    const list = specs(fmt.value);
    const scalar = list.filter((s) => s.conv !== 's' && s.conv !== '[').length;
    const strings = list.filter((s) => s.conv === 's' || s.conv === '[');
    strings.forEach((s, i) => {
      const arg = args[fmtIndex + 1 + scalar + i];
      const info = this.info(arg);
      const width = s.width;
      if (width === null) {
        this.emit('unbounded-scan', node, `%${s.conv} in ${name}() has no field width, so the input decides how much is written${info.bytes ? ` into ${label(arg, info)}, which holds ${info.bytes} byte(s)` : ''}`);
      } else if (info.bytes && width > info.bytes - 1) {
        this.emit('unbounded-scan', node, `%${width}${s.conv} allows ${width} characters plus a NUL in ${label(arg, info)} of ${info.bytes} byte(s)`);
      }
    });
  }

  info(node) {
    const name = nameOf(node);
    const info = name && this.buffers.get(name);
    return info || { array: false, bytes: 0, base: null, name };
  }

  /** The allocation results that were used without ever being tested. */
  conclude() {
    for (const [name, alloc] of this.allocs) {
      const use = this.used.get(name);
      if (!use) continue;
      const checkedAt = this.checked.get(name);
      if (checkedAt === undefined || checkedAt > use.line) {
        this.emit('unchecked-allocation', use.node, `${name} comes from ${alloc.call}() on line ${alloc.line} and is used here before any test for NULL`);
      }
    }
  }
}

const asList = (node) => (!node ? [] : node.type === 'Block' ? [node] : [node]);

function callOf(node) {
  if (!node) return null;
  if (node.type === 'Call') return node;
  if (node.type === 'Cast') return callOf(node.operand);
  return null;
}

const calleeOf = (call) => (call && call.callee && call.callee.type === 'Ident' ? call.callee.name : null);

function namesIn(node) {
  const out = [];
  const seen = new Set();
  const walk = (n) => {
    if (!n || typeof n !== 'object' || seen.has(n)) return;
    seen.add(n);
    if (n.type === 'Ident') out.push(n.name);
    for (const key of Object.keys(n)) {
      if (key === 'line' || key === 'col' || key === 'type') continue;
      const child = n[key];
      if (Array.isArray(child)) child.forEach(walk);
      else walk(child);
    }
  };
  walk(node);
  return out;
}

const label = (node, info) => {
  const name = info.name || nameOf(node) || 'the destination';
  if (info.array) return `${name}[${info.bytes}]`;
  if (info.bytes) return `${name} (a block from ${info.from})`;
  return `${name} (a pointer)`;
};

/**
 * @param {string} source
 * @returns {{ok: boolean, findings: Array, stats: Object, notChecked: string[], error: Object|null}}
 */
export function audit(source) {
  let ast;
  try {
    ast = parse(String(source == null ? '' : source));
  } catch (err) {
    // A program this pass cannot read is a program it cannot accuse.
    return { ok: false, findings: [], stats: { calls: 0, buffers: 0, functions: 0 }, notChecked: NOT_CHECKED, error: { line: (err && err.line) || 1, message: (err && err.message) || String(err) } };
  }

  const globals = new Map();
  for (const decl of ast.globals || []) {
    for (const d of decl.decls || []) {
      if (!d.array) continue;
      const count = intValue(d.size);
      const base = (decl.declType && decl.declType.base) || 'int';
      globals.set(d.name, { array: true, bytes: count === null ? 0 : count * bytesOf(base), base, global: true });
    }
  }

  const findings = [];
  const seen = new Set();
  const emit = (kind, node, detail) => {
    const line = (node && node.line) || 1;
    const key = `${kind}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(makeFinding(kind, { line, col: (node && node.col) || 1, detail: detail || FINDING_KINDS[kind].title }));
  };

  for (const fn of ast.funcs || []) new FunctionAudit(fn, globals, emit).run();

  return {
    ok: true,
    findings: findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind)),
    stats: { functions: (ast.funcs || []).length, globals: globals.size },
    notChecked: NOT_CHECKED,
    error: null,
  };
}
