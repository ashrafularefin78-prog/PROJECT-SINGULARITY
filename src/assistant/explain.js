/**
 * SINGU explainer - read the generated (or pasted) C back to its owner.
 *
 * The panel can show a program and a trace, but "why does this work" needs the
 * structure: which functions exist, what they call, how deeply loops nest,
 * whether recursion or the heap is involved. That is a walk over the M2 parser's
 * AST, not a second model, and it fails honestly on code that does not parse.
 */

import { parse } from '../runtime/parser.js';

export const EXPLAIN_VERSION = '1.0';

const IO_CALLS = new Set(['printf', 'puts', 'putchar', 'scanf', 'sscanf', 'sprintf', 'fgets', 'fputs']);
const ALLOC_CALLS = new Set(['malloc', 'calloc', 'realloc']);

const typeText = (type) => {
  if (!type) return '?';
  if (type.structName) {
    const name = type.structName.startsWith('__anon') ? 'struct (anonymous)' : `struct ${type.structName}`;
    return `${name}${'*'.repeat(type.ptr || 0)}`;
  }
  if (type.enumName) return `enum ${type.enumName}${'*'.repeat(type.ptr || 0)}`;
  return `${type.base || '?'}${'*'.repeat(type.ptr || 0)}`;
};

/** Enough C syntax to make a loop condition readable; not a pretty-printer. */
function render(node, depth = 0) {
  if (node == null || depth > 6) return '…';
  if (typeof node !== 'object') return String(node);
  switch (node.type) {
    case 'Num':
      return String(node.value);
    case 'Str':
      return JSON.stringify(node.value);
    case 'Char':
      return `'${node.value}'`;
    case 'Ident':
      return node.name;
    case 'Binary':
      return `(${render(node.left, depth + 1)} ${node.op} ${render(node.right, depth + 1)})`;
    case 'Unary':
      return `${node.op}${render(node.operand, depth + 1)}`;
    case 'Addr':
      return `&${render(node.operand, depth + 1)}`;
    case 'Deref':
      return `*${render(node.operand, depth + 1)}`;
    case 'Update':
      return node.prefix ? `${node.op}${render(node.operand, depth + 1)}` : `${render(node.operand, depth + 1)}${node.op}`;
    case 'Assign':
      return `(${render(node.target, depth + 1)} = ${render(node.value, depth + 1)})`;
    case 'CompoundAssign':
      return `(${render(node.target, depth + 1)} ${node.op}= ${render(node.value, depth + 1)})`;
    case 'Call':
      return `${render(node.callee, depth + 1)}(${(node.args || []).map((arg) => render(arg, depth + 1)).join(', ')})`;
    case 'Index':
      return `${render(node.array, depth + 1)}[${render(node.index, depth + 1)}]`;
    case 'Member':
      return `${render(node.object, depth + 1)}.${node.name}`;
    case 'MemberPtr':
      return `${render(node.object, depth + 1)}->${node.name}`;
    case 'Cast':
      return `(${typeText(node.castType)})${render(node.operand, depth + 1)}`;
    case 'Cond':
      return `(${render(node.test, depth + 1)} ? ${render(node.then, depth + 1)} : ${render(node.alt, depth + 1)})`;
    case 'Sizeof':
      return node.sizeofType ? `sizeof(${typeText(node.sizeofType)})` : `sizeof(${render(node.operand, depth + 1)})`;
    default:
      return node.type || '…';
  }
}

