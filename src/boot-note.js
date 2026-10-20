/**
 * Boot note — the bootstrap, and the file:// fallback.
 *
 * Two jobs, in order of importance:
 *
 * 1. Starting the application module after the first paint. A
 *    `<script type="module">` in the document - even though it is deferred -
 *    is fetched, parsed and executed before the browser's first paint, so the
 *    hero waited for the whole 126 KiB graph. Lighthouse put 86% of the largest
 *    contentful paint (2,878 ms of 3,330 ms) in that render delay. Handing the
 *    module over after a frame has painted moves every byte of JavaScript off
 *    the critical path: the document alone can paint, and it already carries
 *    the hero and the critical CSS.
 *
 * 2. Explaining an empty shell when the page is opened from disk (see below).
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

  // Read synchronously: `document.currentScript` is only set while the script is
  // executing, and the module is started from a later task, where it is null.
  var self = document.currentScript;

  if (location.protocol !== 'file:') {
    // Start on the far side of the first contentful paint, which the browser
    // reports as a `paint` entry. Counting frames instead is not enough: with a
    // double requestAnimationFrame the module graph (126 KiB) was still fetched,
    // parsed and evaluated inside the frame that would have painted the hero,
    // and the browser merged the two - measured first contentful paint 683 ms,
    // of which the render delay was 86%. Waiting for the paint entry means the
    // hero is already on screen before a byte of JavaScript is fetched, by
    // construction rather than by timing luck. The timers below are only a
    // floor, so a browser that never reports a paint still boots.
    var start = function () {
      // Dynamic import rather than a <script> element. The app ships with
      // `require-trusted-types-for 'script'`, and HTMLScriptElement.src is one
      // of the sinks that policy governs - assigning a plain string to it was
      // rejected by the browser and the module never started. import() is not a
      // DOM sink, so it needs neither a TrustedScriptURL nor a second policy,
      // and it is allowed by `script-src 'self'` as same-origin code.
      // The specifier has to be a URL, not a bare path: `import('src/app.js')`
      // is resolved as a package name and rejected with "Failed to resolve
      // module specifier". It is built from this script's own URL so a
      // deployment under a subpath (/PROJECT-SINGULARITY/) resolves correctly.
      var here = (self && self.src) || location.href;
      import(new URL('app.js', here).href).catch(function (err) {
        // A failed boot says so in the footer instead of leaving an empty shell
        // that looks like a hang.
        var footer = document.getElementById('footer-build');
        if (footer) footer.textContent = 'boot failed · ' + (err && err.message ? err.message : err);
      });
    };
    var started = false;
    var boot = function () {
      if (started) return;
      started = true;
      start();
    };
    try {
      var observer = new PerformanceObserver(function (list, obs) {
        var entries = list.getEntries();
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].name === 'first-contentful-paint') {
            obs.disconnect();
            boot();
            return;
          }
        }
      });
      // buffered:true also catches a paint that happened before this script ran.
      observer.observe({ type: 'paint', buffered: true });
    } catch (err) {
      /* paint entries are not supported: the timers below still boot the app */
    }
    // The timer is a fallback for browsers without paint entries, not a race
    // against the first paint. At 1200 ms a cold, 4x-throttled phone had not
    // painted yet (style recalc alone landed near that mark), so the fallback
    // started the 108 KiB module graph *before* the frame that FCP reports and
    // pushed the measured paint to 1.54 s. A browser that truly has no paint
    // entries pays a longer blank shell, but every engine shipped since 2019
    // reports them; a late fallback cannot hurt the painted path.
    setTimeout(boot, 2500);
    return;
  }

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
