import { compileAndRun } from './clang.js';

self.onmessage = async event => {
  const data = event.data;
  if (data?.type !== 'run') return;
  self.onmessage = null;
  const result = await compileAndRun(data.source, {
    stdin: data.stdin,
    language: data.language,
    standard: data.standard,
    files: data.files,
    maxHeapBytes: data.maxHeapBytes,
    onStatus: status => self.postMessage({ type: 'status', ...status }),
    onOutput: text => self.postMessage({ type: 'stdout', text }),
  });
  self.postMessage({ type: 'result', result });
};
