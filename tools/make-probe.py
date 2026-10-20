#!/usr/bin/env python3
"""Generate the bundled Radiance RGBE probe.

The M3 panel can light the scene from a *measured* HDR probe instead of only the
procedural sky. The probe has to ship with the repository (no CDN, no licence
question), so it is generated deterministically from an analytic sky and written
as a real `.hdr` file: RGBE, flat scanlines, `-Y +X` orientation.

    python3 tools/make-probe.py

A sun disc, a sky gradient, a horizon glow and a warm ground bounce. It is
deliberately not a photograph: the point is the pipeline (decode -> SH ->
irradiance cube) and the measurement, and any other probe can replace this file.
"""
import math
import os

W, H = 64, 32
SUN = (0.42, 0.38, 0.82)  # roughly 22 degrees above the horizon
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "probes", "singularity-sky.hdr")


def normalize(v):
    n = math.sqrt(sum(c * c for c in v)) or 1.0
    return tuple(c / n for c in v)


SUN = normalize(SUN)


def radiance(dx, dy, dz):
    up = max(0.0, dy)
    down = max(0.0, -dy)
    # Sky gradient: deep blue at the zenith fading to a pale horizon.
    sky = (0.06 + 0.20 * up, 0.10 + 0.30 * up, 0.20 + 0.55 * up)
    horizon = math.exp(-abs(dy) * 9.0)
    sky = (sky[0] + 0.30 * horizon, sky[1] + 0.26 * horizon, sky[2] + 0.18 * horizon)
    # Sun disc with a tight falloff and a broader glow.
    cos_sun = max(0.0, dx * SUN[0] + dy * SUN[1] + dz * SUN[2])
    sun = 14.0 * (cos_sun ** 900) + 1.6 * (cos_sun ** 24)
    rgb = (sky[0] + sun, sky[1] + sun * 0.94, sky[2] + sun * 0.80)
    # Ground bounce: dim and warm, only below the horizon.
    ground = down * down
    return (rgb[0] + 0.05 * ground, rgb[1] + 0.043 * ground, rgb[2] + 0.035 * ground)


def to_rgbe(rgb):
    v = max(rgb)
    if v < 1e-32:
        return (0, 0, 0, 0)
    m, e = math.frexp(v)  # v = m * 2**e, 0.5 <= m < 1
    scale = m * 256.0 / v
    return (
        max(0, min(255, int(rgb[0] * scale))),
        max(0, min(255, int(rgb[1] * scale))),
        max(0, min(255, int(rgb[2] * scale))),
        max(0, min(255, e + 128)),
    )


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    rows = []
    for y in range(H):
        lat = (0.5 - (y + 0.5) / H) * math.pi
        row = bytearray()
        for x in range(W):
            lon = ((x + 0.5) / W - 0.5) * 2 * math.pi
            dx = math.cos(lat) * math.sin(lon)
            dy = math.sin(lat)
            dz = math.cos(lat) * math.cos(lon)
            row.extend(to_rgbe(radiance(dx, dy, dz)))
        rows.append(bytes(row))

    header = b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y %d +X %d\n" % (H, W)
    with open(OUT, "wb") as fh:
        fh.write(header)
        for row in rows:
            fh.write(row)
    print(f"wrote {OUT} ({len(header) + W * H * 4} bytes, {W}x{H})")


if __name__ == "__main__":
    main()
