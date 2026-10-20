import { test } from './harness.js';

const fn = async () => { return 42; };
console.log('fn type:', typeof fn);
test('test', fn, { needs: 'none' });
console.log('registered ok');
