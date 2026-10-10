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
  'struct', 'union', 'enum', 'typedef', 'static', 'switch', 'case', 'default',
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
  '##',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>',
  '+', '-', '*', '/', '%', '=', '<', '>', '!', '&', '|', '^', '~', '?', ':', '#',
  '(', ')', '{', '}', '[', ']', ',', ';', '.',
];

export function tokenize(source, { fragment = false } = {}) {
  const tokens = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let col = 1;
  // A '#' only starts a directive at the start of a line (C 6.10). Tracked so
  // `#param` inside a macro body can be the stringize operator instead.
  let lineStart = true;
  const pre = new Preprocessor();

  /** Consume source up to `end`, keeping line/column exact across newlines. */
  const advanceTo = (end) => {
    while (i < end) {
      if (source[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };

  /** The spelling of a token, for `##` pasting. */
  const textOf = (t) => (t.text !== undefined ? t.text : String(t.value));

  // Fragment mode: a macro body or argument is not a translation unit, so a
  // leading '#' is the stringize operator rather than the start of a directive.
  const fragmentTokens = (text, atLine, atCol) => {
    const out = [];
    for (const t of tokenize(text, { fragment: true })) {
      if (t.type === 'eof') continue;
      out.push({ ...t, line: atLine, col: atCol });
    }
    return out;
  };

  /**
   * Split a token list at the top level of a call's argument list.
   * `open` indexes the '(' token; the return value is one entry per argument
   * plus the index just past the matching ')'. Returns null when unbalanced.
   */
  const groupArguments = (list, open) => {
    if (!(list[open] && list[open].type === 'op' && list[open].value === '(')) return null;
    const args = [];
    let current = [];
    let depth = 0;
    let brackets = 0;
    for (let k = open; k < list.length; k += 1) {
      const t = list[k];
      if (t.type === 'op' && (t.value === '(' || t.value === '[' || t.value === '{')) {
        depth += 1;
        if (depth === 1 && t.value === '(') continue;
      }
      if (t.type === 'op' && (t.value === ')' || t.value === ']' || t.value === '}')) {
        depth -= 1;
        if (depth === 0 && t.value === ')') return { args: args.concat([current]).map(asArgument), end: k + 1 };
      }
      if (t.type === 'op' && t.value === ',' && depth === 1) {
        args.push(current);
        current = [];
        continue;
      }
      current.push(t);
    }
    return null;
  };

  const asArgument = (list) => ({
    raw: list.map(textOf).join(' '),
    tokens: list,
  });

  /** Replace the two tokens around '##' with the single token they spell. */
  const pasteTokens = (left, rightText, atLine, atCol) => {
    const combined = textOf(left) + rightText;
    const pasted = tokenize(combined, { fragment: true }).filter((t) => t.type !== 'eof');
    if (pasted.length !== 1) {
      throw new CompileError(
        'Preprocess',
        `pasting '${textOf(left)}' and '${rightText}' does not produce one token`,
        atLine,
        atCol,
      );
    }
    return [{ ...pasted[0], line: atLine, col: atCol }];
  };

  /**
   * Expand a function-like macro call.
   *
   * Arguments are macro-expanded before substitution (C 6.10.3.1); an argument
   * used with `#` or `##` keeps its spelling instead, which is the whole point
   * of those operators. The result is expanded again, so a pasted name that
   * happens to be a macro still expands.
   */
  const expandFunction = (name, macro, args, atLine, atCol, blocked, depth) => {
    if (depth > 16) throw new CompileError('Preprocess', `macro '${name}' nests too deeply`, atLine, atCol);
    const index = new Map(macro.params.map((p, k) => [p, k]));
    const argAt = (k) => args[k] || { raw: '', tokens: [] };
    // Arguments expand in the caller's context: `SQ(SQ(2))` is legal C, so the
    // name being expanded is only disabled while its own body is rescanned.
    const expandedArg = (k) => expandTokens(argAt(k).tokens, blocked, atLine, atCol, depth + 1);
    const vaTokens = () => {
      const out = [];
      args.slice(macro.params.length).forEach((arg, k) => {
        if (k) out.push({ type: 'op', value: ',', text: ',', line: atLine, col: atCol });
        out.push(...expandTokens(arg.tokens, blocked, atLine, atCol, depth + 1));
      });
      return out;
    };
    const innerBlocked = new Set([...blocked, name]);
    const body = fragmentTokens(macro.body, atLine, atCol);
    const out = [];
    for (let k = 0; k < body.length; k += 1) {
      const t = body[k];
      // `#param` - the argument's spelling as a string literal.
      if (t.type === 'op' && t.value === '#' && body[k + 1] && body[k + 1].type === 'id' && index.has(body[k + 1].value)) {
        const raw = argAt(index.get(body[k + 1].value)).raw.replace(/\s+/g, ' ').trim();
        out.push({ type: 'str', value: raw, text: '"' + raw + '"', line: atLine, col: atCol });
        k += 1;
        continue;
      }
      // `a ## b` - paste without expanding the operands first.
      if (t.type === 'op' && t.value === '##') {
        const rhs = body[k + 1];
        if (!out.length || !rhs) {
          throw new CompileError('Preprocess', `'##' needs a token on both sides in macro '${name}'`, atLine, atCol);
        }
        const rightText = rhs.type === 'id' && index.has(rhs.value) ? argAt(index.get(rhs.value)).raw : textOf(rhs);
        out.splice(out.length - 1, 1, ...pasteTokens(out[out.length - 1], rightText, atLine, atCol));
        k += 1;
        continue;
      }
      // A parameter next to '##' contributes its raw tokens, not its expansion.
      if (t.type === 'id' && index.has(t.value)) {
        const next = body[k + 1];
        const pasteOperand = next && next.type === 'op' && next.value === '##';
        out.push(...(pasteOperand ? argAt(index.get(t.value)).tokens : expandedArg(index.get(t.value))));
        continue;
      }
      if (t.type === 'id' && macro.va && t.value === '__VA_ARGS__') {
        out.push(...vaTokens());
        continue;
      }
      out.push(t);
    }
    return expandTokens(out, innerBlocked, atLine, atCol, depth);
  };

  /**
   * Expand every macro reference in a token list.
   * C expansion is recursive but never self-recursive; the `blocked` set is what
   * stops `#define A A` from looping, and positions are re-pointed at the use
   * site so a diagnostic underlines the code the user actually wrote.
   */
  const expandTokens = (list, blocked, atLine, atCol, depth) => {
    const out = [];
    for (let k = 0; k < list.length; k += 1) {
      const t = list[k];
      if (t.type === 'id' && pre.macros.has(t.value) && !blocked.has(t.value)) {
        const macro = pre.macros.get(t.value);
        if (macro.params) {
          const open = list[k + 1];
          const call = open && open.type === 'op' && open.value === '(' ? groupArguments(list, k + 1) : null;
          if (!call) {
            // C: a function-like macro name with no argument list stays an
            // ordinary identifier; the parser reports it if it is undefined.
            out.push({ ...t, line: atLine, col: atCol });
            continue;
          }
          if (depth > 16) throw new CompileError('Preprocess', `macro '${t.value}' nests too deeply`, atLine, atCol);
          out.push(...expandFunction(t.value, macro, call.args, atLine, atCol, blocked, depth + 1));
          k = call.end - 1;
          continue;
        }
        if (depth > 16) throw new CompileError('Preprocess', `macro '${t.value}' nests too deeply`, atLine, atCol);
        out.push(...expandTokens(fragmentTokens(macro.body, atLine, atCol), new Set([...blocked, t.value]), atLine, atCol, depth + 1));
        continue;
      }
      out.push({ ...t, line: atLine, col: atCol });
    }
    return out;
  };

  /**
   * A function-like macro call as it is *written*: the arguments are sliced out
   * of the source so `#arg` sees the original spelling. Returns null when the
   * name is not followed by '(', which is not an error in C.
   */
  const scanMacroCall = (start) => {
    let j = start;
    for (;;) {
      const c = source[j];
      if (c === undefined) return null;
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') {
        j += 1;
        continue;
      }
      if (c === '/' && source[j + 1] === '/') {
        while (j < n && source[j] !== '\n') j += 1;
        continue;
      }
      if (c === '/' && source[j + 1] === '*') {
        j += 2;
        while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
        j += 2;
        continue;
      }
      break;
    }
    if (source[j] !== '(') return null;
    const raws = [];
    let depth = 0;
    let argStart = j + 1;
    while (j < n) {
      const c = source[j];
      if (c === '"' || c === "'") {
        const quote = c;
        j += 1;
        while (j < n && source[j] !== quote) {
          if (source[j] === '\\') j += 1;
          j += 1;
        }
        j += 1;
        continue;
      }
      if (c === '/' && source[j + 1] === '*') {
        j += 2;
        while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j += 1;
        j += 2;
        continue;
      }
      if (c === '/' && source[j + 1] === '/') {
        while (j < n && source[j] !== '\n') j += 1;
        continue;
      }
      if (c === '(') {
        depth += 1;
        j += 1;
        continue;
      }
      if (c === ')') {
        depth -= 1;
        if (depth === 0) {
          raws.push(source.slice(argStart, j));
          return { raws, end: j + 1 };
        }
        j += 1;
        continue;
      }
      if (c === ',' && depth === 1) {
        raws.push(source.slice(argStart, j));
        argStart = j + 1;
        j += 1;
        continue;
      }
      j += 1;
    }
    return null; // unterminated: the parser reports the imbalance
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
      lineStart = true;
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
    if (c === '#' && lineStart && !fragment) {
      const { text, end } = joinContinuations(source, i, n);
      pre.directive(text, line, col);
      advanceTo(end);
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
      push('num', value, startLine, startCol, { float: isFloat, text });
      lineStart = false;
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
      lineStart = false;
      if (pre.has(text)) {
        const macro = pre.macros.get(text);
        if (macro.params) {
          const call = scanMacroCall(i);
          if (call) {
            const args = call.raws.map((raw) => {
              const trimmed = raw.trim();
              return { raw: trimmed, tokens: fragmentTokens(trimmed, startLine, startCol) };
            });
            tokens.push(...expandFunction(text, macro, args, startLine, startCol, new Set(), 0));
            advanceTo(call.end);
            continue;
          }
          push('id', text, startLine, startCol, { text });
          continue;
        }
        tokens.push(...expandTokens(fragmentTokens(macro.body, startLine, startCol), new Set([text]), startLine, startCol, 0));
        continue;
      }
      push(KEYWORDS.has(text) ? 'kw' : 'id', text, startLine, startCol, { text });
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
      lineStart = false;
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
      lineStart = false;
      continue;
    }
    // operators / punctuation
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (op) {
      push('op', op, line, col, { text: op });
      i += op.length;
      col += op.length;
      lineStart = false;
      continue;
    }
    throw new CompileError('Lex', `unexpected character '${c}'`, line, col);
  }

  push('eof', null, line, col);
  return tokens;
}
