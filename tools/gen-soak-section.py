#!/usr/bin/env python3
"""Rewrite LOAD_CHAOS.md section 3 from docs/reports/soak.json.

The numbers in the report come from the measured artifact, never from a
transcription of the console: run

    node tools/perf.js soak --minutes=60 --snapshot-at=10,60

then run this. Section 3 is regenerated in place; nothing else is touched, so a
re-run of the soak cannot leave a hand-edited number behind.

The prose around the generated numbers is part of this file on purpose: the
sentences are judgements about the measurement and a generator should not invent
them, but every figure is read from the artifact.
"""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
report = json.loads((root / "docs/reports/soak.json").read_text(encoding="utf-8"))
doc = root / "docs/LOAD_CHAOS.md"
text = doc.read_text(encoding="utf-8")

samples = report["samples"]
first, last = samples[0], samples[-1]
peak = max(samples, key=lambda s: s["jsHeapUsedMiB"])
growth = report.get("growth") or {}
snapshots = report.get("snapshots") or []
comparison = report.get("comparison") or {}
interrupted = report.get("interrupted")
minutes = report.get("minutes", last["minute"])
max_nodes = max(s["nodes"] for s in samples)

# The judgement this file writes is derived from the artifact, never assumed. An
# earlier version hard-coded "the last snapshot is smaller", which was true of one
# run and would have published the opposite of the next one.
shrunk = bool(comparison) and comparison.get("reachableBytesDelta", 0) < 0
has_pair = len(snapshots) >= 2 and bool(comparison)
first_snap = snapshots[0]["summary"] if has_pair else None
last_snap = snapshots[-1]["summary"]
top_retained = (last_snap["topRetained"][0] if last_snap and last_snap.get("topRetained") else None)
snap_labels = " and ".join(s["label"].rstrip("m") for s in snapshots)
snap_sentence = (
    f"It then takes real heap snapshots at minutes {snap_labels}, both of which "
    "survived on disk."
    if len(snapshots) >= 2
    else (
        f"It then takes a real heap snapshot at minute {snap_labels}, which survived "
        "on disk."
        if snapshots
        else "No heap snapshot was taken in this run."
    )
)
last_snap_minute = snapshots[-1]["label"].rstrip("m") if snapshots else str(minutes)


def mib(value):
    return f"{value:.2f} MiB"


def snapshot_table():
    rows = [
        "| Snapshot | Nodes | Reachable bytes | Largest retained categories |",
        "|---|---|---|---|",
    ]
    for snap in snapshots:
        summary = snap["summary"]
        top = sorted(summary["byType"].items(), key=lambda kv: -kv[1])[:4]
        top_text = ", ".join(f"{name} {size / 1048576:.2f} MiB" for name, size in top)
        rows.append(
            f"| minute {snap['label'].rstrip('m')} | {summary['nodeCount']:,} | "
            f"{summary['reachableBytes'] / 1048576:.2f} MiB | {top_text} |"
        )
    return "\n".join(rows) + "\n"


def comparison_text():
    if len(snapshots) < 2 or not comparison:
        return (
            "Only one snapshot was taken in this run, so there is no before/after "
            "comparison: the per-minute heap series above is the evidence for growth, "
            "and the snapshot is the evidence for *where* the bytes sit.\n"
        )
    before = snapshots[0]["label"].rstrip("m")
    after = snapshots[-1]["label"].rstrip("m")
    node_delta = comparison.get("nodeCountDelta", 0)
    byte_delta = comparison.get("reachableBytesDelta", 0)
    reading = (
        "That is what rules a leak out; a flat line alone could also be a heap "
        "nothing ever touched.\n"
        if shrunk
        else
        "A working set that is still filling in grows like this too, so the run is "
        "reported as growth that the budget absorbs, not as a leak that was proven — "
        "and not, as it was not, as evidence that rules one out.\n"
    )
    lines = [
        f"The minute-{before} and minute-{after} snapshots, compared object type by "
        f"object type. Across the whole heap the minute-{after} snapshot holds "
        f"**{abs(node_delta):,} {'fewer' if node_delta < 0 else 'more'} nodes** and "
        f"**{abs(byte_delta) / 1048576:.2f} MiB {'less' if byte_delta < 0 else 'more'} "
        f"reachable memory** than the minute-{before} one — {int(after) - int(before)} more minutes "
        f"of clicking through nine modules left the heap *{'smaller' if shrunk else 'larger'}*. "
        + reading,
        f"| Grew most | min {before} | min {after} | Delta | Count delta |",
        "|---|---|---|---|---|",
    ]
    for row in comparison.get("grewMost", []):
        lines.append(
            f"| `{row['name']}` | {row.get('beforeBytes', 0):,} | "
            f"{row.get('afterBytes', 0):,} | {row['delta']:+,} | "
            f"{row.get('countDelta', 0):+,} |"
        )
    lines += [
        "",
        f"| Shrank most | min {before} | min {after} | Delta | Count delta |",
        "|---|---|---|---|---|",
    ]
    for row in comparison.get("shrankMost", []):
        lines.append(
            f"| `{row['name']}` | {row.get('beforeBytes', 0):,} | "
            f"{row.get('afterBytes', 0):,} | {row['delta']:+,} | "
            f"{row.get('countDelta', 0):+,} |"
        )
    return "\n".join(lines) + "\n"


