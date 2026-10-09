#!/usr/bin/env python3
"""Install a portable Node runtime into .tools/, without touching the system.

Why this exists: the app itself has no dependencies and the site deploys as
plain files, but the *verification* tooling (the test runner, the headless
browser driver, the measurement tools) is JavaScript. Rather than requiring a
system-wide Node install, this downloads the official Windows/macOS/Linux
archive into .tools/, which is git-ignored, and prints the path to use.

    python3 tools/bootstrap-node.py            # latest LTS
    python3 tools/bootstrap-node.py v22.11.0   # a specific version

Then either export PATH as printed, or call it directly:

    .tools/node-*/node tests/run.js
"""
import io
import json
import os
import platform
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX = "https://nodejs.org/dist/index.json"


def archive_for(version, machine):
    """Return (archive name, extension) for this platform."""
    if sys.platform.startswith("win"):
        return f"node-{version}-win-{machine}", "zip"
    if sys.platform == "darwin":
        return f"node-{version}-darwin-{machine}", "tar.gz"
    return f"node-{version}-linux-{machine}", "tar.gz"


def main():
    requested = sys.argv[1] if len(sys.argv) > 1 else None
    print("fetching the Node release index ...", flush=True)
    index = json.load(urllib.request.urlopen(INDEX, timeout=30))
    if requested:
        entry = next((v for v in index if v["version"] == requested), None)
        if entry is None:
            sys.exit(f"unknown Node version {requested}")
    else:
        entry = next(v for v in index if v.get("lts"))
    version = entry["version"]

    machine = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
    name, ext = archive_for(version, machine)
    url = f"https://nodejs.org/dist/{version}/{name}.{ext}"

    os.makedirs(os.path.join(ROOT, ".tools"), exist_ok=True)
    print(f"downloading {url}", flush=True)
    data = urllib.request.urlopen(url, timeout=300).read()
    print(f"  {len(data) / 1048576:.1f} MiB", flush=True)

    if ext == "zip":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            archive.extractall(os.path.join(ROOT, ".tools"))
    else:
        import tarfile

        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            archive.extractall(os.path.join(ROOT, ".tools"))

    target = os.path.join(ROOT, ".tools", name)
    print(f"\nNode {version} is at:\n  {target}")
    print("\nRun the suite with:\n  " + os.path.join(target, "bin", "node" if sys.platform != "win32" else "node.exe") + " tests/run.js")


if __name__ == "__main__":
    main()
