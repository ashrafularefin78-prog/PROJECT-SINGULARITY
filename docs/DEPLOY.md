# Hosting: which M8 protections actually arrive

## The canonical deployment

<https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/> is the one
published URL, served by GitHub Pages from the repository root on every push to
`main`. There is no second deployment, and no other hostname is part of this
project's story.

GitHub Pages cannot send custom response headers, so `_headers` is inert there:
the browser receives the CSP that `index.html` carries as `<meta http-equiv>`,
and nothing else. Three protections cannot be expressed in a meta tag at all:

| Directive | What it stops | Meta tag? |
|-----------|---------------|-----------|
| `Content-Security-Policy: frame-ancestors 'none'` | clickjacking (this page framed inside someone else's) | **impossible** — the spec ignores `frame-ancestors` in a meta policy |
| `Cross-Origin-Opener-Policy: same-origin` | a cross-origin opener keeping a handle on this window | **impossible** |
| `Cross-Origin-Embedder-Policy: require-corp` | cross-origin resources loading without opting in; also gates `SharedArrayBuffer` | **impossible** |

Cloudflare Pages, Netlify and the generated deploy worker do read `_headers`,
so the same tree activates those three without a code change. Moving this
project there is a host decision, not a fix for something broken: the canonical
deployment is honest about running the meta policy, and the sections below say
exactly how to check both cases.

## What is active where

| Protection | GitHub Pages (canonical) | A host that reads `_headers` |
|------------|--------------------------|------------------------------|
| CSP: `script-src`, Trusted Types, `object-src`, `base-uri`, `form-action` | yes — the meta policy, enforced | yes — as a response header, and the meta tag also applies |
| `frame-ancestors 'none'` | no | yes |
| COOP / COEP (cross-origin isolation) | no | yes |
| `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, CORP | no | yes |
| Subresource Integrity | build path only (`tools/build-site.py`) | build path only |

The M8 panel reads the live response headers of whatever page it is running on,
so it reports this table for the host it is actually served from rather than
asserting it.

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

### Verified locally, header by header

Run against the server that reads `_headers` (not against GitHub Pages):

```
$ node tools/verify-headers.js
# _headers: 2 rule sets (/*, /sw.js)
  ok   /                status 200
  ok   /index.html      status 200
  ok   /sw.js           status 200
  ok   /src/app.js      status 200
  ok   /styles/app.css  status 200
  ok   content-security-policy: default-src 'self'; script-src 'self'; style-src 'self' 'sha256-1BOQes/p9BgrpUIzRlEMVyF/J8AouR1pXUT/Q5w0sjM='; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'
  ok   cross-origin-opener-policy: same-origin
  ok   cross-origin-embedder-policy: require-corp

all headers delivered as _headers specifies
```

This is a claim about the file and the server that reads it. It is not a claim
about GitHub Pages, which sends none of these.

### Checking the canonical deployment

```sh
curl -sI https://ashrafularefin78-prog.github.io/PROJECT-SINGULARITY/ \
  | grep -iE 'content-security-policy|cross-origin|referrer-policy'
```

Today the command prints nothing, which is the honest result: GitHub Pages
sends no CSP, COOP, COEP, CORP or `Referrer-Policy` header. The policy in force
on that URL is the meta CSP in `index.html`. The `Strict-Transport-Security`
header GitHub Pages does send is host-level and outside this repository.

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

## Verifying a header-capable host

```sh
curl -sI https://<site>/ | grep -iE 'content-security-policy|cross-origin|referrer-policy'
node tools/verify-headers.js --url=https://<site>/
```

The first line must show `frame-ancestors 'none'` inside the CSP, plus both
`cross-origin-*` headers. Those three are exactly what GitHub Pages cannot send,
and they are the reason to run this build on a header-capable host when
clickjacking and cross-origin isolation matter.

`tools/verify-headers.js --url=` compares the served CSP against the current
`_headers`, so it also fails on a host still running an older copy of this
tree. That is the intended behaviour: the check is against the file in the
checkout, not against whatever was uploaded last.

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
**245** (227 pass + 18 browser-only skips under bare Node), and all 245 pass in
a real browser against the dev server; the worker-served run above has not been
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
  not to `_headers` (both hosts ignore HSTS in `_headers`, and GitHub Pages
  sends its own).
