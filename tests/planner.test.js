/**
 * M9 - planner.
 *
 * Two engines, one brief shape. These tests pin the arbitration: everyday
 * programs go to the composer, systems programs go to the catalogue, and an
 * explicit choice is honoured unless that engine has nothing to offer.
 */
import { test, assert, assertEquals } from './harness.js';
import { ENGINE_LABELS, PLANNER_VERSION, plan } from '../src/assistant/planner.js';
import { interpret } from '../src/runtime/interpreter.js';

const SHAPE = ['ok', 'engine', 'prompt', 'title', 'summary', 'level', 'confidence', 'matched',
  'code', 'plan', 'notes', 'hazards', 'teaches', 'complexity', 'params', 'tests', 'steps',
  'aside', 'alternatives'];

test('planner: everyday briefs go to the composer', () => {
  assertEquals(PLANNER_VERSION, '1.0');
  assertEquals(ENGINE_LABELS.composer, 'Composer');
  const cases = {
    'the average of numbers from stdin': 'Mean (average)',
    'reverse a string': 'Reverse a string',
    'check whether a string is a palindrome': 'Palindrome check',
    'fizzbuzz up to 20': 'FizzBuzz',
  };
  for (const [brief, title] of Object.entries(cases)) {
    const result = plan(brief);
    assertEquals(result.engine, 'composer', brief);
    assertEquals(result.title, title, brief);
    assert(result.tests.length >= 1, `${brief} ships acceptance tests`);
    assertEquals(result.recipe, undefined, 'composer plans carry no catalogue recipe');
  }
});

test('planner: systems briefs go to the systems catalogue', () => {
  const cases = {
    'a linked list': 'Singly linked list with reverse and cycle check',
    'a hash table with string keys': 'Chained hash table',
    'a ring buffer for a producer and consumer': 'Fixed-capacity ring buffer',
    'an arena allocator': 'Arena (bump) allocator',
    'a lock-free single-producer single-consumer queue': 'Single-producer / single-consumer queue',
  };
  for (const [brief, title] of Object.entries(cases)) {
    const result = plan(brief);
    assertEquals(result.engine, 'catalogue', brief);
    assertEquals(result.title, title, brief);
    assertEquals(result.tests.length, 0, 'catalogue plans rely on a smoke run');
    assert(result.recipe && result.recipe.id, `${brief} exposes the recipe`);
  }
});

test('planner: a systems brief that borrows an everyday word stays in the catalogue', () => {
  const result = plan('sort a linked list');
  assertEquals(result.engine, 'catalogue');
  assertEquals(result.recipe.id, 'linked-list');
  assert(result.code.includes('struct Node'), 'the catalogue program is emitted');
});

test('planner: both engines return the same shape', () => {
  for (const brief of ['the sum of the numbers', 'a hash table with string keys']) {
    const result = plan(brief);
    assertEquals(result.ok, true);
    for (const key of SHAPE) assert(key in result, `${brief} has ${key}`);
    assert(result.code.length > 100, `${brief} emits substantive C`);
    assert(result.plan.length > 0 && result.hazards.length > 0, `${brief} explains itself`);
    assert(result.alternatives.length > 0, `${brief} offers an alternative`);
    for (const alternative of result.alternatives) {
      assert(alternative.title && alternative.prompt, `${brief} alternatives are runnable briefs`);
      assert(alternative.engine === 'composer' || alternative.engine === 'catalogue');
    }
  }
});

test('planner: a forced engine is honoured when it has a match', () => {
  const forcedCatalogue = plan('the sum of the numbers', { engine: 'catalogue' });
  assertEquals(forcedCatalogue.engine, 'catalogue');
  assertEquals(forcedCatalogue.tests.length, 0, 'the catalogue plan is forced');
  assert(forcedCatalogue.recipe && forcedCatalogue.recipe.id, 'a catalogue recipe is chosen');

  const forcedComposer = plan('a linked list', { engine: 'composer' });
  assertEquals(forcedComposer.engine, 'catalogue', 'no composed block means an honest fallback');
  assertEquals(forcedComposer.recipe.id, 'linked-list');
});

test('planner: the level option steers a catalogue tie', () => {
  assertEquals(plan('a queue', { level: 'expert' }).recipe.id, 'spsc-ring');
  assertEquals(plan('a queue', { level: 'low' }).recipe.id, 'ring-buffer');
  assertEquals(plan('reverse a string', { level: 'advanced' }).level, 'low',
    'level reports the emitted program, not the request');
});

test('planner: every planner program runs in the M2 interpreter', () => {
  for (const brief of ['the average of numbers from stdin', 'transpose a matrix', 'a linked list', 'a hash table with string keys']) {
    const result = plan(brief);
    const executed = interpret(result.code, {});
    assert(executed.ok, `${brief}: ${executed.error && executed.error.message}`);
    assert(executed.output.length > 0, `${brief} prints a trace`);
  }
});

test('planner: alternatives keep the other engine reachable', () => {
  const everyday = plan('reverse a string');
  assert(everyday.alternatives.some((item) => item.engine === 'catalogue'), 'the catalogue is offered');
  const mixed = plan('sort a linked list');
  assert(mixed.alternatives.some((item) => item.engine === 'composer'), 'a shared word offers the composer');
  const systems = plan('a hash table with string keys');
  assert(!systems.alternatives.some((item) => item.engine === 'composer'),
    'a pure systems brief is not padded with unrelated everyday steps');
});