function scanFunction(fn) {
  const calls = new Set();
  const arrays = [];
  let loops = 0;
  let branches = 0;
  let maxLoopDepth = 0;
  let returns = 0;
  let valueReturns = 0;
  const unbounded = [];

  const visit = (node, loopDepth) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, loopDepth);
      return;
    }
    switch (node.type) {
      case 'For':
        loops += 1;
        maxLoopDepth = Math.max(maxLoopDepth, loopDepth + 1);
        if (!node.test) unbounded.push({ line: node.line, kind: 'for' });
        visit(node.init, loopDepth);
        visit(node.test, loopDepth);
        visit(node.update, loopDepth);
        visit(node.body, loopDepth + 1);
        return;
      case 'While':
      case 'DoWhile':
        loops += 1;
        maxLoopDepth = Math.max(maxLoopDepth, loopDepth + 1);
        visit(node.test, loopDepth);
        visit(node.body, loopDepth + 1);
        return;
      case 'If':
        branches += 1;
        visit(node.test, loopDepth);
        visit(node.then, loopDepth);
        visit(node.alt, loopDepth);
        return;
      case 'Switch':
        branches += 1;
        visit(node.disc, loopDepth);
        for (const item of node.cases || []) {
          visit(item.test, loopDepth);
          visit(item.body, loopDepth);
        }
        return;
      case 'Call':
        if (node.callee && node.callee.type === 'Ident') calls.add(node.callee.name);
        visit(node.args, loopDepth);
        return;
      case 'Return':
        returns += 1;
        if (node.value) valueReturns += 1;
        visit(node.value, loopDepth);
        return;
      case 'VarDecl':
        for (const decl of node.decls || []) {
          if (decl.array) {
            arrays.push({
              name: decl.name,
              type: typeText(node.declType),
              size: decl.size ? render(decl.size) : '[]',
              multi: Array.isArray(decl.dims) && decl.dims.length > 0,
            });
          }
          visit(decl.init, loopDepth);
        }
        return;
      case 'Block':
        visit(node.body, loopDepth);
        return;
      default:
        for (const [key, value] of Object.entries(node)) {
          if (key === 'type' || key === 'line') continue;
          visit(value, loopDepth);
        }
    }
  };

  visit(fn.body, 0);
  const name = fn.name;
  const retType = typeText(fn.retType);
  const signature = `${retType} ${name}(${(fn.params || []).map((param) => `${typeText(param.type)} ${param.name}${param.isArray ? '[]' : ''}`).join(', ') || 'void'})`;
  return {
    name,
    line: fn.line,
    signature,
    retType,
    params: (fn.params || []).map((param) => `${typeText(param.type)} ${param.name}${param.isArray ? '[]' : ''}`),
    loops,
    maxLoopDepth,
    branches,
    calls: [...calls].sort(),
    io: [...calls].filter((call) => IO_CALLS.has(call)).sort(),
    allocs: [...calls].filter((call) => ALLOC_CALLS.has(call)).sort(),
    frees: calls.has('free'),
    recursive: calls.has(name),
    returns,
    valueReturns,
    arrays,
    unbounded,
  };
}

const empty = () => ({ functions: [], globals: [], structs: [], enums: [], protos: [] });

/**
 * Explain one program. Always returns `{ ok, summary, ... }`; when the parser
 * rejects the source, `error` carries the same stage/line/column the sandbox
 * would report and the structural lists stay empty.
 */
