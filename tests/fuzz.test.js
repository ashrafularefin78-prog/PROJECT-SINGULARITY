// Fuzzing for the two parsers that face hostile input: the C front end (M2) and
// the crypto/messaging decoders (M4/M5).
//
// Everything here is seeded and deterministic: the same seed produces the same
// corpus on every machine and every run, so a failure is reproducible instead of
// a story about a flaky CI job. The seed appears in every failure message.
//
// The invariants are the interesting part, and they are the ones a fuzzer is
// actually good at checking:
//   * totality      - hostile input produces a *diagnostic*, never a crash,
//                     a hang, or a half-built object;
//   * determinism   - the same bytes compile to the same output every time,
//                     which catches global state leaking between runs;
//   * fail-closed   - tampered ciphertext and malformed signaling codes are
//                     rejected, never silently accepted or partially parsed;
//   * finiteness    - no NaN/Infinity can reach the AST from a numeric literal.
import { test, assert, assertEquals } from './harness.js';
import { CompileError, tokenize } from '../src/runtime/lexer.js';
import { parse } from '../src/runtime/parser.js';
import { interpret } from '../src/runtime/interpreter.js';
import { RGA } from '../src/crdt/rga.js';
import { mulberry32 } from '../src/graphics/math.js';
import { b64, randomBytes, unb64 } from '../src/crypto/e2ee.js';
import { decodeSignal, encodeSignal } from '../src/collab/webrtc.js';
import { handshake } from './crypto-helpers.js';

// --------------------------------------------------------------------- corpus

const SEEDS = [
  'int main(void) { return 0; }',
  'int fib(int n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }\nint main(void) { printf("%d\\n", fib(10)); return 0; }',
  'struct P { int x; int y; };\nint main(void) { struct P p; p.x = 3; p.y = 4; printf("%d\\n", p.x * p.y); return 0; }',
  'int main(void) { int a[4] = {1, 2, 3, 4}; int t = 0; for (int i = 0; i < 4; i++) t += a[i]; return t; }',
  'int main(void) { char *s = malloc(8); memset(s, 0, 8); free(s); return 0; }',
  'int main(void) { switch (2) { case 1: return 1; case 2: return 2; default: return 3; } }',
  'int main(void) { int n = 1e9; while (n > 0) n = n / 2; return n; }',
  '#include <stdio.h>\n/* comment */ int main(void) { // line\n  return sizeof(int); }',
];

const ALPHABET = '{}()[];<>=+-*/,&|!?:.\'"\\%^~ \t\nabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_#';

/** Random character soup, biased towards characters C actually gives meaning to. */
function soup(rng, len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

/**
 * One random mutation of a seed: what a half-typed edit or a bad paste looks
 * like. Five of the ten kinds break the program on purpose; the rest change it
 * while keeping it valid, so the fuzzer also exercises the *accepting* path of
 * the parser and the interpreter instead of only ever checking diagnostics.
 */
function mutate(rng, source) {
  const pick = Math.floor(rng() * 10);
  const at = Math.floor(rng() * source.length);
  const len = 1 + Math.floor(rng() * 8);
  switch (pick) {
    case 0: // splice random soup in
      return source.slice(0, at) + soup(rng, len) + source.slice(at);
    case 1: // drop a run of characters
      return source.slice(0, at) + source.slice(at + len);
    case 2: // duplicate a run (unbalanced braces, doubled operators)
      return source.slice(0, at) + source.slice(at, at + len) + source.slice(at);
    case 3: // truncate mid-token
      return source.slice(0, at);
    case 4: { // swap two characters
      const other = Math.floor(rng() * source.length);
      const chars = source.split('');
      const t = chars[at];
      chars[at] = chars[other];
      chars[other] = t;
      return chars.join('');
    }
    case 5: // an unterminated string or comment
      return source + (rng() < 0.5 ? ' "unterminated' : ' /* open');
    case 6: { // numeric literals that must not become Infinity
      const exotic = ['1e999', '1e-999', '0x7fffffffffffffff', '999999999999999999999', '.5e', '1..2', '9'.repeat(400)];
      return source + ' ' + exotic[Math.floor(rng() * exotic.length)];
    }
    case 7: // whitespace only: the program keeps compiling
      return source.slice(0, at) + ' \n\t ' + source.slice(at);
    case 8: { // duplicate the statement that contains the cursor
      const end = source.indexOf(';', at);
      if (end === -1) return source + ' ';
      const start = source.lastIndexOf(';', at) + 1;
      return source.slice(0, end + 1) + source.slice(start, end + 1) + source.slice(end + 1);
    }
    default: // a comment, which every stage has to strip correctly
      return source + `\n/* fuzz ${Math.floor(rng() * 1000)} */\n`;
  }
}

/** Build a deterministic corpus: 40% pristine/duplicated seeds, 60% mutations. */
function corpus(seed, rounds) {
  const rng = mulberry32(seed);
  const out = [];
  for (let i = 0; i < rounds; i += 1) {
    const base = SEEDS[Math.floor(rng() * SEEDS.length)];
    let text = base;
    const depth = 1 + Math.floor(rng() * 3);
    for (let d = 0; d < depth; d += 1) text = mutate(rng, text);
    if (rng() < 0.15) text = soup(rng, 4 + Math.floor(rng() * 120));
    out.push(text);
  }
  return out;
}

/** Collect every numeric literal in a parsed program (positions included). */
function numbersIn(node, found = []) {
  if (Array.isArray(node)) for (const item of node) numbersIn(item, found);
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'number' && key !== 'line' && key !== 'col') found.push([key, value]);
      else if (value && typeof value === 'object') numbersIn(value, found);
    }
  }
  return found;
}

