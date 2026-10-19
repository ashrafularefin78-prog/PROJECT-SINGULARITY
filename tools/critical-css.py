#!/usr/bin/env python3
"""Split the stylesheet, inline the part the first viewport needs, hash it.

    python3 tools/critical-css.py            # rewrite index.html, _headers, styles/critical.css
    python3 tools/critical-css.py --check    # verify only; exit 1 on any drift

Why a hash instead of 'unsafe-inline': the app ships `style-src 'self'` with no
'unsafe-inline', and that is a claim worth keeping - an injected style would be
as good as script in this app. CSP3 lets an inline <style> be allowed by the
SHA-256 of its exact text, so the critical block is inlined *without* weakening
the policy, and this script is what keeps the hash and both copies of the policy
(the meta tag for static hosts, `_headers` for hosts that read it) in step.

The split is deliberately explicit rather than clever: an allowlist of selectors
for the shell and the hero, everything else deferred. The lists below are
checked against styles/app.css, so a selector that stops existing is an error
rather than a silent omission of styling the first paint needs.
"""
import gzip
import hashlib
import base64
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_CSS = ROOT / "styles/app.css"
CRITICAL_CSS = ROOT / "styles/critical.css"
INDEX = ROOT / "index.html"
HEADERS = ROOT / "_headers"

CHECK = "--check" in sys.argv

# Rules the first viewport needs. Prefix match on the selector's first token.
CRITICAL_PREFIXES = [
    # tokens and the document itself
    ":root", "html", "body", "*",
    # the decorative background layers: present at first paint, so their absence
    # would be a visible flash of a different background
    ".fx",
    # shell
    # `button` is here because the command button in the topbar is sized by the
    # base `button, .button` rule: with it deferred, the header row grew 14 px
    # at mobile width when the full sheet arrived and pushed the page down
    # (measured CLS 0.219 desktop / 0.092 mobile before this line existed).
    ".skip-link", ".topbar", ".topbar-actions", ".brand", ".cmd-hint", ".theme-toggle", "kbd", "button", ".button", ".chips", ".chip",
    ".telemetry", ".tl", ".spark", ".noscript-note",
    # `.wave` is the deck strip's inline chart: without its 34px height the svg
    # fell back to the default 150px, which is what made the *empty* deck
    # measure 413px at first paint against 49px styled once the sheet arrived.
    "nav", ".tabs", ".tab", ".deck", ".wave",
    # the paint target
    ".main", ".panel", ".hero", ".lede", ".hero-byline", ".hero-actions", ".ring",
    # the hero heading and its paragraphs, sized by the base rules: deferred,
    # the default margins made the hero taller at first paint and the whole
    # hero moved when the sheet arrived (a measured 0.007 of CLS from each)
    "h1", "h2", "h3", "p",
    # footer and the handful of utility classes the hero uses
    ".footer", ".small", ".dim", ".mono", ".ok", ".warn", ".bad", ".accent",
]

# Selectors that must be in the critical block *exactly*, not by prefix -
# element-qualified and id-qualified rules are missed by a class prefix list.
#
# `#hero` carries `max-width: 1200px; margin: 0 auto`, the hero's own box, and
# it matched no prefix. Deferred, the hero was 124px wider at first paint and
# centring it moved every hero child sideways when the sheet arrived.
#
# `.hud` is the fixed-position chrome container. Deferred, it stayed in the
# body grid and took a row, so the deck strip landed on the `1fr` row instead:
# the deck measured 413px at first paint against 49px styled and <main> moved
# 364px when the sheet arrived - CLS 0.197, essentially the desktop run's
# entire shortfall. The prefix `.hud` would drag forty decorative corner, rail
# and ring rules into the first paint to obtain one `position: fixed`.
CRITICAL_EXACT = {".hud", "#hero"}

# Every one of these must end up in the critical block. Checked after the split
# so a typo in the list above cannot quietly ship an unstyled first paint.
MUST_BE_CRITICAL = [
    ":root", "body", "body::before", ".skip-link", ".topbar", ".brand-name",
    ".chips", ".chip", ".telemetry", ".spark", ".tabs", ".tab", ".deck", ".main",
    "button", ".wave", ".hud", "#hero",
    ".topbar-actions", ".theme-toggle", ".hero-actions", ".hero-byline",
    ".panel", ".hero", ".hero-grid", ".hero-title", ".hero-kicker",
    ".hero-badges", ".lede", ".ring", ".footer", "h1",
]

