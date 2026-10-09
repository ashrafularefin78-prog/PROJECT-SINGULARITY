#!/usr/bin/env python3
"""Dependency-free static server for Project Singularity (Python stdlib only).

Node is not required anywhere in this project. This server mirrors the
production security policy (M8) so the app is always tested under the exact
headers it ships with: strict CSP, Trusted Types enforcement, COOP/COEP.

The policy is *read from `_headers`*, the same file Cloudflare Pages, Netlify
and the deployed worker honor. Keeping the policy in one file means the local
server, the tests and the live site cannot drift apart: a header added for
production is exercised locally first, and a header that is broken locally
cannot be "fixed by the host" later.

`tools/headers.js` implements the same parser and matcher for the Node server;
the two are deliberately kept line-for-line equivalent, and
`node tools/verify-headers.js` checks the result against `_headers` itself.
"""
import argparse
import http.server
import os
import posixpath
import re
import socketserver
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: URL prefix the app is served under. Empty for http://host/, or set to e.g.
#: '/PROJECT-SINGULARITY' to reproduce a GitHub Pages project-site deployment
#: exactly. That subpath is where absolute paths such as '/sw.js' break, so it
#: is worth being able to test locally instead of discovering it live.
PREFIX = os.environ.get("SINGULARITY_PREFIX", "")


# ---------------------------------------------------------------- _headers

def parse_headers(text):
    """Parse a `_headers` file into [{pattern, headers: [(name, value)]}]."""
    rules = []
    current = None
    for raw in text.split("\n"):
        line = raw.rstrip()
        if not line.strip() or line.strip().startswith("#"):
            continue
        if not line[0].isspace():
            current = {"pattern": line.strip(), "headers": []}
            rules.append(current)
            continue
        m = re.match(r"^\s*([A-Za-z0-9-]+):\s*(.*)$", line)
        if m and current is not None:
            current["headers"].append((m.group(1), m.group(2)))
    return rules


def pattern_matches(pattern, pathname):
    """Does one `_headers` pattern match this request path?

    A `*` matches within one path segment, as Cloudflare Pages and Netlify
    define it (so `/*.css` matches `/styles/app.css`, never `/a/b.css`).
    """
    if pattern in ("/*", "*"):
        return True
    parts = [re.escape(part) for part in pattern.split("*")]
    return re.match("^" + "[^/]*".join(parts) + "$", pathname) is not None


def headers_for(rules, pathname):
    """The headers to send for `pathname`; the latest matching rule wins per
    header name, which is Netlify's documented behaviour and the intuitive
    reading of a file you scan downwards."""
    out = {}
    for rule in rules:
        if not pattern_matches(rule["pattern"], pathname):
            continue
        for name, value in rule["headers"]:
            out[name.lower()] = (name, value)
    return list(out.values())


def load_header_rules(path=None):
    try:
        with open(path or os.path.join(ROOT, "_headers"), "r", encoding="utf-8") as fh:
            return parse_headers(fh.read())
    except OSError:
        return []


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def translate_path(self, path):
        """Serve the project root under PREFIX, and redirect the bare prefix."""
        if not PREFIX:
            return super().translate_path(path)
        parsed = urllib.parse.urlsplit(path)
        raw = urllib.parse.unquote(parsed.path)
        if raw == PREFIX:
            raw = PREFIX + "/"
        if not raw.startswith(PREFIX + "/"):
            return os.path.join(ROOT, "__missing__")
        rest = raw[len(PREFIX):]
        rest = posixpath.normpath(rest)
        parts = [p for p in rest.split("/") if p and p not in (".", "..")]
        return os.path.join(ROOT, *parts)

    def do_GET(self):
        if PREFIX and urllib.parse.urlsplit(self.path).path == PREFIX:
            self.send_response(301)
            self.send_header("Location", PREFIX + "/")
            self.end_headers()
            return
        super().do_GET()

    def end_headers(self):
        # Match against the path as served (prefix stripped), so one `_headers`
        # file is correct at '/' and at a subpath deployment alike.
        path = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if PREFIX and path.startswith(PREFIX):
            path = path[len(PREFIX):] or "/"
        for name, value in headers_for(HEADER_RULES, path):
            # Development keeps everything fresh on purpose: the host honors the
            # Cache-Control rules in `_headers`, which would otherwise pin an
            # edited file for 300 seconds while you are looking at it.
            if name.lower() == "cache-control":
                continue
            self.send_header(name, value)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


HEADER_RULES = load_header_rules()


def main():
    global PREFIX, ROOT, HEADER_RULES
    ap = argparse.ArgumentParser(description="Project Singularity static server")
    ap.add_argument("port", nargs="?", type=int, default=int(os.environ.get("PORT", 5173)))
    ap.add_argument(
        "--root",
        default=ROOT,
        help="serve a different directory - e.g. --root dist to serve exactly what "
        "tools/build-site.py produced, under the same _headers policy",
    )
    ap.add_argument(
        "--prefix",
        default=PREFIX,
        help="serve the app under a URL prefix, e.g. /PROJECT-SINGULARITY "
        "(simulates a GitHub Pages project site so subpath bugs are visible locally)",
    )
    args = ap.parse_args()
    ROOT = os.path.abspath(args.root)
    HEADER_RULES = load_header_rules()
    PREFIX = (args.prefix or "").rstrip("/")
    if not HEADER_RULES:
        sys.stderr.write("warning: no _headers rules found; serving without the security policy\n")
    else:
        sys.stderr.write("policy: %d rule sets from _headers\n" % len(HEADER_RULES))
    with ReuseServer(("127.0.0.1", args.port), Handler) as httpd:
        print(
            "Project Singularity dev server: http://127.0.0.1:%d%s/" % (args.port, PREFIX),
            flush=True,
        )
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
