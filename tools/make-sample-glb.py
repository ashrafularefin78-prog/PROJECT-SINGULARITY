#!/usr/bin/env python3
"""Generate the sample GLB the M3 panel renders.

    python3 tools/make-sample-glb.py

The output is `assets/models/singularity-core.glb`, a real glTF 2.0 binary
container with three primitives, three PBR metallic-roughness materials, a
nested node hierarchy and one mesh that deliberately ships *without* normals so
the loader's flat-normal generator has shipped work to do. It is generated
rather than downloaded so the repository keeps its "no third-party asset"
shape and the file can be reproduced byte-for-byte:

    sphere  (indexed, NORMAL present)  — the core
    torus   (indexed, NORMAL present)  — a ring, rotated 90° about X by its node
    octahedron (non-indexed, no NORMAL) — a child node, so world matrices are a
            composition, not a single TRS

The file is written deterministically: no timestamps, sorted JSON keys,
little-endian binary, 4-byte-aligned chunks.
"""
import json
import math
import os
import struct

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "models", "singularity-core.glb")

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
FLOAT = 5126
USHORT = 5123


def uv_sphere(radius, segments, rings):
    """Indexed sphere with per-vertex normals. Returns (positions, normals, indices)."""
    positions, normals, indices = [], [], []
    for r in range(rings + 1):
        phi = math.pi * r / rings
        for s in range(segments + 1):
            theta = 2 * math.pi * s / segments
            nx = math.sin(phi) * math.cos(theta)
            ny = math.cos(phi)
            nz = math.sin(phi) * math.sin(theta)
            positions += [nx * radius, ny * radius, nz * radius]
            normals += [nx, ny, nz]
    for r in range(rings):
        for s in range(segments):
            a = r * (segments + 1) + s
            b = a + segments + 1
            indices += [a, b, a + 1, b, b + 1, a + 1]
    return positions, normals, indices


def torus(major, minor, segments, sides):
    """Indexed torus in the XY plane (before the node's own rotation)."""
    positions, normals, indices = [], [], []
    for i in range(segments + 1):
        u = 2 * math.pi * i / segments
        for j in range(sides + 1):
            v = 2 * math.pi * j / sides
            nx = math.cos(v) * math.cos(u)
            ny = math.sin(v)
            nz = math.cos(v) * math.sin(u)
            positions += [(major + minor * math.cos(v)) * math.cos(u), minor * math.sin(v),
                          (major + minor * math.cos(v)) * math.sin(u)]
            normals += [nx, ny, nz]
    for i in range(segments):
        for j in range(sides):
            a = i * (sides + 1) + j
            b = a + sides + 1
            indices += [a, b, a + 1, b, b + 1, a + 1]
    return positions, normals, indices


def octahedron(size):
    """Non-indexed octahedron. No NORMAL data on purpose: the loader generates
    flat normals per face when the accessor is absent."""
    up, down = [0, size, 0], [0, -size, 0]
    ring = [[size, 0, 0], [0, 0, size], [-size, 0, 0], [0, 0, -size]]
    faces = [(up, ring[0], ring[1]), (up, ring[1], ring[2]),
             (up, ring[2], ring[3]), (up, ring[3], ring[0]),
             (down, ring[1], ring[0]), (down, ring[2], ring[1]),
             (down, ring[3], ring[2]), (down, ring[0], ring[3])]
    positions = [component for face in faces for vertex in face for component in vertex]
    return positions


class Blob:
    """A growable little-endian binary buffer with 4-byte alignment."""

    def __init__(self):
        self.data = bytearray()

    def pad(self, alignment=4):
        while len(self.data) % alignment:
            self.data.append(0)

    def floats(self, values):
        self.pad(4)
        offset = len(self.data)
        self.data += struct.pack("<%df" % len(values), *values)
        return offset, len(values) * 4

    def ushorts(self, values):
        self.pad(2)
        offset = len(self.data)
        self.data += struct.pack("<%dH" % len(values), *values)
        return offset, len(values) * 2


