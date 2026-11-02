/* M2 playground driver.
   An external file rather than an inline <script>, for the same reason the CSS
   is external: this page ships `script-src 'self'` with neither 'unsafe-inline'
   nor a hash, so an inline module was refused before it ever ran - the page
   loaded, looked inert and said nothing. Same policy, same file layout as the
   app's own modules. */
import { Sandbox } from '../src/runtime/sandbox.js';

const sandbox = new Sandbox({ timeLimitMs: 3000 });
const source = document.getElementById('source');
const output = document.getElementById('output');
const runBtn = document.getElementById('run');
const stopBtn = document.getElementById('stop');

const sample = `#include <stdio.h>\nint main(void) {\n  int n;\n  printf("enter n: ");\n  scanf("%d", &n);\n  printf("n*n = %d\\n", n*n);\n  return 0;\n}\n`;
source.value = sample;
output.textContent = 'Idle - press Run.';

let active = null;

runBtn.addEventListener('click', () => {
  output.textContent = 'running…';
  const handle = sandbox.start(source.value, { stdin: '7\n' });
  active = handle;
  handle.promise.then((r) => {
    active = null;
    output.textContent =
      (r.output || '') +
      (r.error ? `\n[${r.error.stage}] ${r.error.message}` : '') +
      (r.killed ? '\n(killed)' : '');
  });
});

stopBtn.addEventListener('click', () => {
  if (active && active.kill) active.kill();
});
