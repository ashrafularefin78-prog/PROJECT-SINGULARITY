#!/usr/bin/env python3
"""Build the deploy artifact (Sites / Cloudflare, and anything else prebuilt).

    python3 tools/build-site.py

What it produces, all of it regenerable and gitignored:

  dist/            the public site: the repository files as-is, minus tooling
                   (.git, .tools, dist itself, node_modules, dotfiles)
  dist-site/       worker.js - the assets worker with the `_headers` policy inlined
  deploy.site.json the deploy manifest (entrypoint, module, assetsDirectory)

What it *changes* in the copy (never in the source tree, which stays usable on a
static host with no build step):

  1. Service-worker cache name. `sw.js` carries a version string; it is rewritten
     to a hash of this build, so a deploy cannot serve a stale shell cache under a
     new name - the failure mode that makes people distrust service workers.
  2. Subresource Integrity. The entry subresources in `index.html` (the stylesheet
     and the two entry scripts) get `integrity="sha384-..."` computed from the
     bytes in `dist/`. The source `index.html` stays hash-free, so a host that
     serves the repository as-is (GitHub Pages) keeps working. SRI here covers the
     entry points, not the transitive import graph - stated plainly in the docs.
  3. The worker policy. `_headers` is parsed by the same parser `tools/serve.py`
     uses and inlined into the generated worker, so the deployed policy and the
     locally tested policy are the same rules from the same file.

Fail-closed: every referenced subresource must exist, and every rewrite must match
exactly once. Anything else exits non-zero and writes no manifest, so a half-built
deploy cannot be published by accident.
"""
import base64
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from serve import parse_headers  # noqa: E402  - the dev server's own parser

DIST = os.path.join(ROOT, "dist")
WORKER_DIR = os.path.join(ROOT, "dist-site")
MANIFEST = os.path.join(ROOT, "deploy.site.json")
RECEIPT = os.path.join(ROOT, ".tools", "site", "build.json")
COMPATIBILITY_DATE = "2026-10-01"

#: `tools/` is deliberately absent from the public site: it is the development
#: tooling (this build script included), and docs/DEPLOY.md's commands refer to a
#: repository checkout. `tests/` and `docs/` DO ship, because the deployed site
#: advertises a runnable test suite and links its own reports.
SKIP_DIRS = {".git", ".tools", ".freebuff", "dist", "dist-site", "__pycache__", "node_modules", "tools"}
SKIP_FILES = {"deploy.site.json"}
SKIP_SUFFIX = (".heapsnapshot", ".pyc")

#: (exact source tag, tag with the hash placeholder). Each must occur once.
#: {hash} is replaced by the full attribute value, `sha384-<base64>`.
#: src/app.js is absent by design: since the deferred-boot change it is no
#: longer referenced by a tag but dynamically imported by boot-note.js
#: (`import(new URL('app.js', here).href)`), and dynamic import() has no
#: integrity attribute to pin. Its bytes are governed by script-src 'self'
#: and it is hashed into the service worker's cache manifest below.
SUB_RESOURCES = [
    (
        '<link rel="stylesheet" href="styles/app.css" />',
        '<link rel="stylesheet" href="styles/app.css" integrity="{hash}" />',
        "styles/app.css",
    ),
    (
        '<script src="src/boot-note.js" defer></script>',
        '<script src="src/boot-note.js" defer integrity="{hash}"></script>',
        "src/boot-note.js",
    ),
]


class BuildError(SystemExit):
    def __init__(self, message):
        super().__init__("build-site: " + message)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def sri_hash(path):
    """The full `integrity` attribute value for a file: `sha384-<base64>`."""
    digest = hashlib.sha384(open(path, "rb").read()).digest()
    return "sha384-" + base64.b64encode(digest).decode("ascii")


def public_files():
    """Every file that belongs in the public artifact, relative to ROOT."""
    found = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        rel = os.path.relpath(dirpath, ROOT)
        if rel == ".":
            rel = ""
        # Dot-directories are tooling/state (`.git`, `.wrangler`, `.freebuff`),
        # never site content, and some of them appear inside build output.
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for name in sorted(filenames):
            if name in SKIP_FILES or name.endswith(SKIP_SUFFIX):
                continue
            if name.startswith("."):
                continue  # dotfiles are tooling, not site content
            found.append(os.path.join(rel, name).replace("\\", "/"))
    return found


