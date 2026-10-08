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
    if (t.type !== 'kw') return false;
    return TYPE_KEYWORDS.has(t.value) || t.value === 'struct';
  }

  /**
   * A type is a base name (`int`, `char`, ...) plus zero or more `*`, with an
   * optional `struct Name` (and, in a declaration, the field list that defines
   * it). Struct definitions are attached to the type node so `parseProgram`
   * can register the layout once, wherever the definition appears.
   */
  parseType() {
    if (!this.isTypeStart()) this.fail('expected a type name');
    const start = this.peek();
    let base = null;
    let structName = null;
    let structDef = null;
    while (
      this.at('kw') &&
      (TYPE_KEYWORDS.has(this.peek().value) || this.peek().value === 'struct')
    ) {
      const w = this.peek().value;
      if (w === 'struct') {
        this.pos += 1;
        const nameTok = this.expect('id', undefined, 'a struct name');
        structName = nameTok.value;
        base = 'struct';
        if (this.at('op', '{')) structDef = this.parseStructFields(nameTok);
        continue;
      }
      if (w !== 'const' && w !== 'static') base = normalizeType(w);
      this.pos += 1;
    }
    let ptr = 0;
    while (this.at('op', '*')) {
      ptr += 1;
      this.pos += 1;
    }
    return { base: base || 'int', ptr, structName, structDef, line: start.line };
  }

  /** `{ int x; struct Point inner; char name[8]; ... }` */
  parseStructFields(nameTok) {
    this.expect('op', '{');
    const fields = [];
    while (!this.at('op', '}')) {
      if (this.at('eof')) this.fail('unterminated struct: expected "}"', nameTok);
      const fieldType = this.parseType();
      if (this.eat('op', ';')) continue; // tolerate a stray semicolon
      do {
        let ptr = 0;
        while (this.at('op', '*')) {
          ptr += 1;
          this.pos += 1;
        }
        const name = this.expect('id', undefined, 'a field name');
        let array = false;
        if (this.eat('op', '[')) {
          if (!this.at('op', ']')) this.parseExpression();
          this.expect('op', ']');
          array = true;
        }
        // parseType already consumed any `*` directly after the type name, so
        // add the ones that came after it (`struct Node **links`).
        fields.push({ name: name.value, type: { ...fieldType, ptr: fieldType.ptr + ptr }, array });
      } while (this.eat('op', ','));
      this.expect('op', ';');
    }
    this.expect('op', '}');
    return { name: nameTok.value, fields, line: nameTok.line };
  }

  parseProgram() {
    const funcs = [];
    const globals = [];
    const structs = [];
    while (!this.at('eof')) {
      if (!this.isTypeStart()) this.fail(`unexpected '${this.peek().value}' at top level`);
      // `struct Point { int x; int y; };` - a definition with no declarator.
      if (this.at('kw', 'struct') && this.at('id', undefined, 1) && this.at('op', '{', 2)) {
        const defType = this.parseType();
        if (defType.structDef) structs.push(defType.structDef);
        if (this.eat('op', ';')) continue;
        globals.push({
          type: 'VarDecl',
          declType: defType,
          decls: this.parseDeclarators(),
          line: defType.line,
        });
        continue;
      }
      const type = this.parseType();
      if (type.structDef) structs.push(type.structDef);
      if (this.at('id') && this.at('op', '(', 1)) {
        funcs.push(this.parseFunction(type));
      } else {
        globals.push({ type: 'VarDecl', declType: type, decls: this.parseDeclarators(), line: type.line });
      }
    }
    return { type: 'Program', funcs, globals, structs };
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
      if (t.value === 'struct') return this.parseStructStatement();
      if (t.value === 'switch') return this.parseSwitch();
      if (t.value === 'do') return this.parseDoWhile();
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

  /**
   * `struct Point { int x; int y; };` or `struct Point p;` inside a function.
   * A definition with no declarator becomes a StructDef statement, which the
   * runtime registers when execution reaches it.
   */
  parseStructStatement() {
    const type = this.parseType();
    if (this.eat('op', ';')) {
      return { type: 'StructDef', defs: type.structDef ? [type.structDef] : [], line: type.line };
    }
    return {
      type: 'VarDecl',
      declType: type,
      decls: this.parseDeclarators(),
      line: type.line,
    };
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

  /**
   * `switch (x) { case 1: ...; break; default: ...; }`
   *
   * Case bodies are kept in source order, because C falls through: execution
   * starts at the matching label and runs until `break` or the end of the
   * switch. That is why the AST stores a list of labelled runs, not a map.
   */
  parseSwitch() {
    const kw = this.expect('kw', 'switch');
    this.expect('op', '(');
    const disc = this.parseExpression();
    this.expect('op', ')');
    this.expect('op', '{');
    const cases = [];
    let current = null;
    while (!this.at('op', '}')) {
      if (this.at('eof')) this.fail('unterminated switch: expected "}"', kw);
      if (this.at('kw', 'case')) {
        this.pos += 1;
        const test = this.parseExpression();
        this.expect('op', ':');
        current = { test, body: [], line: test.line };
        cases.push(current);
        continue;
      }
      if (this.at('kw', 'default')) {
        this.pos += 1;
        this.expect('op', ':');
        current = { test: null, body: [], line: this.peek().line };
        cases.push(current);
        continue;
      }
      if (!current) this.fail('statement in a switch outside any case label');
      current.body.push(this.parseStatement());
    }
    this.expect('op', '}');
    return { type: 'Switch', disc, cases, line: kw.line };
  }

  parseDoWhile() {
    const kw = this.expect('kw', 'do');
    const body = this.parseStatement();
    this.expect('kw', 'while');
    this.expect('op', '(');
    const test = this.parseExpression();
    this.expect('op', ')');
    this.expect('op', ';');
    return { type: 'DoWhile', test, body, line: kw.line };
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
    // Ternary conditional: looser than ||, tighter than assignment, and
    // right-associative so `a ? b : c ? d : e` nests the way C does.
    if (this.at('op', '?')) {
      this.pos += 1;
      const then = this.parseExpression();
      this.expect('op', ':', '":" in a conditional expression');
      const alt = this.parseExpression();
      return { type: 'Cond', test: left, then, alt, line: left.line };
    }
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

  /** True when the next '(' begins a cast such as `(int)` or `(struct Node *)`. */
  isCastStart() {
    if (!this.at('op', '(')) return false;
    const t = this.peek(1);
    return t.type === 'kw' && (TYPE_KEYWORDS.has(t.value) || t.value === 'struct');
  }

  parseUnary() {
    const t = this.peek();
    if (this.isCastStart()) {
      this.pos += 1;
      const castType = this.parseType();
      this.expect('op', ')', '")" closing a cast');
      const operand = this.parseUnary();
      return { type: 'Cast', castType, operand, line: t.line };
    }
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
      // `sizeof(type)` is resolved at parse time (layout is static);
      // `sizeof expr` needs the runtime value for arrays and structs.
      if (this.isTypeStart()) {
        const type = this.parseType();
        this.expect('op', ')');
        return { type: 'Sizeof', sizeofType: type, operand: null, line: t.line };
      }
      const operand = this.parseExpression();
      this.expect('op', ')');
      return { type: 'Sizeof', sizeofType: null, operand, line: t.line };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let node = this.parsePrimary();
    for (;;) {
      if (this.at('op', '.') || this.at('op', '->')) {
        const viaPointer = this.peek().value === '->';
        this.pos += 1;
        const name = this.expect('id', undefined, 'a struct field name');
        node = {
          type: viaPointer ? 'MemberPtr' : 'Member',
          object: node,
          name: name.value,
          line: node.line,
        };
        continue;
      }
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
