/**
 * M2 - In-browser C compiler: stage 2, the parser.
 *
 * Recursive descent over the token stream producing an AST. Every node carries
 * the source line it came from, which is what lets the editor place a caret on
 * the exact error position (requirement: "line and column accuracy").
 */
import { CompileError, TYPE_KEYWORDS, tokenize } from './lexer.js';

// Binary operator precedence, loosest first.
const PRECEDENCE = [
  ['||'],
  ['&&'],
  ['|'],
  ['^'],
  ['&'],
  ['==', '!='],
  ['<', '<=', '>', '>='],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '%'],
];

const COMPOUND = new Set(['+=', '-=', '*=', '/=', '%=']);

const normalizeType = (word) => {
  if (word === 'char') return 'char';
  if (word === 'void') return 'void';
  return 'int'; // int, long, short, unsigned, signed, float, double
};

class Parser {
  constructor(tokens) {
    this.toks = tokens;
    this.pos = 0;
  }

  peek(k = 0) {
    return this.toks[Math.min(this.pos + k, this.toks.length - 1)];
  }

  at(type, value, k = 0) {
    const t = this.peek(k);
    return t.type === type && (value === undefined || t.value === value);
  }

  eat(type, value) {
    if (this.at(type, value)) {
      this.pos += 1;
      return this.toks[this.pos - 1];
    }
    return null;
  }

  expect(type, value, what) {
    const t = this.eat(type, value);
    if (!t) {
      const cur = this.peek();
      const got = cur.type === 'eof' ? 'end of input' : `'${cur.value}'`;
      throw new CompileError('Parse', `expected ${what || value || type} but found ${got}`, cur.line, cur.col);
    }
    return t;
  }

  fail(message, tok) {
    const t = tok || this.peek();
    throw new CompileError('Parse', message, t.line, t.col);
  }

  isTypeStart() {
    const t = this.peek();
    return t.type === 'kw' && TYPE_KEYWORDS.has(t.value);
  }

  parseType() {
    if (!this.isTypeStart()) this.fail('expected a type name');
    const start = this.peek();
    let base = null;
    while (this.at('kw') && TYPE_KEYWORDS.has(this.peek().value)) {
      const w = this.peek().value;
      if (w !== 'const' && w !== 'static') base = normalizeType(w);
      this.pos += 1;
    }
    let ptr = 0;
    while (this.at('op', '*')) {
      ptr += 1;
      this.pos += 1;
    }
    return { base: base || 'int', ptr, line: start.line };
  }

  parseProgram() {
    const funcs = [];
    const globals = [];
    while (!this.at('eof')) {
      if (!this.isTypeStart()) this.fail(`unexpected '${this.peek().value}' at top level`);
      const type = this.parseType();
      if (this.at('id') && this.at('op', '(', 1)) {
        funcs.push(this.parseFunction(type));
      } else {
        globals.push({ type: 'VarDecl', declType: type, decls: this.parseDeclarators(), line: type.line });
      }
    }
    return { type: 'Program', funcs, globals };
  }

  parseFunction(retType) {
    const nameTok = this.expect('id', undefined, 'a function name');
    this.expect('op', '(');
    const params = [];
    if (this.at('kw', 'void') && this.at('op', ')', 1)) {
      this.pos += 1; // `f(void)` is idiomatic C for "no parameters"
    } else if (!this.at('op', ')')) {
      do {
        const ptype = this.parseType();
        const pname = this.expect('id', undefined, 'a parameter name');
        let isArray = false;
        if (this.eat('op', '[')) {
          this.eat('op', ']');
          isArray = true;
        }
        params.push({ type: ptype, name: pname.value, isArray, line: pname.line });
      } while (this.eat('op', ','));
    }
    this.expect('op', ')');
    const body = this.parseBlock();
    return { type: 'FuncDecl', name: nameTok.value, retType, params, body, line: nameTok.line };
  }

