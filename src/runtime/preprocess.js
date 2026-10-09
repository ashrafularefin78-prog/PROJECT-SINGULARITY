/**
 * M2 - In-browser C compiler: stage 1.5, the preprocessor.
 *
 * The brief's honesty rule is that nothing is claimed unless it works, so this
 * is deliberately a *small but real* preprocessor rather than a stub that
 * ignores directives:
 *
 *   #include <...>  /  #include "..."   accepted and ignored (the standard
 *                                      library is built into the runtime)
 *   #define NAME <replacement text>    object-like macros, usable anywhere a
 *                                      constant or expression is expected
 *   #undef NAME                       forget a macro
 *   #ifdef / #ifndef / #else / #endif conditional compilation
 *   #if / #elif <integer expression>  evaluated with C rules: `defined(X)`,
 *                                      !, &&, ||, comparisons and the usual
 *                                      integer operators; undefined names are 0
 *   #error <text>                     reported as a compile error with position
 *   #pragma / #line                   accepted and ignored
 *
 * Function-like macros (`#define SQ(x) ((x)*(x))`) are *not* expanded, and are
 * rejected with a clear message instead of being silently ignored. That is the
 * one deliberate hole, and it is stated in the docs rather than papered over.
 *
 * Positions survive expansion: a token that came out of a macro carries the
 * line and column of the *use*, which is where the user's caret belongs.
 */
import { CompileError } from './lexer.js';

/** Directives this preprocessor understands. Anything else is an error. */
const KNOWN = new Set([
  'include', 'define', 'undef', 'ifdef', 'ifndef', 'if', 'elif', 'else', 'endif',
  'error', 'pragma', 'line', 'warning',
]);

/** Join continued lines: a directive ending in `\` continues on the next one. */
function joinContinuations(source, start, n) {
  let end = start;
  let text = '';
  for (;;) {
    while (end < n && source[end] !== '\n') {
      end += 1;
    }
    let line = source.slice(start, end);
    const continued = /\\\s*$/.test(line);
    text += continued ? line.slice(0, line.lastIndexOf('\\')) : line;
    if (!continued) return { text, end };
    // The continuation is spliced with a space, so a joined directive is one
    // single logical line (`#define X \` + `2` means `#define X 2`).
    text += ' ';
    end += 1;
    start = end;
  }
}

// ------------------------------------------------- integer expression for #if

function tokenizeIf(text) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      let numeric = '';
      while (j < text.length && /[0-9a-fA-FxX]/.test(text[j])) {
        numeric += text[j];
        j += 1;
      }
      toks.push({ k: 'num', v: /^0[xX]/.test(numeric) ? parseInt(numeric, 16) : parseInt(numeric, 10) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      let name = '';
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) {
        name += text[j];
        j += 1;
      }
      toks.push({ k: 'id', v: name });
      i = j;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const raw = text.slice(i + 1, close === -1 ? i + 2 : close);
      const value = raw.startsWith('\\') ? raw.charCodeAt(1) : raw.charCodeAt(0);
      toks.push({ k: 'num', v: Number.isNaN(value) ? 0 : value });
      i = close === -1 ? i + 2 : close + 1;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(two)) {
      toks.push({ k: 'op', v: two });
      i += 2;
      continue;
    }
    toks.push({ k: 'op', v: c });
    i += 1;
  }
  return toks;
}

/**
 * Evaluate a `#if` expression with C's rules: undefined identifiers are 0,
 * `defined(NAME)` and `defined NAME` test the macro table, and every operator
 * has its C precedence.
 */
