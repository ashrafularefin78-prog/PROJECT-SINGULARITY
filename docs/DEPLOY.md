# Hosting: making the M8 protections actually arrive

## The problem

The site was served from GitHub Pages. GitHub Pages cannot send custom response
headers, so the `_headers` file in this repository was inert there: the browser
received the CSP that `index.html` carries as `<meta http-equiv>`, and nothing
else. Three protections cannot be expressed in a meta tag at all, so on GitHub
Pages they simply did not exist:

| Directive | What it stops | Meta tag? |
|-----------|---------------|-----------|
| `Content-Security-Policy: frame-ancestors 'none'` | clickjacking (this page framed inside someone else's) | **impossible** — the spec ignores `frame-ancestors` in a meta policy |
| `Cross-Origin-Opener-Policy: same-origin` | a cross-origin opener keeping a handle on this window | **impossible** |
| `Cross-Origin-Embedder-Policy: require-corp` | cross-origin resources loading without opting in; also gates `SharedArrayBuffer` | **impossible** |

Cloudflare Pages and Netlify both read `_headers` as-is, so the same file that
documents the policy starts delivering it.

## One source of truth

`_headers` is the only place the policy is written down. The local dev servers
read it (`tools/headers.js` for Node, the same parser in `tools/serve.py`), so a
header that is added for production is exercised locally first — and a header
that is *broken* locally cannot be "fixed by the host" later.

Verify it, locally or against a deployment:

```sh
node tools/verify-headers.js                    # starts the dev server and checks every rule
node tools/verify-headers.js --url=https://...  # after deploying, check the live headers
```

## Cloudflare Pages

1. Push this repository to GitHub (already done).
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.
3. Pick the repository, then:
   - **Framework preset**: None
   - **Build command**: *(leave empty)*
   - **Build output directory**: `/`
4. Deploy. `_headers` is applied automatically to every response.

Command line alternative:

```sh
npx wrangler pages deploy . --project-name project-singularity
```

Optional but worth adding at the edge: a Cloudflare Page Rule (or a Transform
Rule) adding `Strict-Transport-Security: max-age=31536000; includeSubDomains`,
which is a host-level header rather than an app-level one.

## Netlify

1. Netlify dashboard → Add new site → Import an existing project.
2. Pick the repository. `netlify.toml` already states the publish directory and
   that there is no build step.
3. Deploy. `_headers` is applied automatically.

## Verifying the move

```sh
curl -sI https://<site>/ | grep -iE 'content-security-policy|cross-origin|referrer-policy'
node tools/verify-headers.js --url=https://<site>/
```

The first line must show `frame-ancestors 'none'` inside the CSP, plus both
`cross-origin-*` headers. Under GitHub Pages those three lines are missing, which
is exactly the gap this move closes.

### Verified against the live deployment

Run against the deployed site on 2026-10-09; the output is reproduced here
because this is the claim the whole move rests on:

```
$ node tools/verify-headers.js --url=https://site-7b30ffebca394f959117a11319fb4dfc.freebuff.page/
# _headers: 2 rule sets (/*, /sw.js)
  ok   /                status 200
  ok   /index.html      status 200
  ok   /sw.js           status 200
  ok   /src/app.js      status 200
  ok   /styles/app.css  status 200
  ok   content-security-policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'
  ok   cross-origin-opener-policy: same-origin
  ok   cross-origin-embedder-policy: require-corp

all headers delivered as _headers specifies
```

Three of those lines — `frame-ancestors 'none'`, COOP and COEP — are the ones
GitHub Pages could not send at all, and they are the reason this site moved.

### Re-verified 2026-10-19

The hosting claim still holds for what the host does: the live response carries
`frame-ancestors 'none'` inside the CSP plus COOP and COEP — the three
directives GitHub Pages could not send at all. The repository has moved on
since the live deployment, though. The current `_headers` expects the hashed
style policy (`style-src 'self' 'sha256-ActgC60ZLhkgZShDeF5iw8kp+TINQ4WoWdpA13Na7+Q='`),
and the deployed build predates it, so today's run of
`node tools/verify-headers.js --url=https://site-7b30ffebca394f959117a11319fb4dfc.freebuff.page/`
fails five per-path comparisons: every security header arrives, but the CSP
served is the prior revision without the hash. The actual output, reproduced so
the claim is checkable rather than asserted:

```
$ node tools/verify-headers.js --url=https://site-7b30ffebca394f959117a11319fb4dfc.freebuff.page/
# _headers: 2 rule sets (/*, /sw.js)
  FAIL /                status 200 | missing: - | Content-Security-Policy: expected "…style-src 'self' 'sha256-ActgC60Z…'…", got "…style-src 'self'; img-src…"
  FAIL /index.html      status 200 | missing: - | (same: served CSP lacks the style hash)
  FAIL /sw.js           status 200 | missing: - | (same)
  FAIL /src/app.js      status 200 | missing: - | (same)
  FAIL /styles/app.css  status 200 | missing: - | (same)
  ok   content-security-policy: … frame-ancestors 'none'; require-trusted-types-for 'script'
  ok   cross-origin-opener-policy: same-origin
  ok   cross-origin-embedder-policy: require-corp

5 header check(s) failed
```

`node tools/verify-headers.js` (no `--url`) passes against the current tree.
Redeploying the current tree — `npx wrangler pages deploy . --project-name
project-singularity`, or a Re-deploy in the Pages dashboard — closes the gap;
this environment has no host credentials to run that command.

### The deploy artifact, not just the host

The upload is built and checked locally first, in the same runtime Cloudflare
runs:

```sh
python3 tools/build-site.py      # dist/ + dist-site/worker.js + SRI + manifest
node tools/verify-headers.js     # the built server must deliver the same policy
node .tools/wrangler/node_modules/wrangler/bin/wrangler.js dev -c tools/site/wrangler.jsonc
# then, against workerd:
node tools/browser-run.js --url=http://127.0.0.1:8788/tests/browser.html
```

Last worker-served run: **152 passed, 0 failed, 0 skipped**
(`[dom=true webgl2=true indexeddb=true]`), with the strict CSP arriving from the
generated worker rather than from a dev server. The suite has since grown to
**200** (190 pass + 10 browser-only skips under bare Node), and all 200 pass in a
real browser against the dev server; the worker-served run above has not been
repeated here since, because `.tools/wrangler` is not installed in this
checkout (CI's deploy job runs the same command against the built artifact
served from `dist/`). A build that cannot deliver its own security policy, or
whose suite fails once served by the deploy artifact, fails in CI before it can
be uploaded.

## What still cannot be delivered by a static host

- `Permissions-Policy` beyond the directives in `_headers` needs host support
  (both hosts deliver the file's copy, so the file's list is what you get).
- Subresource Integrity is only on the built path: `tools/build-site.py` pins the
  two tag-referenced entry resources (`styles/app.css`, `src/boot-note.js`) with
  `sha384-` integrity attributes, verified against freshly recomputed hashes in
  the same run. Deploying the repository as-is, with no build step, serves no
  integrity attributes at all — and `src/app.js` cannot be pinned on either path
  because deferred boot loads it through `import()`, which has no integrity
  attribute; it is governed by `script-src 'self'` and hashed into the service
  worker's cache manifest instead. A stale hash bricks the page, which is why
  the hash-free path ships no hashes.
- HSTS is a host-level header; it belongs to Cloudflare/Netlify configuration,
  not to `_headers` (both hosts ignore HSTS in `_headers`).