  parseBlock() {
    const open = this.expect('op', '{');
    const body = [];
    while (!this.at('op', '}')) {
      if (this.at('eof')) this.fail('unterminated block: expected "}"', open);
      body.push(this.parseStatement());
    }
    this.expect('op', '}');
    return { type: 'Block', body, line: open.line };
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'kw') {
      if (TYPE_KEYWORDS.has(t.value)) return this.parseDeclStatement();
      if (t.value === 'if') return this.parseIf();
      if (t.value === 'while') return this.parseWhile();
      if (t.value === 'for') return this.parseFor();
      if (t.value === 'return') {
        this.pos += 1;
        let value = null;
        if (!this.at('op', ';')) value = this.parseExpression();
        this.expect('op', ';');
        return { type: 'Return', value, line: t.line };
      }
      if (t.value === 'break') {
        this.pos += 1;
        this.expect('op', ';');
        return { type: 'Break', line: t.line };
      }
      if (t.value === 'continue') {
        this.pos += 1;
        this.expect('op', ';');
        return { type: 'Continue', line: t.line };
      }
    }
    if (this.at('op', '{')) return this.parseBlock();
    if (this.eat('op', ';')) return { type: 'Empty', line: t.line };
    const expr = this.parseExpression();
    this.expect('op', ';', '";"');
    return { type: 'ExprStmt', expr, line: t.line };
  }

  parseDeclStatement() {
    const type = this.parseType();
    return {
      type: 'VarDecl',
      declType: type,
      decls: this.parseDeclarators(),
      line: this.toks[Math.max(0, this.pos - 1)].line,
    };
  }

  parseDeclarators() {
    const decls = [];
    do {
      let ptr = 0;
      while (this.at('op', '*')) {
        ptr += 1;
        this.pos += 1;
      }
      const nameTok = this.expect('id', undefined, 'a variable name');
      let array = false;
      let size = null;
      let init = null;
      if (this.eat('op', '[')) {
        if (!this.at('op', ']')) size = this.parseExpression();
        this.expect('op', ']');
        array = true;
      }
      if (this.eat('op', '=')) {
        init = this.at('op', '{') ? this.parseInitList() : this.parseExpression();
      }
      decls.push({ name: nameTok.value, array, size, init, ptr, line: nameTok.line });
    } while (this.eat('op', ','));
    this.expect('op', ';');
    return decls;
  }

  parseInitList() {
    const open = this.expect('op', '{');
    const items = [];
    if (!this.at('op', '}')) {
      do {
        items.push(this.at('op', '{') ? this.parseInitList() : this.parseExpression());
      } while (this.eat('op', ',') && !this.at('op', '}'));
    }
    this.expect('op', '}');
    return { type: 'InitList', items, line: open.line };
  }

  parseIf() {
    const kw = this.expect('kw', 'if');
    this.expect('op', '(');
    const test = this.parseExpression();
    this.expect('op', ')');
    const then = this.parseStatement();
    let alt = null;
    if (this.eat('kw', 'else')) alt = this.parseStatement();
    return { type: 'If', test, then, alt, line: kw.line };
  }

  parseWhile() {
    const kw = this.expect('kw', 'while');
    this.expect('op', '(');
    const test = this.parseExpression();
    this.expect('op', ')');
    const body = this.parseStatement();
    return { type: 'While', test, body, line: kw.line };
  }

  parseFor() {
    const kw = this.expect('kw', 'for');
    this.expect('op', '(');
    let init = null;
    if (this.at('op', ';')) {
      this.pos += 1;
    } else if (this.isTypeStart()) {
      init = this.parseDeclStatement();
    } else {
      const expr = this.parseExpression();
      this.expect('op', ';');
      init = { type: 'ExprStmt', expr, line: expr.line };
    }
    const test = this.at('op', ';') ? null : this.parseExpression();
    this.expect('op', ';');
    const update = this.at('op', ')') ? null : this.parseExpression();
    this.expect('op', ')');
    const body = this.parseStatement();
    return { type: 'For', init, test, update, body, line: kw.line };
  }

  // ------------------------------------------------------------ expressions

  parseExpression() {
    const left = this.parseBinary(0);
    if (this.at('op', '=')) {
      this.pos += 1;
      const value = this.parseExpression();
      return { type: 'Assign', target: left, value, line: left.line };
    }
    const t = this.peek();
    if (t.type === 'op' && COMPOUND.has(t.value)) {
      this.pos += 1;
      const value = this.parseExpression();
      return { type: 'CompoundAssign', op: t.value[0], target: left, value, line: left.line };
    }
    return left;
  }

  parseBinary(level) {
    if (level >= PRECEDENCE.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    while (this.at('op') && PRECEDENCE[level].includes(this.peek().value)) {
      const op = this.peek().value;
      this.pos += 1;
      const right = this.parseBinary(level + 1);
      left = { type: 'Binary', op, left, right, line: left.line };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.type === 'op' && ['!', '-', '+', '~', '&', '*'].includes(t.value)) {
      this.pos += 1;
      const operand = this.parseUnary();
      const kind =
        t.value === '&' ? 'Addr' : t.value === '*' ? 'Deref' : 'Unary';
      return { type: kind, op: t.value, operand, line: t.line };
    }
    if (t.type === 'op' && (t.value === '++' || t.value === '--')) {
      this.pos += 1;
      return { type: 'Update', op: t.value, operand: this.parseUnary(), prefix: true, line: t.line };
    }
    if (t.type === 'kw' && t.value === 'sizeof') {
      this.pos += 1;
      this.expect('op', '(');
      let size = 4;
      if (this.isTypeStart()) {
        const type = this.parseType();
        size = type.base === 'char' ? 1 : type.ptr > 0 ? 8 : 4;
      }
      this.expect('op', ')');
      return { type: 'Num', value: size, line: t.line };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.at('op', '[')) {
        this.pos += 1;
        const index = this.parseExpression();
        this.expect('op', ']');
        node = { type: 'Index', array: node, index, line: node.line };
        continue;
      }
      if (this.at('op', '(')) {
        this.pos += 1;
        const args = [];
        if (!this.at('op', ')')) {
          do {
            args.push(this.parseExpression());
          } while (this.eat('op', ','));
        }
        this.expect('op', ')');
        node = { type: 'Call', callee: node, args, line: node.line };
        continue;
      }
      if (this.at('op', '++') || this.at('op', '--')) {
        const op = this.peek().value;
        this.pos += 1;
        node = { type: 'Update', op, operand: node, prefix: false, line: node.line };
        continue;
      }
      break;
    }
    return node;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') {
      this.pos += 1;
      return { type: 'Num', value: t.value, line: t.line };
    }
    if (t.type === 'str') {
      this.pos += 1;
      return { type: 'Str', value: t.value, line: t.line };
    }
    if (t.type === 'id') {
      this.pos += 1;
      return { type: 'Ident', name: t.value, line: t.line };
    }
    if (this.at('op', '(')) {
      this.pos += 1;
      const expr = this.parseExpression();
      this.expect('op', ')');
      return expr;
    }
    this.fail(`unexpected ${t.type === 'eof' ? 'end of input' : `'${t.value}'`} in expression`, t);
    return null;
  }
}

export function parse(source) {
  const tokens = Array.isArray(source) ? source : tokenize(source);
  return new Parser(tokens).parseProgram();
}