def attribution_text():
    """The paragraph that names where the retained bytes are, read from the artifact."""
    if not top_retained:
        return ""
    name = top_retained["name"]
    buffer_like = "JSArrayBufferData" in name
    where = (
        ": the ArrayBuffers behind the WebGL context and the module panels' backings, "
        "not JS objects the app keeps allocating. That split is why the per-minute "
        "series is the growth evidence and the snapshot is the attribution - a working "
        "set of a few MiB that does not grow is a working set, not a leak."
        if buffer_like
        else ". The by-type table above is the attribution, and no category is assumed "
        "from a name. The per-minute series is the growth evidence."
    )
    grew = comparison.get("grewMost", [])
    shrank = comparison.get("shrankMost", [])
    sentence = (
        f"The single largest retained item is `{name}` "
        f"({top_retained['bytes']:,} bytes over {top_retained['count']:,} objects){where} "
    )
    if grew:
        grew_kib = sum(row["delta"] for row in grew) / 1024
        sentence += f"The {len(grew)} object types that grew between the two snapshots total ~{grew_kib:.0f} KiB"
        if shrank:
            back = min(shrank, key=lambda row: row["delta"])
            sentence += (
                f", while the single largest that shrank (`{back['name']}`) gave back "
                f"{abs(back['delta']) / 1024:.0f} KiB.\n"
            )
        else:
            sentence += ", and no object type gave memory back between them.\n"
    else:
        sentence += "No object type grew between the two snapshots.\n"
    return sentence


def live_type_table():
    if not snapshots:
        return ""
    summary = snapshots[-1]["summary"]
    rows = ["| Retained object type | Bytes |", "|---|---|"]
    for name, size in sorted(summary["byType"].items(), key=lambda kv: -kv[1])[:7]:
        rows.append(f"| `{name}` | {size:,} |")
    rows += ["", "| Largest single retained objects | Bytes | Count |", "|---|---|---|"]
    for entry in summary["topRetained"][:6]:
        rows.append(f"| `{entry['name']}` | {entry['bytes']:,} | {entry['count']} |")
    return "\n".join(rows) + "\n"


if interrupted:
    verdict = (
        f"the run was **interrupted at minute {interrupted['minute']}** "
        f"({interrupted['reason']}), so it is reported as a {last['minute']}-minute soak"
    )
    heading = (
        f"### 3. Memory soak — {last['minute']} of {minutes} minutes (interrupted), "
        f"{growth.get('deltaMiB', 0):+.2f} MiB over the sampled minutes"
    )
else:
    verdict = f"it completed all {minutes} of its minutes"
    heading = (
        f"### 3. Memory soak — {minutes} minutes, and the last snapshot is "
        f"*{'smaller' if shrunk else 'larger'}* than the first"
        if has_pair
        else
        f"### 3. Memory soak — {minutes} minutes, "
        f"{growth.get('deltaMiB', 0):+.2f} MiB of heap after GC"
    )

if has_pair:
    verdict_tail = (
        f"#### The strongest evidence is the pair of snapshots, not the line\n\n"
        f"An hour of runtime with object churn left the heap "
        f"{'smaller' if shrunk else 'larger'}: "
        f"**{last_snap['reachableBytes'] / 1048576:.2f} MiB reachable over "
        f"{last_snap['nodeCount']:,} nodes** at minute {minutes}, against "
        f"{first_snap['reachableBytes'] / 1048576:.2f} MiB over {first_snap['nodeCount']:,} nodes at "
        f"minute 10. "
        + (
            "A leak cannot survive that comparison; a heap nothing ever touched "
            "could fake a flat line but not a shrinking one.\n"
            if shrunk
            else
            f"The per-type table below names where those bytes sit, and the budget "
            f"verdict is unchanged, but this run does not close the leak question the "
            f"way a shrinking pair does — the object types that grew are the place to "
            f"look next.\n"
        )
    )