export function explain(code) {
  const source = String(code == null ? '' : code);
  if (!source.trim()) {
    return {
      ok: false,
      error: { stage: 'Explain', message: 'There is no C source to explain.', line: 0, col: 0 },
      summary: ['There is no C source to explain yet. Generate a program or paste one into the compiler.'],
      ...empty(),
      stats: { functions: 0, loops: 0, branches: 0, maxLoopDepth: 0, allocs: 0, frees: 0, recursion: [] },
    };
  }

  let ast;
  try {
    ast = parse(source);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const line = (error && error.line) || 0;
    const col = (error && error.col) || 0;
    return {
      ok: false,
      error: { stage: (error && error.stage) || 'Parse', message, line, col },
      summary: [`This C does not parse, so its structure cannot be explained. ${message}`],
      ...empty(),
      stats: { functions: 0, loops: 0, branches: 0, maxLoopDepth: 0, allocs: 0, frees: 0, recursion: [] },
    };
  }

  const functions = (ast.funcs || []).map(scanFunction);
  const locals = functions.flatMap((fn) => fn.arrays.map((array) => ({ ...array, fn: fn.name })));
  const globals = (ast.globals || []).flatMap((decl) => (decl.decls || []).map((item) => ({
    name: item.name,
    type: typeText(decl.declType),
    array: Boolean(item.array),
    size: item.size ? render(item.size) : null,
  })));
  const structs = (ast.structs || []).map((item) => ({ name: item.name, fields: (item.fields || []).length, line: item.line }));
  const enums = (ast.enums || []).map((item) => ({ name: item.name, line: item.line }));
  const protos = (ast.protos || []).map((item) => item.name);

  const loops = functions.reduce((total, fn) => total + fn.loops, 0);
  const branches = functions.reduce((total, fn) => total + fn.branches, 0);
  const maxLoopDepth = functions.reduce((max, fn) => Math.max(max, fn.maxLoopDepth), 0);
  const calls = new Set(functions.flatMap((fn) => fn.calls));
  const allocs = functions.reduce((total, fn) => total + fn.allocs.length, 0);
  const frees = functions.filter((fn) => fn.frees).length;
  const recursion = functions.filter((fn) => fn.recursive).map((fn) => fn.name);
  const io = [...new Set(functions.flatMap((fn) => fn.io))].sort();

  const summary = [];
  const main = functions.find((fn) => fn.name === 'main');
  summary.push(
    main
      ? `Entry point: ${main.signature} at line ${main.line}.`
      : 'No main() was found; this source is a library of functions, not a runnable program.',
  );
  if (functions.length) {
    summary.push(`${functions.length} function(s), ${globals.length} global(s), ${structs.length} struct(s), ${enums.length} enum(s)${protos.length ? `, ${protos.length} prototype(s)` : ''}.`);
  }
  for (const fn of functions) {
    const shape = [];
    const isVoid = fn.retType === 'void';
    if (fn.loops) shape.push(`${fn.loops} loop(s), nested up to ${fn.maxLoopDepth}`);
    if (fn.branches) shape.push(`${fn.branches} branch(es)`);
    if (fn.calls.length) shape.push(`calls ${fn.calls.join(', ')}`);
    if (fn.recursive) shape.push('recursive');
    if (!isVoid && fn.returns === 0) shape.push('no return statement');
    else if (!isVoid && fn.valueReturns === 0) shape.push('returns no value');
    summary.push(`${fn.signature}${shape.length ? ` - ${shape.join('; ')}` : ' - straight-line code'}.`);
  }
  if (io.length) summary.push(`I/O: ${io.join(', ')}.`);
  else if (functions.length) summary.push('No I/O calls: the program computes without reading input or printing a trace.');
  if (allocs) {
    summary.push(`Heap: ${allocs} allocation call(s) across ${functions.filter((fn) => fn.allocs.length).length} function(s); ${frees ? 'free is called' : 'free is never called'}.`);
  }
  if (recursion.length) summary.push(`Recursion: ${recursion.join(', ')} calls itself.`);
  if (locals.length) {
    summary.push(`Local arrays: ${locals.map((array) => `${array.type} ${array.name}[${array.size}] in ${array.fn}`).join('; ')}.`);
  }
  if (globals.length) {
    summary.push(`Globals: ${globals.map((item) => `${item.type} ${item.name}${item.array ? `[${item.size}]` : ''}`).join('; ')}.`);
  }
  if (structs.length) {
    summary.push(`Structs: ${structs.map((item) => `${item.name} (${item.fields} field(s))`).join(', ')}.`);
  }
  if (maxLoopDepth >= 2) {
    summary.push(`Deepest loop nesting is ${maxLoopDepth}; if every loop runs over n, the work grows like O(n^${maxLoopDepth}).`);
  }
  for (const fn of functions) {
    for (const item of fn.unbounded) {
      summary.push(`Warning: the for loop at line ${item.line} in ${fn.name} has no test; only a break or return inside can end it.`);
    }
    if (!fn.recursive && fn.returns > 0 && fn.valueReturns === 0 && fn.retType !== 'void') {
      summary.push(`Warning: ${fn.name} returns a value by signature but every return is bare.`);
    }
  }
  const getsUse = /\bgets\s*\(/.exec(source);
  if (getsUse) {
    const line = source.slice(0, getsUse.index).split('\n').length;
    summary.push(`Warning: gets() at line ${line} cannot be bounded; use fgets with a size.`);
  }

  return {
    ok: true,
    error: null,
    functions,
    globals,
    structs,
    enums,
    protos,
    stats: { functions: functions.length, loops, branches, maxLoopDepth, calls: [...calls].sort(), allocs, frees, recursion, io },
    summary,
  };
}