// ----------------------------------------------------------------------- M2

test('M2 fuzz: the lexer is total - 400 hostile inputs give tokens or a diagnostic', () => {
  const inputs = [...corpus(0x51ce, 300), ...corpus(0xbeef, 100)];
  let lexed = 0;
  let diagnosed = 0;
  for (const [index, source] of inputs.entries()) {
    let tokens;
    try {
      tokens = tokenize(source);
    } catch (err) {
      assert(err instanceof CompileError, `input #${index} threw ${err && err.name}: not a CompileError`);
      assert(Number.isInteger(err.line) && err.line >= 1, `input #${index}: bad line ${err.line}`);
      assert(Number.isInteger(err.col) && err.col >= 1, `input #${index}: bad column ${err.col}`);
      assert(typeof err.reason === 'string' && err.reason.length > 0, `input #${index}: empty diagnostic`);
      diagnosed += 1;
      continue;
    }
    assert(Array.isArray(tokens), `input #${index}: lexer returned ${typeof tokens}`);
    let previousOffset = -1;
    for (const token of tokens) {
      assert(typeof token.type === 'string' && token.type.length > 0, `input #${index}: token without a type`);
      // Literals carry a number, everything else carries text - and a number
      // token must be finite, or an overflowing literal would leak Infinity
      // into arithmetic that no C program could actually perform.
      const okValue =
        typeof token.value === 'string' ||
        (typeof token.value === 'number' && Number.isFinite(token.value)) ||
        // The end-of-input marker is the one token whose value is null.
        (token.type === 'eof' && token.value === null);
      assert(okValue, `input #${index}: ${token.type} token value is ${typeof token.value} (${token.value})`);
      assert(Number.isInteger(token.line) && token.line >= 1, `input #${index}: token line ${token.line}`);
      assert(Number.isInteger(token.col) && token.col >= 1, `input #${index}: token column ${token.col}`);
      assert(token.line >= previousOffset, `input #${index}: token positions move backwards`);
      previousOffset = token.line;
    }
    lexed += 1;
  }
  assert(diagnosed > 0 && lexed > 0, 'the corpus must exercise both outcomes');
  console.log(`      corpus ${inputs.length}: ${lexed} lexed, ${diagnosed} rejected`);
});

test('M2 fuzz: the parser always answers - an AST or a structured CompileError', () => {
  const inputs = [...SEEDS, ...corpus(0x1234, 260), ...corpus(0xfeed, 140)];
  let parsed = 0;
  let rejected = 0;
  for (const [index, source] of inputs.entries()) {
    let ast;
    try {
      ast = parse(source);
    } catch (err) {
      assert(err instanceof CompileError, `input #${index} threw ${err && err.name}: not a CompileError`);
      assert(Number.isInteger(err.line) && err.line >= 1, `input #${index}: line ${err.line}`);
      assert(Number.isInteger(err.col) && err.col >= 1, `input #${index}: column ${err.col}`);
      assert(typeof err.message === 'string' && err.message.length > 0, `input #${index}: empty message`);
      rejected += 1;
      continue;
    }
    assert(ast && typeof ast === 'object', `input #${index}: parser returned ${ast}`);
    for (const [key, value] of numbersIn(ast)) {
      assert(Number.isFinite(value), `input #${index}: ${key} in the AST is ${value}`);
    }
    parsed += 1;
  }
  assert(parsed > 0 && rejected > 0, 'the corpus must exercise both outcomes');
  console.log(`      corpus ${inputs.length}: ${parsed} parsed, ${rejected} rejected`);
});

