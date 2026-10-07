/**
 * M2 - Sandboxed runtime worker.
 *
 * User code is compiled and executed *only* inside this worker: no DOM, no
 * WebCrypto, no storage, no network. The main thread keeps a wall-clock timer
 * and can terminate() this worker instantly, which is what makes an infinite
 * loop killable in a single frame instead of freezing the page.
 *
 * The worker streams stdout back as it is produced, so long-running programs
 * show output progressively.
 */
import { interpret } from './interpreter.js';

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type !== 'run') return;

  const { source, stdin = '', maxSteps, maxHeapBytes, maxDepth } = data;
  let result;
  try {
    result = interpret(String(source), {
      stdin: String(stdin),
      maxSteps,
      maxHeapBytes,
      maxDepth,
      onOutput: (text) => self.postMessage({ type: 'stdout', text }),
    });
  } catch (err) {
    // A crash here means our own runtime blew up: report it, never swallow it.
    self.postMessage({
      type: 'result',
      result: {
        ok: false,
        output: '',
        error: { stage: 'Internal', message: String((err && err.message) || err), line: 1, col: 1 },
      },
    });
    return;
  }
  self.postMessage({ type: 'result', result });
});

self.postMessage({ type: 'ready' });
