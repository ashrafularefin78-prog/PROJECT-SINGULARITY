/**
 * M2 - In-browser C compiler: stage 1, the lexer.
 *
 * Hand-written scanner for the C subset we compile. It strips preprocessor
 * lines (`#include <stdio.h>` is accepted and ignored - the standard library
 * subset is built in), handles comments, and reports precise line/column
 * positions so the editor can underline errors exactly.
 */
import { Preprocessor, joinContinuations } from './preprocess.js';

export class CompileError extends Error {
  constructor(stage, message, line, col) {
    super(`${stage} error at line ${line}, column ${col}: ${message}`);
    this.name = 'CompileError';
    this.stage = stage;
    this.line = line;
    this.col = col;
    this.reason = message;
  }
}

export const KEYWORDS = new Set([
  'int', 'char', 'void', 'long', 'short', 'unsigned', 'signed', 'float', 'double',
  'if', 'else', 'while', 'for', 'do', 'return', 'break', 'continue', 'sizeof', 'const',
  'struct', 'union', 'typedef', 'static', 'switch', 'case', 'default',
  'size_t', 'ptrdiff_t', 'uint32_t', 'int32_t',
]);

export const TYPE_KEYWORDS = new Set([
  'int', 'char', 'void', 'long', 'short', 'unsigned', 'signed', 'float', 'double', 'const', 'static',
  // Accepted as built-in aliases for `int`/`unsigned int`: the standard library
  // functions below return them, and `size_t n = strlen(s);` is ordinary C.
  'size_t', 'ptrdiff_t', 'uint32_t', 'int32_t',
]);

const ESCAPES = {
  n: 10, t: 9, r: 13, '0': 0, a: 7, b: 8, f: 12, v: 11, '\\': 92, "'": 39, '"': 34, '?': 63,
};

const isDigit = (c) => c >= '0' && c <= '9';
const isAlpha = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isAlnum = (c) => isAlpha(c) || isDigit(c);

const OPERATORS = [
  '>>=', '<<=', '...',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':',
  '(', ')', '{', '}', '[', ']', ',', ';', '.',
];

