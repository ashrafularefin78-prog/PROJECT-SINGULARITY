import json
import subprocess
import sys

NODE = "C:\\Users\\user\\Downloads\\New\\PROJECT-SINGULARITY\\.tools\\node-v24.22.0-win-x64\\node.exe"
RUNNER = "C:\\Users\\user\\Downloads\\New\\PROJECT-SINGULARITY\\tests\\run.js"

out = subprocess.run(
    [NODE, RUNNER, "--json"],
    capture_output=True,
    text=True,
    env={"NODE_OPTIONS": "", **subprocess.os.environ},
)

print("RC:", out.returncode)
print("STDOUT:", repr(out.stdout))
print("STDERR:", repr(out.stderr))
try:
    d = json.loads(out.stdout)
    print("TOTAL", d["total"])
    print("PASS", d["pass"])
    print("FAIL", d["fail"])
    print("SKIP", d["skip"])
    print("SUITES", d["suites"])
    print("FILES", d["files"])
except Exception as e:
    print("JSON parse failed:", e)
    sys.exit(1)