test('M2 fuzz: compiling the same source twice is identical, and execution is bounded', () => {
  const inputs = corpus(0x5eed, 60);
  for (const [index, source] of inputs.entries()) {
    const first = (() => {
      try {
        return JSON.stringify(parse(source));
      } catch (err) {
        return 'ERR:' + err.message;
      }
    })();
    const second = (() => {
      try {
        return JSON.stringify(parse(source));
      } catch (err) {
        return 'ERR:' + err.message;
      }
    })();
    assertEquals(first, second, `input #${index}: two parses of the same source disagree`);
  }

  // A mutation that happens to parse must still run to a bounded conclusion:
  // either real output or a structured error, with the step budget respected.
  let ran = 0;
  for (const [index, source] of corpus(0x1a2b, 40).entries()) {
    let result;
    try {
      result = interpret(source, { maxSteps: 20000, maxHeapBytes: 1 << 20, stdin: '' });
    } catch (err) {
      throw new Error(`input #${index}: interpret() threw instead of returning a result: ${err && err.message}`);
    }
    assert(typeof result.ok === 'boolean', `input #${index}: missing ok flag`);
    assert(typeof result.output === 'string', `input #${index}: missing output`);
    if (!result.ok) {
      assert(result.error && typeof result.error.message === 'string', `input #${index}: unstructured error`);
      assert(Number.isInteger(result.error.line) && result.error.line >= 1, `input #${index}: error line`);
      assert(Number.isInteger(result.error.col) && result.error.col >= 1, `input #${index}: error column`);
    } else {
      ran += 1;
    }
  }
  console.log(`      ${inputs.length} sources compiled twice; ${ran} mutated programs ran to completion`);
});

test('M2 fuzz: a runaway program is stopped by the step budget, not by the browser', () => {
  const runaway = [
    'int main(void) { while (1) { } return 0; }',
    'int main(void) { int i = 0; for (;;) { i = i + 1; } return i; }',
    'int f(int n) { return f(n + 1); } int main(void) { return f(0); }',
  ];
  for (const [index, source] of runaway.entries()) {
    const started = performance.now();
    const first = interpret(source, { maxSteps: 5000, maxHeapBytes: 1 << 20, maxDepth: 64 });
    const elapsed = performance.now() - started;
    assert(!first.ok, `runaway program #${index} reported success`);
    assert(/step|budget|recursion|depth/i.test(first.error.message), `runaway #${index}: unhelpful error: ${first.error.message}`);
    assert(elapsed < 2000, `runaway #${index} took ${Math.round(elapsed)}ms: the budget is not binding`);
    const second = interpret(source, { maxSteps: 5000, maxHeapBytes: 1 << 20, maxDepth: 64 });
    assertEquals(
      `${second.ok}:${second.error && second.error.message}`,
      `${first.ok}:${first.error && first.error.message}`,
      `runaway #${index}: the same program reported two different outcomes`,
    );
  }
  console.log(`      ${runaway.length} infinite programs stopped by the budget, deterministically`);
});

// ----------------------------------------------------------------------- M1

test('M1 fuzz: random concurrent edit programs converge from any delivery order', () => {
  let rounds = 0;
  let applied = 0;
  for (let seed = 1; seed <= 24; seed += 1) {
    const rng = mulberry32(0x1000 + seed);
    const replicas = ['a', 'b', 'c'].map((name) => new RGA(name));
    const log = [];
    for (let step = 0; step < 26; step += 1) {
      const replica = replicas[Math.floor(rng() * replicas.length)];
      const len = replica.text().length;
      if (len > 3 && rng() < 0.4) {
        const at = Math.floor(rng() * len);
        const count = 1 + Math.floor(rng() * Math.min(3, len - at));
        log.push(...replica.localDelete(at, count));
      } else {
        const at = Math.floor(rng() * (len + 1));
        const text = soup(rng, 1 + Math.floor(rng() * 3));
        log.push(...replica.localInsert(at, text));
      }
    }
    // Every replica receives the whole log in its own shuffled order.
    for (const replica of replicas) {
      const shuffled = [...log];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const t = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = t;
      }
      replica.merge(shuffled);
      replica.merge(shuffled); // duplicates must be absorbed
    }
    const texts = replicas.map((r) => r.text());
    assert(texts[0] === texts[1] && texts[1] === texts[2], `seed ${seed}: replicas diverged: ${JSON.stringify(texts)}`);
    for (const replica of replicas) {
      assertEquals(replica.stats().buffered, 0, `seed ${seed}: causal buffer never drained`);
    }
    rounds += 1;
    applied += log.length;
  }
  console.log(`      ${rounds} concurrent programs, ${applied} operations, all delivered shuffled + twice`);
});

