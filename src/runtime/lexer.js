/**
 * M2 - In-browser C compiler: stage 1, the lexer.
 *
 * Hand-written scanner for the C subset we compile. It strips preprocessor
 * lines (`#include <stdio.h>` is accepted and ignored - the standard library
 * subset is built in), handles comments, and reports precise line/column
 * positions so the editor can underline errors exactly.
 */

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
  'if', 'else', 'while', 'for', 'return', 'break', 'continue', 'sizeof', 'const',
  'struct', 'static',
]);

export const TYPE_KEYWORDS = new Set([
  'int', 'char', 'void', 'long', 'short', 'unsigned', 'signed', 'float', 'double', 'const', 'static',
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

  const push = (type, value, startLine, startCol) =>
    tokens.push({ type, value, line: startLine, col: startCol });

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
    // preprocessor directive: consume to end of line
    if (c === '#' && [...tokens].length >= 0) {
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
      }
      // integer suffixes
      while (i < n && /[uUlLfF]/.test(source[i])) {
        i += 1;
        col += 1;
      }
      const value = text.includes('.') ? parseFloat(text) : parseInt(text, text.startsWith('0x') || text.startsWith('0X') ? 16 : 10);
      if (Number.isNaN(value)) throw new CompileError('Lex', `invalid number literal '${text}'`, startLine, startCol);
      push('num', value, startLine, startCol);
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