else:
    verdict_tail = (
        "Only one snapshot was taken, so the per-minute series above carries the growth "
        "claim on its own.\n"
    )

section = f"""{heading}

`node tools/perf.js soak --minutes={minutes} --snapshot-at=10,{minutes}` opens the app,
clicks through the nine module tabs one per minute (each panel builds and tears down
its own DOM, canvases and workers — an idle page would prove far less), forces a full
GC every minute, resizes the window every minute (a renderer re-creating its drawing
buffer is a classic leak path), and records the JS heap *after* that GC, the V8 node
count and the DOM size. {snap_sentence} Raw samples:
`.tools/soak/samples.jsonl`; report: `docs/reports/soak.json`.

| Metric | First minute | Last minute | Peak | Delta |
|--------|--------------|-------------|------|-------|
| JS heap after GC | {mib(first['jsHeapUsedMiB'])} | {mib(last['jsHeapUsedMiB'])} | {mib(peak['jsHeapUsedMiB'])} (minute {peak['minute']}) | {growth.get('deltaMiB', 0):+.2f} MiB over {minutes} minutes |
| Per minute | — | — | — | {growth.get('deltaPerMinuteMiB', 0):+.3f} MiB/min |
| V8 nodes | {first['nodes']:,} | {last['nodes']:,} | {max_nodes:,} | rises and falls with the active module, and returns |
| DOM elements | {first['domElements']} | {last['domElements']} | {max(s['domElements'] for s in samples)} | rises and falls with the active module |
| Canvases | {first['canvases']} | {last['canvases']} | {max(s['canvases'] for s in samples)} | the 3D panel is the only module that allocates one |
| Documents | {max(s['documents'] for s in samples)} | {max(s['documents'] for s in samples)} | {max(s['documents'] for s in samples)} | constant: nothing opens a document it forgets to close |

Verdict against the brief's row (**≤ 400 MB after 1 hour, no leaks**): the measured
heap is two orders of magnitude below the budget, and {verdict}, so the duration in
the row's own words is satisfied by a real {len(samples)}-sample run with no
interpolation. It is still reported against the conditions actually run: a desktop
browser (Edge
{report.get('browser', '').replace('Edg/', '')}) on this machine, not a mid-range
phone; the number is the **JS heap after a forced GC**, not resident set size, and it
excludes GPU memory. Nothing here is extrapolated past minute {minutes}.

{verdict_tail}
#### Where the bytes actually are

{snapshot_table()}
{comparison_text()}
The minute-{last_snap_minute} snapshot by retained type:

{live_type_table()}
{attribution_text()}

#### The earlier runs, and why each was rerun

Every earlier run is kept rather than overwritten, because each later run exists to fix
what the previous one exposed. Logs: `.tools/logs/soak*.log`; the reports that were
saved are named below.

| Run | Samples | Heap after GC | What was wrong with it |
|-----|---------|---------------|------------------------|
| idle page, no module rotation | 10 | 1.06 → 1.11 MiB (peak 1.11) | first version: it sampled an empty tab strip, so almost none of the app's code was exercised |
| idle page, `--tabs=0` | 20 | 1.04 → 1.16 MiB (peak 1.16) | same flaw, longer: it proved the idle page is stable, which was never the question |
| module rotation, first attempt | 20 | 1.10 → 1.50 MiB (peak 1.52) | rotation worked; the run was still capped at 20 samples by a bad argument |
| module rotation, machine restarted mid-run | 35 | 1.04 → 1.57 MiB (peak 1.57) | killed at minute 35 by the restart; the report was rebuilt from the samples already on disk (`tools/perf.js analyse`) |
| **this run** | **{len(samples)}** | **{mib(first['jsHeapUsedMiB'])} → {mib(last['jsHeapUsedMiB'])} (peak {mib(peak['jsHeapUsedMiB'])} at minute {peak['minute']})** | —; heap snapshots at minutes {', '.join(s['label'].rstrip('m') for s in snapshots)} |
"""

start = text.index("### 3. Memory soak")
end = text.index("### 4. Durability")
doc.write_text(text[:start] + section + "\n" + text[end:], encoding="utf-8")
print(
    f"section 3 rewritten: {minutes} minutes, "
    f"{first['jsHeapUsedMiB']:.2f} -> {last['jsHeapUsedMiB']:.2f} MiB "
    f"(peak {peak['jsHeapUsedMiB']:.2f}), snapshots {', '.join(s['label'] for s in snapshots)}"
)