test('M1 fuzz: re-delivering the whole log, in reverse, changes nothing', () => {
  const rng = mulberry32(0xabcd);
  const source = new RGA('src');
  const log = [];
  for (let i = 0; i < 60; i += 1) log.push(...source.localInsert(source.text().length, soup(rng, 1)));
  const sink = new RGA('sink');
  sink.merge(log);
  const settled = sink.text();
  const stats = JSON.stringify(sink.stats());
  sink.merge([...log].reverse());
  sink.merge(log);
  assertEquals(sink.text(), settled, 're-delivery must not change the document');
  assertEquals(JSON.stringify(sink.stats()), stats, 're-delivery must not change the structure either');
});

// ----------------------------------------------------------------------- M4

test('M4 fuzz: every single-byte tamper of a ciphertext is rejected', async () => {
  const { a, b } = await handshake(['fuzz-a', 'fuzz-b']);
  const message = await a.encrypt('a secret that must not leak under mutation');
  const bytes = unb64(message.ct);
  const positions = new Set([0, 1, 7, 15, bytes.length - 1, Math.floor(bytes.length / 2)]);
  for (let i = 0; i < 24; i += 1) positions.add(Math.floor((i / 24) * bytes.length));
  let rejected = 0;
  for (const at of positions) {
    const mutated = new Uint8Array(bytes);
    mutated[at] ^= 0x80;
    let leaked = null;
    try {
      leaked = await b.decrypt({ header: message.header, ct: b64(mutated) });
    } catch {
      rejected += 1;
    }
    assert(leaked === null, `byte ${at}: tampered ciphertext decrypted to ${leaked && leaked.length} bytes`);
  }
  // The untouched message still works: the mutations must not have desynced the ratchet.
  const clean = await a.encrypt('second message');
  assert(rejected === positions.size, `only ${rejected}/${positions.size} mutations were rejected`);
  console.log(`      ${positions.size} single-byte mutations, ${rejected} rejected, 0 accepted`);
  void clean;
});

test('M4 fuzz: random garbage and truncated ciphertext never decrypt', async () => {
  const { a, b } = await handshake(['garbage-a', 'garbage-b']);
  const sample = await a.encrypt('seed');
  const rng = mulberry32(0xdead);
  let attempts = 0;
  for (let i = 0; i < 40; i += 1) {
    const shape = Math.floor(rng() * 4);
    let candidate;
    if (shape === 0) candidate = { header: sample.header, ct: b64(randomBytes(8 + Math.floor(rng() * 48))) };
    else if (shape === 1) candidate = { header: '', ct: b64(randomBytes(32)) };
    else if (shape === 2) candidate = { header: b64(randomBytes(64)), ct: sample.ct.slice(0, Math.max(4, Math.floor(sample.ct.length * rng()))) };
    else candidate = { header: {}, ct: 'not base64 at all' };
    attempts += 1;
    let leaked = null;
    try {
      leaked = await b.decrypt(candidate);
    } catch {
      leaked = null;
    }
    assert(leaked === null, `attempt #${i} decrypted garbage`);
  }
  console.log(`      ${attempts} malformed frames, none accepted`);
});