export function tokenize(source) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;
  const pre = new Preprocessor();

  /**
   * Splice the tokens of a macro body in place of the name that was used.
   * C expansion is recursive but never self-recursive; the `blocked` set is
   * what stops `#define A A` from looping, and positions are re-pointed at the
   * use site so a diagnostic underlines the code the user actually wrote.
   */
  const expandMacro = (name, atLine, atCol, blocked, depth) => {
    if (depth > 16) throw new CompileError('Preprocess', `macro '${name}' nests too deeply`, atLine, atCol);
    const bodyTokens = tokenize(pre.body(name));
    const out = [];
    for (const t of bodyTokens) {
      if (t.type === 'eof') continue;
      if (t.type === 'id' && pre.macros.has(t.value) && !blocked.has(t.value)) {
        out.push(...expandMacro(t.value, atLine, atCol, new Set([...blocked, t.value]), depth + 1));
        continue;
      }
      out.push({ ...t, line: atLine, col: atCol });
    }
    return out;
  };

  const push = (type, value, startLine, startCol, extra) =>
    tokens.push({ type, value, line: startLine, col: startCol, ...(extra || {}) });

  while (i < n) {
    const c = source[i];

    // newline
    if (c === '\n') {
      i += 1;
      line += 1;
      col = 1;
      continue;
    }
    // whitespace
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
      col += 1;
      continue;
    }
    // A preprocessor directive runs to the end of the (possibly continued)
    // line, and is interpreted rather than discarded: #define bodies, #ifdef
    // nesting and #error all take effect here.
    if (c === '#') {
      const { text, end } = joinContinuations(source, i, n);
      pre.directive(text, line, col);
      col += end - i;
      i = end;
      continue;
    }
    // Outside any active #if branch: skip the line, but keep parsing directives
    // so the conditional nesting stays balanced.
    if (!pre.active) {
      while (i < n && source[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    // line comment
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        i += 1;
        col += 1;
      }
      continue;
    }
    // block comment
    if (c === '/' && source[i + 1] === '*') {
      const startLine = line;
      const startCol = col;
      i += 2;
      col += 2;
      let closed = false;
      while (i < n) {
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          col += 2;
          closed = true;
          break;
        }
        if (source[i] === '\n') {
          line += 1;
          col = 1;
        } else {
          col += 1;
        }
        i += 1;
      }
      if (!closed) throw new CompileError('Lex', 'unterminated block comment', startLine, startCol);
      continue;
    }
    // number literal
    if (isDigit(c)) {
      const startLine = line;
      const startCol = col;
      let text = '';
      if (c === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X')) {
        text += source[i];
        text += source[i + 1];
        i += 2;
        col += 2;
        while (i < n && /[0-9a-fA-F]/.test(source[i])) {
          text += source[i];
          i += 1;
          col += 1;
        }
      } else {
        while (i < n && (isDigit(source[i]) || source[i] === '.')) {
          text += source[i];
          i += 1;
          col += 1;
        }
        // Exponent, so `1e3`, `2.5e-4` and `1E+10` are one token: without this
        // the lexer stopped at the 'e' and read a variable named `e3`.
        if ((source[i] === 'e' || source[i] === 'E') && /[0-9+-]/.test(source[i + 1] || '')) {
          let j = i + 1;
          if (source[j] === '+' || source[j] === '-') j += 1;
          if (isDigit(source[j] || '')) {
            while (i < j) {
              text += source[i];
              i += 1;
              col += 1;
            }
            while (i < n && isDigit(source[i])) {
              text += source[i];
              i += 1;
              col += 1;
            }
          }
        }
      }
      // A literal is floating-point if it has a fraction, an exponent or an
      // explicit f/F suffix. The runtime needs to know: `7 / 2` is 3, while
      // `7.0 / 2` is 3.5.
      let isFloat = /[.eE]/.test(text);
      // integer / float suffixes
      while (i < n && /[uUlLfF]/.test(source[i])) {
        if (source[i] === 'f' || source[i] === 'F') isFloat = true;
        i += 1;
        col += 1;
      }
      // `parseInt` would stop at the 'e' of `2e3` and quietly return 2, so an
      // exponent or a fraction means parseFloat; only plain integers use
      // parseInt (which is what keeps `010` and `0x10` honest).
      const isHex = /^0[xX]/.test(text);
      const value = isHex
        ? parseInt(text, 16)
        : /[.eE]/.test(text)
          ? parseFloat(text)
          : parseInt(text, 10);
      if (Number.isNaN(value)) throw new CompileError('Lex', `invalid number literal '${text}'`, startLine, startCol);
      // A literal long enough to overflow a double (a 400-digit paste, say)
      // would otherwise become Infinity and flow into arithmetic as a silent
      // value no C program can produce. Reject it at the lexer instead.
      if (!Number.isFinite(value)) {
        throw new CompileError('Lex', `number literal '${text.slice(0, 20)}${text.length > 20 ? '…' : ''}' is out of range`, startLine, startCol);
      }
      push('num', value, startLine, startCol, { float: isFloat });
      continue;
    }
    // identifier / keyword
    if (isAlpha(c)) {
      const startLine = line;
      const startCol = col;
      let text = '';
      while (i < n && isAlnum(source[i])) {
        text += source[i];
        i += 1;
        col += 1;
      }
      if (pre.has(text)) {
        tokens.push(...expandMacro(text, startLine, startCol, new Set([text]), 0));
        continue;
      }
      push(KEYWORDS.has(text) ? 'kw' : 'id', text, startLine, startCol);
      continue;
    }
    // char literal
    if (c === "'") {
      const startLine = line;
      const startCol = col;
      i += 1;
      col += 1;
      let value;
      if (source[i] === '\\') {
        const esc = source[i + 1];
        i += 2;
        col += 2;
        value = ESCAPES[esc];
        if (value === undefined) throw new CompileError('Lex', `unknown escape '\\${esc}'`, line, col - 2);
      } else {
        value = source.charCodeAt(i);
        i += 1;
        col += 1;
      }
      if (source[i] !== "'") throw new CompileError('Lex', 'unterminated character literal', startLine, startCol);
      i += 1;
      col += 1;
      push('num', value, startLine, startCol);
      continue;
    }
    // string literal
    if (c === '"') {
      const startLine = line;
      const startCol = col;
      i += 1;
      col += 1;
      let text = '';
      let closed = false;
      while (i < n) {
        if (source[i] === '"') {
          i += 1;
          col += 1;
          closed = true;
          break;
        }
        if (source[i] === '\\') {
          const esc = source[i + 1];
          const mapped = ESCAPES[esc];
          if (mapped === undefined) throw new CompileError('Lex', `unknown escape '\\${esc}'`, line, col);
          text += String.fromCharCode(mapped);
          i += 2;
          col += 2;
          continue;
        }
        if (source[i] === '\n') throw new CompileError('Lex', 'unterminated string literal', startLine, startCol);
        text += source[i];
        i += 1;
        col += 1;
      }
      if (!closed) throw new CompileError('Lex', 'unterminated string literal', startLine, startCol);
      push('str', text, startLine, startCol);
      continue;
    }
    // operators / punctuation
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      push('op', op, line, col);
      i += op.length;
      col += op.length;
      continue;
    }
    throw new CompileError('Lex', `unexpected character '${c}'`, line, col);
  }

  push('eof', null, line, col);
  return tokens;
}
