/**
 * M2 - Main-thread side of the sandbox.
 *
 * Owns one worker per run, enforces a wall-clock limit, and terminates the
 * worker when it expires. Termination is instant and total: no cooperation from
 * the running program is required.
 */
import { scriptUrl } from '../security/policy.js';

const WORKER_URL = new URL('./worker.js', import.meta.url).href;

export class Sandbox {
  constructor(options = {}) {
    this.url = options.url || WORKER_URL;
    this.timeLimitMs = options.timeLimitMs ?? 3000;
    this.maxSteps = options.maxSteps ?? 5_000_000;
    this.maxHeapBytes = options.maxHeapBytes ?? 32 * 1024 * 1024;
    this.maxDepth = options.maxDepth ?? 200;
  }

  /**
   * Compile + run `source`. Resolves with the interpreter's structured result,
   * plus `killed` when the wall-clock limit fired.
   */
  run(source, options = {}) {
    return this.start(source, options).promise;
  }

  /** Same as run(), but hands back a kill() handle for an instant manual stop. */
  start(source, options = {}) {
    let killFn = () => {};
    const promise = new Promise((resolve) => {
      killFn = () => {
        if (this._active) this._active();
      };
      let worker;
      try {
        worker = new Worker(scriptUrl(this.url), { type: 'module', name: 'singularity-runtime' });
      } catch (err) {
        resolve({
          ok: false,
          output: '',
          killed: false,
          error: { stage: 'Sandbox', message: `worker refused to start: ${err.message}`, line: 1, col: 1 },
        });
        return;
      }

      const chunks = [];
      let settled = false;
      const limit = options.timeLimitMs ?? this.timeLimitMs;
      const started = performance.now();

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this._active = null;
        worker.terminate();
        resolve(result);
      };

      // A manual kill from the UI: same path as the wall-clock limit.
      this._active = () => finish({
        ok: false,
        output: chunks.join(''),
        killed: true,
        ms: Math.round(performance.now() - started),
        error: { stage: 'Sandbox', message: 'terminated by the user', line: 1, col: 1 },
      });

      const timer = setTimeout(() => finish({
        ok: false,
        output: chunks.join(''),
        killed: true,
        ms: Math.round(performance.now() - started),
        error: {
          stage: 'Sandbox',
          message: `killed after ${limit} ms wall-clock limit (infinite loop?)`,
          line: 1,
          col: 1,
        },
      }), limit);

      worker.addEventListener('message', (event) => {
        const data = event.data || {};
        if (data.type === 'stdout') {
          chunks.push(data.text);
          if (options.onOutput) options.onOutput(data.text);
          return;
        }
        if (data.type === 'result') {
          finish({
            ...data.result,
            output: data.result.output || chunks.join(''),
            killed: false,
            ms: Math.round(performance.now() - started),
          });
        }
      });

      worker.addEventListener('error', (event) => {
        finish({
          ok: false,
          output: chunks.join(''),
          killed: false,
          error: {
            stage: 'Sandbox',
            message: event.message || 'worker error',
            line: event.lineno || 1,
            col: event.colno || 1,
          },
        });
      });

      worker.postMessage({
        type: 'run',
        source,
        stdin: options.stdin ?? '',
        maxSteps: options.maxSteps ?? this.maxSteps,
        maxHeapBytes: options.maxHeapBytes ?? this.maxHeapBytes,
        maxDepth: options.maxDepth ?? this.maxDepth,
      });
    });
    return { promise, kill: () => killFn() };
  }
}
