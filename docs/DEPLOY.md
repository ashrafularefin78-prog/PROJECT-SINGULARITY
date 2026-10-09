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

Last run: **152 passed, 0 failed, 0 skipped** against the worker-served build
(`[dom=true webgl2=true indexeddb=true]`), with the strict CSP arriving from the
generated worker rather than from a dev server. A build that cannot deliver its
own security policy, or whose suite fails once served by the deploy artifact,
fails in CI before it can be uploaded.

## What still cannot be delivered by a static host

- `Permissions-Policy` beyond the directives in `_headers` needs host support
  (both hosts deliver the file's copy, so the file's list is what you get).
- Subresource Integrity is deliberately not used: the app has no build step and
  no content hashes, and a stale hash bricks the page (see M8 notes in the
  README). Per-file SRI would require a build step this project does not have.
- HSTS is a host-level header; it belongs to Cloudflare/Netlify configuration,
  not to `_headers` (both hosts ignore HSTS in `_headers`).