function evalIfExpression(text, defined) {
  const toks = tokenizeIf(text);
  let pos = 0;
  const peek = (k = 0) => toks[pos + k] || { k: 'end' };
  const eat = (value) => {
    if (peek().v === value) {
      pos += 1;
      return true;
    }
    return false;
  };
  const expect = (value) => {
    if (!eat(value)) throw new Error(`expected '${value}' in #if expression`);
  };

  const primary = () => {
    const t = peek();
    if (t.k === 'num') {
      pos += 1;
      return t.v;
    }
    if (t.k === 'id') {
      pos += 1;
      if (t.v === 'defined') {
        const hadParen = eat('(');
        const name = peek();
        if (name.k !== 'id') throw new Error('defined() needs a macro name');
        pos += 1;
        if (hadParen) expect(')');
        return defined(name.v) ? 1 : 0;
      }
      return defined(t.v) ? 1 : 0; // C: an undefined identifier is 0
    }
    if (eat('(')) {
      const value = expression();
      expect(')');
      return value;
    }
    throw new Error(`unexpected ${t.k === 'end' ? 'end of expression' : `'${t.v}'`} in #if`);
  };

  const unary = () => {
    if (eat('!')) return unary() ? 0 : 1;
    if (eat('~')) return ~unary();
    if (eat('-')) return -unary();
    if (eat('+')) return unary();
    return primary();
  };

  const binary = (levels) => {
    if (!levels.length) return unary();
    let left = binary(levels.slice(1));
    for (;;) {
      const op = peek().v;
      if (!levels[0].includes(op)) return left;
      pos += 1;
      const right = binary(levels.slice(1));
      left = applyIf(op, left, right);
    }
  };

  const applyIf = (op, a, b) => {
    switch (op) {
      case '*':
        return Math.trunc(a * b);
      case '/':
        return b === 0 ? 0 : Math.trunc(a / b);
      case '%':
        return b === 0 ? 0 : Math.trunc(a % b);
      case '+':
        return Math.trunc(a + b);
      case '-':
        return Math.trunc(a - b);
      case '<':
        return a < b ? 1 : 0;
      case '<=':
        return a <= b ? 1 : 0;
      case '>':
        return a > b ? 1 : 0;
      case '>=':
        return a >= b ? 1 : 0;
      case '==':
        return a === b ? 1 : 0;
      case '!=':
        return a !== b ? 1 : 0;
      case '&':
        return (a & b) | 0;
      case '^':
        return (a ^ b) | 0;
      case '|':
        return (a | b) | 0;
      case '&&':
        return a && b ? 1 : 0;
      case '||':
        return a || b ? 1 : 0;
      default:
        throw new Error(`unsupported operator '${op}' in #if`);
    }
  };

  const expression = () =>
    binary([['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']]);

  const value = expression();
  if (pos < toks.length) throw new Error(`unexpected '${peek().v}' after the #if expression`);
  return value ? 1 : 0;
}

export class Preprocessor {
  constructor() {
    /** name -> { body, line, col } */
    this.macros = new Map();
    /** Conditional nesting; `active` is the AND of every open frame. */
    this.stack = [];
  }

  /** True when the current region of the file is compiled at all. */
  get active() {
    return this.stack.every((frame) => frame.active);
  }

  has(name) {
    return this.macros.has(name) && this.active;
  }

  body(name) {
    return this.macros.get(name).body;
  }

  fail(message, line, col) {
    throw new CompileError('Preprocess', message, line, col);
  }