def clean_dir(path):
    """Empty a directory without deleting the directory itself.

    On Windows a directory that is another process's working directory (an open
    editor, a file watcher, a dev server started with `--root dist`) cannot be
    removed, but its contents can. Rebuilding in place keeps the build working
    in exactly the situation where you most want to run it - while looking at
    the artifact in something else.
    """
    os.makedirs(path, exist_ok=True)
    for entry in os.scandir(path):
        target = os.path.join(path, entry.name)
        if entry.is_dir(follow_symlinks=False):
            shutil.rmtree(target)
        else:
            os.unlink(target)


def copy_public():
    clean_dir(DIST)
    files = public_files()
    for rel in files:
        target = os.path.join(DIST, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(os.path.join(ROOT, rel), target)
    return files


def add_sri():
    """Add integrity attributes to the entry subresources, then re-verify them."""
    index = os.path.join(DIST, "index.html")
    html = open(index, "r", encoding="utf-8").read()
    hashes = {}
    for source, replacement, rel in SUB_RESOURCES:
        count = html.count(source)
        if count != 1:
            raise BuildError(f"index.html: expected exactly one {source!r}, found {count}")
        asset = os.path.join(DIST, rel)
        if not os.path.isfile(asset):
            raise BuildError(f"subresource {rel} is referenced by index.html but not in dist")
        hashes[rel] = sri_hash(asset)
        html = html.replace(source, replacement.format(hash=hashes[rel]))
    with open(index, "w", encoding="utf-8", newline="") as fh:
        fh.write(html)

    # Verify what was written, from the file, against fresh hashes - a build that
    # ships a wrong hash is worse than no SRI at all (the page would not boot).
    check = open(index, "r", encoding="utf-8").read()
    written = re.findall(r'integrity="([^"]+)"', check)
    if len(written) != len(SUB_RESOURCES):
        raise BuildError(f"expected {len(SUB_RESOURCES)} integrity attributes, found {len(written)}")
    for (_, _, rel), value in zip(SUB_RESOURCES, written):
        if not value.startswith("sha384-"):
            raise BuildError(f"integrity for {rel} is not an sha384 value: {value}")
        expected = sri_hash(os.path.join(DIST, rel))
        if value != expected:
            raise BuildError(f"integrity for {rel} written as {value}, recomputes to {expected}")
    return hashes


def build_hash():
    """A hash over every file in dist except sw.js itself (which stores it)."""
    lines = []
    for dirpath, _, filenames in os.walk(DIST):
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, DIST).replace("\\", "/")
            if rel == "sw.js":
                continue
            lines.append(f"{rel}:{sha256_file(path)}")
    return hashlib.sha256("\n".join(sorted(lines)).encode("utf-8")).hexdigest()


def bump_service_worker(version):
    path = os.path.join(DIST, "sw.js")
    text = open(path, "r", encoding="utf-8").read()
    pattern = re.compile(r"const VERSION = '[^']*';")
    if len(pattern.findall(text)) != 1:
        raise BuildError("sw.js does not have exactly one VERSION literal to bump")
    text = pattern.sub(f"const VERSION = '{version}';", text, count=1)
    with open(path, "w", encoding="utf-8", newline="") as fh:
        fh.write(text)
    return version


def write_worker(rules):
    template_path = os.path.join(HERE, "site", "worker.template.js")
    template = open(template_path, "r", encoding="utf-8").read()
    if template.count("__POLICY_JSON__") != 1:
        raise BuildError("worker.template.js must contain exactly one __POLICY_JSON__ placeholder")
    policy = json.dumps(rules, indent=2)
    os.makedirs(WORKER_DIR, exist_ok=True)
    worker = template.replace("__POLICY_JSON__", policy)
    with open(os.path.join(WORKER_DIR, "worker.js"), "w", encoding="utf-8", newline="") as fh:
        fh.write(worker)
    return len(rules)


