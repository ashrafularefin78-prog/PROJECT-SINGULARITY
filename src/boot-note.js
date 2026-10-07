/**
 * Boot note — the file:// fallback.
 *
 * The app boots from ES modules, and browsers refuse to load modules on
 * file:// pages (the origin is "null", so every module fetch fails CORS).
 * A double-clicked index.html therefore shows a powered-off shell no matter
 * what the app does. This file is a deliberately classic (non-module) script:
 * classic scripts still load from disk, so this is the one piece of code that
 * is guaranteed to run in that situation.
 *
 * Under HTTP it does nothing but compare one string and exit, so the strict
 * CSP the app ships with has nothing to complain about: no eval, no markup
 * sink, textContent only, no inline handlers.
 */
(function () {
  'use strict';
  if (location.protocol !== 'file:') return;

  // The footer would otherwise say "boot…" forever, which reads as a hang.
  var footerBuild = document.getElementById('footer-build');
  if (footerBuild) footerBuild.textContent = 'not booted · page opened from disk (file://)';

  var note = document.createElement('div');
  note.className = 'noscript-note boot-note';
  note.setAttribute('role', 'alert');

  var title = document.createElement('strong');
  title.textContent = 'This page was opened straight from the file system (file://)';

  var body = document.createElement('p');
  body.textContent =
    'Browsers block ES module loading on file:// pages, so the application ' +
    'cannot boot here and the shell stays empty — this is a browser security ' +
    'rule, not a bug in the page. Serve the folder over HTTP instead and it ' +
    'boots normally:';

  var command = document.createElement('p');
  var code = document.createElement('code');
  code.textContent = 'python3 tools/serve.py 5173';
  command.appendChild(code);

  var after = document.createElement('p');
  after.textContent = 'Then open http://127.0.0.1:5173/ in this browser.';

  note.appendChild(title);
  note.appendChild(body);
  note.appendChild(command);
  note.appendChild(after);

  document.body.prepend(note);

  // Keep the address visible: the whole point is where the page was opened from.
  note.scrollIntoView();
})();
