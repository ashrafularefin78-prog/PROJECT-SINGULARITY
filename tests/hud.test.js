import { test, assert } from './harness.js';

function smokeM8() {
  return import('../src/crypto/e2ee.js').then(function(m) {
    assert(typeof m.dhVariantInfo === 'function', 'crypto module is importable');
  });
}

test('M8: crypto worker can be imported in Node without DOM', smokeM8, { needs: 'none' });