def main():
    blob = Blob()
    buffer_views, accessors = [], []

    def add_view(offset, length, target=None):
        view = {"buffer": 0, "byteOffset": offset, "byteLength": length}
        if target:
            view["target"] = target
        buffer_views.append(view)
        return len(buffer_views) - 1

    def add_accessor(view, component_type, kind, count):
        accessors.append({"bufferView": view, "componentType": component_type,
                          "count": count, "type": kind})
        return len(accessors) - 1

    def add_indexed_triangles(positions, normals, indices):
        pos_view = add_view(*blob.floats(positions), target=34962)
        nrm_view = add_view(*blob.floats(normals), target=34962)
        idx_view = add_view(*blob.ushorts(indices), target=34963)
        return {
            "attributes": {
                "POSITION": add_accessor(pos_view, FLOAT, "VEC3", len(positions) // 3),
                "NORMAL": add_accessor(nrm_view, FLOAT, "VEC3", len(normals) // 3),
            },
            "indices": add_accessor(idx_view, USHORT, "SCALAR", len(indices)),
            "mode": 4,
        }

    def add_flat_triangles(positions):
        pos_view = add_view(*blob.floats(positions), target=34962)
        return {
            "attributes": {"POSITION": add_accessor(pos_view, FLOAT, "VEC3", len(positions) // 3)},
            "mode": 4,
        }

    sphere = uv_sphere(1.55, 28, 18)
    ring = torus(2.7, 0.30, 40, 16)
    shard = octahedron(0.9)

    core_prim = add_indexed_triangles(*sphere)
    core_prim["material"] = 0
    ring_prim = add_indexed_triangles(*ring)
    ring_prim["material"] = 1
    shard_prim = add_flat_triangles(shard)
    shard_prim["material"] = 2

    gltf = {
        "asset": {"version": "2.0", "generator": "tools/make-sample-glb.py"},
        "scene": 0,
        "scenes": [{"nodes": [0, 1, 2]}],
        "nodes": [
            {"name": "core", "mesh": 0, "translation": [0, 2.6, 0]},
            # 90° about X, as a quaternion: the ring lies in the XZ plane.
            {"name": "ring", "mesh": 1, "translation": [0, 2.6, 0],
             "rotation": [0.7071067811865476, 0, 0, 0.7071067811865476]},
            # A parent with no mesh, and one child: the shard's world matrix is
            # the composition of two TRS nodes, which is the point of the test.
            {"name": "orbit", "translation": [0, 2.6, 0], "children": [3]},
            {"name": "shard", "mesh": 2, "translation": [3.7, 0.3, 0],
             "scale": [0.62, 0.62, 0.62]},
        ],
        "meshes": [
            {"name": "core", "primitives": [core_prim]},
            {"name": "ring", "primitives": [ring_prim]},
            {"name": "shard", "primitives": [shard_prim]},
        ],
        "materials": [
            {"name": "core", "pbrMetallicRoughness": {
                "baseColorFactor": [0.85, 0.89, 0.97, 1.0],
                "metallicFactor": 0.9, "roughnessFactor": 0.2}},
            {"name": "ring", "pbrMetallicRoughness": {
                "baseColorFactor": [0.38, 0.62, 1.0, 1.0],
                "metallicFactor": 0.6, "roughnessFactor": 0.3}},
            {"name": "shard", "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 0.62, 0.32, 1.0],
                "metallicFactor": 0.2, "roughnessFactor": 0.55}},
        ],
        "bufferViews": buffer_views,
        "accessors": accessors,
        "buffers": [{"byteLength": len(blob.data)}],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":"), sort_keys=True).encode("utf-8")
    json_pad = (4 - len(json_bytes) % 4) % 4
    json_bytes += b" " * json_pad
    bin_pad = (4 - len(blob.data) % 4) % 4
    bin_bytes = bytes(blob.data) + b"\x00" * bin_pad

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(json_bytes), CHUNK_JSON) + json_bytes
    out += struct.pack("<II", len(bin_bytes), CHUNK_BIN) + bin_bytes

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as fh:
        fh.write(out)

    triangles = len(sphere[2]) // 3 + len(ring[2]) // 3 + len(shard) // 9
    print(f"# {os.path.relpath(OUT, ROOT)}")
    print(f"# {len(out)} bytes · {len(gltf['meshes'])} meshes · "
          f"{len(gltf['nodes'])} nodes · {len(gltf['materials'])} materials · {triangles} triangles")


if __name__ == "__main__":
    main()