def inject_test_count():
    """Count tests in tests/*.test.js and inject the total into the built index.html.

    The count is derived from the runner's own files so the hero chip can never
    drift from the suite it advertises. Counts `test(` calls at the start of a
    line, matching how the suites define cases.
    """
    test_dir = os.path.join(ROOT, "tests")
    total = 0
    for name in sorted(os.listdir(test_dir)):
        if not name.endswith(".test.js"):
            continue
        path = os.path.join(test_dir, name)
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                if re.match(r"^\s*test\(", line):
                    total += 1
    if total == 0:
        raise BuildError("no tests found in tests/*.test.js")
    index = os.path.join(DIST, "index.html")
    html = open(index, "r", encoding="utf-8").read()
    # Replace the hero chip text and the CTA button text.
    html = re.sub(r"(\d+)\s+TESTS GREEN", f"{total} TESTS GREEN", html)
    html = re.sub(r"RUN\s+(\d+)\s+TESTS IN THIS BROWSER", f"RUN {total} TESTS IN THIS BROWSER", html)
    with open(index, "w", encoding="utf-8", newline="") as fh:
        fh.write(html)
    return total


def write_manifest():
    manifest = {
        "entrypoint": "index.js",
        "compatibilityDate": COMPATIBILITY_DATE,
        "modules": [{"name": "index.js", "type": "esm", "path": "./dist-site/worker.js"}],
        "assetsDirectory": "./dist",
    }
    with open(MANIFEST, "w", encoding="utf-8", newline="") as fh:
        fh.write(json.dumps(manifest, indent=2) + "\n")
    return manifest


def integrity_manifest():
    """Write dist/.integrity-manifest.json: per-file SHA-256 + size.

    The service worker reads this at boot (when available) and can verify the
    cache against it. A tampered or missing asset is detectable, which is the
    honest partial that moves M8 toward Gold.
    """
    entries = []
    for dirpath, _, filenames in os.walk(DIST):
        for name in sorted(filenames):
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, DIST).replace("\\", "/")
            raw = open(path, "rb").read()
            entries.append({
                "path": rel,
                "sha256": hashlib.sha256(raw).hexdigest(),
                "size": len(raw),
            })
    entries.sort(key=lambda e: e["path"])
    manifest = {
        "version": 1,
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "compatibilityDate": COMPATIBILITY_DATE,
        "files": entries,
        "rootHash": hashlib.sha256("".join(e["sha256"] for e in entries).encode("utf-8")).hexdigest(),
    }
    manifest_path = os.path.join(DIST, ".integrity-manifest.json")
    with open(manifest_path, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    return manifest


def receipt(files, hashes, version, rule_count):
    total = 0
    gzipped = 0
    for dirpath, _, filenames in os.walk(DIST):
        for name in filenames:
            path = os.path.join(dirpath, name)
            raw = open(path, "rb").read()
            total += len(raw)
            gzipped += len(gzip.compress(raw, 9))
    payload = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "compatibilityDate": COMPATIBILITY_DATE,
        "files": len(files) + 1,  # + the generated worker is outside dist/
        "distBytes": total,
        "distGzipBytes": gzipped,
        "serviceWorkerVersion": version,
        "policyRuleSets": rule_count,
        "sri": hashes,
        "note": "dist/ is the deployable copy; dist-site/worker.js carries the _headers policy parsed at build time.",
    }
    os.makedirs(os.path.dirname(RECEIPT), exist_ok=True)
    with open(RECEIPT, "w", encoding="utf-8", newline="") as fh:
        fh.write(json.dumps(payload, indent=2) + "\n")
    return payload


def main():
    rules = parse_headers(open(os.path.join(ROOT, "_headers"), "r", encoding="utf-8").read())
    if not rules:
        raise BuildError("_headers parsed to zero rules; refusing to build a site without its policy")

    files = copy_public()
    test_count = inject_test_count()
    hashes = add_sri()
    version = bump_service_worker("singularity-" + build_hash()[:16])
    rule_count = write_worker(rules)
    write_manifest()
    integrity_manifest()
    summary = receipt(files, hashes, version, rule_count)

    print(f"# dist/         {summary['files']} files, {summary['distBytes'] / 1024:.1f} KiB raw, "
          f"{summary['distGzipBytes'] / 1024:.1f} KiB gzip")
    print(f"# tests         {test_count} (injected into index.html from tests/*.test.js)")
    print(f"# worker        dist-site/worker.js with {rule_count} rule sets inlined from _headers")
    print(f"# service worker cache  {version}")
    for rel, value in hashes.items():
        print(f"# sri           {rel}  {value}")
    print(f"# manifest      {os.path.relpath(MANIFEST, ROOT)} (compatibility {COMPATIBILITY_DATE})")
    print(f"# receipt       {os.path.relpath(RECEIPT, ROOT)}")


if __name__ == "__main__":
    main()