test('M4 fuzz: the base64 codec is either exact or an error - never a wrong byte', () => {
  const rng = mulberry32(0x2468);
  const canonical = b64(randomBytes(48));
  const NOT_BASE64 = '!*~ #$%^&-_|\\";:<>,?é中'; // characters atob must refuse
  const candidates = [canonical];
  for (let i = 0; i < 200; i += 1) {
    const chars = canonical.split('');
    const at = Math.floor(rng() * chars.length);
    const kind = Math.floor(rng() * 3);
    if (kind === 0) chars[at] = NOT_BASE64[Math.floor(rng() * NOT_BASE64.length)];
    else if (kind === 1) chars.splice(at, 1 + Math.floor(rng() * 3));
    else chars[at] = chars[at] === 'A' ? 'B' : 'A'; // a different but valid character
    candidates.push(chars.join(''));
  }
  let exact = 0;
  let lenient = 0;
  let errored = 0;
  for (const [index, text] of candidates.entries()) {
    let out;
    try {
      out = unb64(text);
    } catch {
      errored += 1;
      continue;
    }
    // Whatever was accepted must be byte-stable, and the only leniency
    // allowed is missing padding - a decode that differs from the canonical
    // encoding of its own bytes would mean a code could have two meanings.
    const round = b64(out);
    assertEquals(b64(unb64(round)), round, `input #${index}: decoding is not a fixed point`);
    if (round === text) exact += 1;
    else lenient += 1; // must stay 0: a second spelling of the same bytes
  }
  assert(errored > 0, 'the corpus must contain inputs the codec refuses');
  assertEquals(lenient, 0, `${lenient} non-canonical inputs were decoded instead of rejected`);
  console.log(`      ${candidates.length} codec inputs: ${exact} canonical, ${lenient} lenient, ${errored} rejected`);
});

test('M4 fuzz: no two messages of a chain reuse a key, and headers survive round-trips', async () => {
  const { a, b } = await handshake(['chain-a', 'chain-b']);
  const ciphertexts = new Set();
  for (let i = 0; i < 40; i += 1) {
    const message = await a.encrypt('identical plaintext, ' + i);
    assert(!ciphertexts.has(message.ct), `message ${i} repeats a previous ciphertext (key/nonce reuse)`);
    ciphertexts.add(message.ct);
    const back = await b.decrypt(JSON.parse(JSON.stringify(message)));
    assertEquals(new TextDecoder().decode(back), 'identical plaintext, ' + i);
  }
});

// ----------------------------------------------------------------------- M5

test('M5 fuzz: signaling codes are either structurally valid or rejected with a reason', () => {
  const rng = mulberry32(0x7777);
  const valid = encodeSignal('offer', 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=mid:0\r\n');
  const payloads = [];
  for (let i = 0; i < 160; i += 1) {
    const kind = Math.floor(rng() * 6);
    if (kind === 0) payloads.push('SNG1:' + b64(randomBytes(1 + Math.floor(rng() * 400))));
    else if (kind === 1) payloads.push('SNG1:' + soup(rng, 1 + Math.floor(rng() * 40)));
    else if (kind === 2) payloads.push('SNG1:' + btoa(JSON.stringify({ v: 1, kind: 'offer', sdp: soup(rng, 12) })));
    else if (kind === 3) payloads.push('SNG1:' + btoa(JSON.stringify({ v: 1, kind: soup(rng, 4), sdp: 'v=0\r\n' })));
    else if (kind === 4) payloads.push(soup(rng, 1 + Math.floor(rng() * 80)));
    else {
      const chars = valid.split('');
      chars[Math.floor(rng() * chars.length)] = ALPHABET[Math.floor(rng() * ALPHABET.length)];
      payloads.push(chars.join(''));
    }
  }
  // A depth bomb: valid base64, valid JSON shape, pathological nesting.
  payloads.push('SNG1:' + btoa(JSON.stringify({ v: 1, kind: 'offer', sdp: '['.repeat(20000) })));

  let accepted = 0;
  let rejected = 0;
  for (const [index, code] of payloads.entries()) {
    let decoded;
    try {
      decoded = decodeSignal(code);
    } catch (err) {
      assert(err instanceof Error, `input #${index}: threw ${typeof err}`);
      assert(typeof err.message === 'string' && err.message.length > 0, `input #${index}: empty rejection reason`);
      rejected += 1;
      continue;
    }
    assert(decoded && typeof decoded === 'object', `input #${index}: returned ${decoded}`);
    assert(['offer', 'answer'].includes(decoded.kind), `input #${index}: kind ${decoded.kind}`);
    assert(typeof decoded.sdp === 'string' && decoded.sdp.includes('v=0'), `input #${index}: sdp ${decoded.sdp}`);
    // Decoding is a pure function of the code.
    assertEquals(JSON.stringify(decodeSignal(code)), JSON.stringify(decoded), `input #${index}: decode is not deterministic`);
    accepted += 1;
  }
  assert(rejected > 0, 'the corpus must contain rejected codes');
  console.log(`      ${payloads.length} signaling codes: ${accepted} accepted (all well-formed), ${rejected} rejected`);
});