# Keyframes an animation-name in the critical block refers to.
CRITICAL_KEYFRAMES = [
    "aurora-drift", "fx-sweep", "hero-glow",
    "title-glitch", "btn-sheen",
    "stars-drift", "stars-twinkle", "meteor-run", "rain-fall",
]


def strip_comments(text):
    return re.sub(r"/\*.*?\*/", "", text, flags=re.S)


def parse_blocks(css):
    """Yield (kind, prelude, body) for every top-level block.

    kind is 'rule', 'media' or 'keyframes'. Braces are matched rather than
    guessed at, so nested blocks inside @media survive intact.
    """
    out = []
    i = 0
    depth = 0
    start = 0
    prelude = ""
    while i < len(css):
        ch = css[i]
        if ch == "{":
            if depth == 0:
                prelude = css[start:i].strip()
                body_start = i + 1
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                body = css[body_start:i]
                head = prelude.split("{")[0].strip()
                if head.startswith("@media"):
                    out.append(("media", head, body))
                elif head.startswith("@keyframes"):
                    name = head.split()[1].strip()
                    out.append(("keyframes", name, body))
                elif head.startswith("@"):
                    out.append(("at", head, body))
                else:
                    out.append(("rule", prelude, body))
                start = i + 1
        i += 1
    return out


def first_token(selector):
    """The leading token of a selector: `.tab:hover` -> `.tab`, `:root` -> `:root`.

    Splitting on ':' unconditionally would turn `:root` into the empty string,
    which then matched nothing and silently dropped the design tokens - the one
    rule the whole first paint depends on.
    """
    token = selector.strip().split(",")[0].strip().split(" ")[0].split(">")[0]
    if not token.startswith(":") and not token.startswith("*"):
        token = token.split(":")[0]
    return token


def is_critical_selector(selector):
    for part in selector.split(","):
        token = first_token(part.strip())
        if token in (":root",):
            return True
        if token in CRITICAL_EXACT:
            return True
        if any(token == p or token.startswith(p) for p in CRITICAL_PREFIXES):
            return True
    return False


def split_rule(prelude, body):
    """Partition one rule's selector list into (critical, deferred) text."""
    selectors = [s.strip() for s in prelude.split(",") if s.strip()]
    crit = [s for s in selectors if is_critical_selector(s)]
    defer = [s for s in selectors if s not in crit]
    parts = []
    if crit:
        parts.append(("critical", ",\n".join(crit) + " {" + body + "}"))
    if defer:
        parts.append(("defer", ",\n".join(defer) + " {" + body + "}"))
    return parts


def split_css(css):
    critical, deferred = [], []
    for kind, prelude, body in parse_blocks(css):
        if kind == "rule":
            for where, text in split_rule(prelude, body):
                (critical if where == "critical" else deferred).append(text)
        elif kind == "keyframes":
            (critical if prelude in CRITICAL_KEYFRAMES else deferred).append(
                f"@keyframes {prelude} {{{body}}}"
            )
        elif kind == "media":
            inner = parse_blocks(body)
            keep = []
            drop = []
            for ikind, iprelude, ibody in inner:
                if ikind == "rule":
                    for where, text in split_rule(iprelude, ibody):
                        (keep if where == "critical" else drop).append(text)
                else:
                    drop.append(f"{iprelude} {{{ibody}}}")
            if keep:
                critical.append(prelude + " {\n" + "\n".join(keep) + "\n}")
            if drop:
                deferred.append(prelude + " {\n" + "\n".join(drop) + "\n}")
        else:
            deferred.append(f"{prelude} {{{body}}}")
    return critical, deferred


def hash_style(text):
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "sha256-" + base64.b64encode(digest).decode("ascii")