  /**
   * Handle one directive. `text` is the whole line (continuations joined).
   * Returns nothing; the caller just needs the scan position advanced.
   */
  directive(text, line, col) {
    const raw = text.replace(/^#\s*/, '');
    const m = /^([A-Za-z_][A-Za-z0-9_]*)?/.exec(raw);
    const name = m && m[1] ? m[1] : null;
    const rest = raw.slice(name ? m[0].length : 0).trim();

    if (!name) {
      if (raw.trim() === '') return; // a bare '#'
      this.fail(`expected a directive name after '#'`, line, col);
    }
    if (!KNOWN.has(name)) {
      this.fail(
        `unknown preprocessor directive '#${name}' - this compiler supports #include, #define, #undef, #if/#elif/#ifdef/#ifndef/#else/#endif and #error`,
        line,
        col,
      );
    }

    // Everything below must run even inside a skipped region: the nesting of
    // #if/#endif has to stay balanced or the rest of the file is misread.
    switch (name) {
      case 'include':
      case 'pragma':
      case 'line':
      case 'warning':
        return;
      case 'ifdef':
      case 'ifndef': {
        const macro = rest.split(/[\s(]/)[0];
        if (!macro) this.fail(`#${name} needs a macro name`, line, col);
        const defined = this.macros.has(macro);
        const parentActive = this.active;
        this.stack.push({
          active: parentActive && (name === 'ifdef' ? defined : !defined),
          parentActive,
          taken: name === 'ifdef' ? defined : !defined,
          elseSeen: false,
        });
        return;
      }
      case 'if': {
        const parentActive = this.active;
        let value = false;
        if (parentActive) {
          try {
            value = evalIfExpression(this.expand(rest), (n) => this.macros.has(n)) === 1;
          } catch (err) {
            this.fail(`in #if: ${err.message}`, line, col);
          }
        }
        this.stack.push({ active: parentActive && value, parentActive, taken: value, elseSeen: false });
        return;
      }
      case 'elif': {
        const frame = this.stack[this.stack.length - 1];
        if (!frame) this.fail('#elif without #if', line, col);
        if (frame.elseSeen) this.fail('#elif after #else', line, col);
        if (!frame.parentActive || frame.taken) {
          frame.active = false;
          return;
        }
        let value = false;
        try {
          value = evalIfExpression(this.expand(rest), (n) => this.macros.has(n)) === 1;
        } catch (err) {
          this.fail(`in #elif: ${err.message}`, line, col);
        }
        frame.active = value;
        frame.taken = value;
        return;
      }
      case 'else': {
        const frame = this.stack[this.stack.length - 1];
        if (!frame) this.fail('#else without #if', line, col);
        if (frame.elseSeen) this.fail('two #else directives for one #if', line, col);
        frame.elseSeen = true;
        frame.active = frame.parentActive && !frame.taken;
        frame.taken = frame.taken || frame.active;
        return;
      }
      case 'endif': {
        if (!this.stack.pop()) this.fail('#endif without #if', line, col);
        return;
      }
      case 'define': {
        if (!this.active) return; // a skipped #define must not take effect
        const dm = /^([A-Za-z_][A-Za-z0-9_]*)([\s\S]*)$/.exec(rest);
        if (!dm) this.fail('#define needs a macro name', line, col);
        const macroName = dm[1];
        const after = dm[2];
        if (after.startsWith('(')) {
          this.fail(
            `function-like macro '${macroName}' is not supported - this compiler expands object-like constants (#define NAME value); write it as a function instead`,
            line,
            col,
          );
        }
        this.macros.set(macroName, { body: after.trim(), line, col });
        return;
      }
      case 'undef': {
        if (this.active) this.macros.delete(rest.split(/\s/)[0]);
        return;
      }
      case 'error': {
        if (this.active) this.fail(`#error ${rest}`.trim(), line, col);
        return;
      }
      default:
        this.fail(`unhandled directive '#${name}'`, line, col);
    }
  }

  /**
   * Expand every macro reference in a directive line. Object-like macros only,
   * with a recursion guard, which is exactly what the evaluator above needs.
   */
  expand(text) {
    // `defined(X)` must not have X expanded (C 6.10.1): hide those forms first,
    // hug them back afterwards.
    const guards = [];
    const masked = text.replace(/defined\s*\(?\s*[A-Za-z_][A-Za-z0-9_]*\s*\)?/g, (m) => {
      guards.push(m);
      return `\u0000${guards.length - 1}\u0000`;
    });
    let out = masked;
    for (let pass = 0; pass < 16; pass += 1) {
      let changed = false;
      out = out.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (word) => {
        if (!this.macros.has(word)) return word;
        changed = true;
        return `(${this.macros.get(word).body})`;
      });
      if (!changed) break;
    }
    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => guards[Number(i)]);
  }
}

export { evalIfExpression, joinContinuations };
