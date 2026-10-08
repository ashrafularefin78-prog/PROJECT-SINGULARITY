#!/usr/bin/env python3
"""Dependency-free static server for Project Singularity (Python stdlib only).

Node is not required anywhere in this project. This server mirrors the
production security policy (M8) so the app is always tested under the exact
headers it ships with: strict CSP, Trusted Types enforcement, COOP/COEP.
"""
import argparse
import http.server
import os
import posixpath
import socketserver
import sys
import urllib.parse

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "worker-src 'self'",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "require-trusted-types-for 'script'",
])

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

#: URL prefix the app is served under. Empty for http://host/, or set to e.g.
#: '/PROJECT-SINGULARITY' to reproduce a GitHub Pages project-site deployment
#: exactly. That subpath is where absolute paths such as '/sw.js' break, so it
#: is worth being able to test locally instead of discovering it live.
PREFIX = os.environ.get("SINGULARITY_PREFIX", "")


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
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))


class ReuseServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main():
    global PREFIX
    ap = argparse.ArgumentParser(description="Project Singularity static server")
    ap.add_argument("port", nargs="?", type=int, default=int(os.environ.get("PORT", 5173)))
    ap.add_argument(
        "--prefix",
        default=PREFIX,
        help="serve the app under a URL prefix, e.g. /PROJECT-SINGULARITY "
        "(simulates a GitHub Pages project site so subpath bugs are visible locally)",
    )
    args = ap.parse_args()
    PREFIX = (args.prefix or "").rstrip("/")
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