def main():
    app_css = APP_CSS.read_text(encoding="utf-8").replace("\r\n", "\n")
    css = strip_comments(app_css)
    critical, deferred = split_css(css)
    banner = (
        "/* Project Singularity - critical CSS, generated by tools/critical-css.py.\n"
        "   Do not edit by hand: run the script. This is the part of styles/app.css\n"
        "   the first viewport needs (the shell and the hero, which carries the\n"
        "   largest contentful paint). It is inlined into index.html under a\n"
        "   SHA-256 in the CSP, so the strict `style-src 'self'` needs no\n"
        "   'unsafe-inline'; styles/app.css loads straight afterwards and covers\n"
        "   everything else. */\n"
    )
    body = banner + "\n".join(critical) + "\n"
    body = re.sub(r"\n{3,}", "\n\n", body)

    present = [s for s in MUST_BE_CRITICAL if re.search(r"(^|[\s,])" + re.escape(s) + r"\b", body, re.M)]
    missing = [s for s in MUST_BE_CRITICAL if s not in present]
    if missing:
        print("critical CSS is missing required selectors: " + ", ".join(missing), file=sys.stderr)
        return 1

    digest = hash_style(body)
    index = INDEX.read_text(encoding="utf-8").replace("\r\n", "\n")
    headers = HEADERS.read_text(encoding="utf-8").replace("\r\n", "\n")

    # The text between the tags must be exactly `body`: a leading newline for
    # prettiness is a different hash, and the browser would refuse the block.
    block = f'<style id="critical">{body}</style>'
    if "<!-- critical-css:start -->" not in index:
        print("index.html has no critical-css markers to fill", file=sys.stderr)
        return 1

    def replace_block(match):
        # No indentation is added inside <style>: the CSP hashes the element's exact
        # text, so a prettified copy of the same CSS is a different resource as far
        # as the browser is concerned. That mistake cost the first paint its styling
        # once; the round-trip check below catches it now.
        return "<!-- critical-css:start -->\n" + block + "\n    <!-- critical-css:end -->"

    new_index = re.sub(
        r"<!-- critical-css:start -->.*?<!-- critical-css:end -->", replace_block, index, flags=re.S
    )
    style_src_meta = "style-src 'self' file: '" + digest + "'"
    new_index = re.sub(r"style-src 'self' file:( 'sha256-[^;']+')?", style_src_meta, new_index)
    style_src_header = "style-src 'self' '" + digest + "'"
    new_headers = re.sub(r"style-src 'self'( 'sha256-[^;']+')?", style_src_header, headers)

    problems = []
    if style_src_meta not in new_index:
        problems.append("index.html meta policy does not carry the style hash")
    if style_src_header not in new_headers:
        problems.append("_headers does not carry the style hash")
    # Round-trip: the browser hashes the text between the tags, so hash what was
    # actually written rather than the string we intended to write. This catches
    # added indentation, a stray newline, or a stale block from an interrupted
    # run - each of which silently unsticks the first paint.
    mirrored = re.search(r'<style id="critical">(.*?)</style>', new_index, re.S)
    if not mirrored:
        problems.append('index.html has no <style id="critical"> block')
    elif hash_style(mirrored.group(1)) != digest:
        problems.append('the inline block does not hash to the policy: ' + hash_style(mirrored.group(1)))
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1

    crit_kib = len(body.encode()) / 1024
    defer_kib = len("\n".join(deferred).encode()) / 1024
    crit_gz = len(gzip.compress(body.encode(), 9)) / 1024
    print(f"# critical  {crit_kib:6.1f} KiB raw ({crit_gz:5.1f} KiB gzip) inlined into index.html")
    print(f"# deferred  {defer_kib:6.1f} KiB raw stays in styles/app.css")
    print(f"# sha256 {digest}")
    print(f"# meta   {style_src_meta}")
    print(f"# header {style_src_header}")

    if CHECK:
        drift = []
        if CRITICAL_CSS.read_text(encoding="utf-8").replace("\r\n", "\n") != body:
            drift.append("styles/critical.css is stale")
        if index != new_index:
            drift.append("index.html is stale")
        if headers != new_headers:
            drift.append("_headers is stale")
        if drift:
            print("drift: " + "; ".join(drift) + " - run tools/critical-css.py", file=sys.stderr)
            return 1
        print("# check: no drift")
        return 0

    CRITICAL_CSS.write_text(body, encoding="utf-8", newline="\n")
    INDEX.write_text(new_index, encoding="utf-8", newline="\n")
    HEADERS.write_text(new_headers, encoding="utf-8", newline="\n")
    print("# written: styles/critical.css, index.html, _headers")
    return 0


if __name__ == "__main__":
    sys.exit(main())
