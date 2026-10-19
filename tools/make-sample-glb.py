#!/usr/bin/env python3
"""Generate the sample GLB the M3 panel renders.

    python3 tools/make-sample-glb.py

The output is `assets/models/singularity-core.glb`, a real glTF 2.0 binary
container with three primitives, three PBR metallic-roughness materials, a
nested node hierarchy and one mesh that deliberately ships *without* normals so
the loader's flat-normal generator has shipped work to do. It is generated
rather than downloaded so the repository keeps its "no third-party asset"
shape and the file can be reproduced byte-for-byte:

    sphere  (indexed, NORMAL present, textured)  — the core
    torus   (indexed, NORMAL present, textured)  — a ring, rotated 90° about X
            by its node
    octahedron (non-indexed, no NORMAL, no texture) — a child node, so world
            matrices are a composition, not a single TRS, and the loader/
            renderer fall back to the flat-normal + material-colour path

The two textured primitives each carry a TEXCOORD_0 attribute, plus

    - a base-colour PNG, sampled through an sRGB texture in the renderer, and
    - a tangent-space normal PNG, whose normals are tangent-frame up (+z) over
      a flat UV island, so the engine's computed tangents give a correct
      T × B × N basis with no KHR tangent hint.

The PNGs are written by hand against the PNG spec (stdlib zlib for the IDAT
stream) so the generator keeps its "no third-party asset" shape. Every number
is deterministic: no timestamps, sorted JSON keys, little-endian binary,
4-byte-aligned chunks, seeded hashes, wrapped height fields.
"""
import json
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "models", "singularity-core.glb")

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
FLOAT = 5126
USHORT = 5123
TEX_SIZE = 128

TEX_WRAP_REPEAT = 10497
MAG_LINEAR = 9729
MIN_LINEAR_MIPMAP_LINEAR = 9987


def seeded_hash(ix, iy, seed=0x5EED):
    """The same 32-bit integer hash src/graphics/env.js uses for its stars, so
    the textures tie into the app's own deterministic-noise family."""
    h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return (h ^ (h >> 16)) & 0xFFFFFFFF


def value_noise(x, y, period):
    """Bilinear value noise over a wrapping lattice with that hash. The lattice
    wraps on `period`, so horizontal/vertical tiling is exact."""
    x0, y0 = math.floor(x) % period, math.floor(y) % period
    x1, y1 = (x0 + 1) % period, (y0 + 1) % period
    fx, fy = x - math.floor(x), y - math.floor(y)
    sx = fx * fx * (3 - 2 * fx)
    sy = fy * fy * (3 - 2 * fy)
    n00 = seeded_hash(x0, y0) / 0xFFFFFFFF * 2 - 1
    n10 = seeded_hash(x1, y0) / 0xFFFFFFFF * 2 - 1
    n01 = seeded_hash(x0, y1) / 0xFFFFFFFF * 2 - 1
    n11 = seeded_hash(x1, y1) / 0xFFFFFFFF * 2 - 1
    a = n00 * (1 - sx) + n10 * sx
    b = n01 * (1 - sx) + n11 * sx
    return a * (1 - sy) + b * sy


def encode_png(width, height, pixels):
    """A real PNG, hand-written against the spec: signature, IHDR (8-bit RGBA,
    colour type 6), one IDAT of zlib-compressed scanlines each prefixed with
    filter byte 0 (None), IEND. stdlib-only, deterministic (fixed zlib level)."""
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))
    stride = width * 4
    scanlines = bytearray()
    for row in range(height):
        scanlines.append(0)  # filter type None
        scanlines += pixels[row * stride:(row + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(scanlines), 9))
            + chunk(b"IEND", b""))


def clamp01(v):
    return max(0.0, min(1.0, v))


def height_field_core(u, v):
    """Panel bumps for the core: four aligned studs per tile plus fine grain.
    Analytic and periodic, so the field tiles exactly on the texture edges."""
    gu, gv = u * 2 - 0.5, v * 2 - 0.5
    stud = math.exp(-((gu % 0.5 - 0.25) ** 2 + (gv % 0.5 - 0.25) ** 2) / 0.012)
    grain = value_noise(u * 16, v * 16, 16)
    return stud * 0.85 + grain * 0.06


def height_field_ring(u, v):
    """Ridged anodised bands for the ring: ridges run across u. Periodic in u
    with a raised seam every 8 texels, plus grain in v."""
    ridge = 0.5 + 0.5 * math.sin(2 * math.pi * u * 18)
    ridge = ridge ** 3  # sharpen into ridges
    grain = value_noise(u * 24, v * 10, 24)
    return ridge * 0.9 + grain * 0.05


def height_field_to_rgba(fn, size=TEX_SIZE, strength=2.0):
    """Sample the height field on a size×size grid and emit a tangent-space
    normal map: n = normalize(-dh/du, -dh/dv, 1/strength), encoded rgb = n *
    0.5 + 0.5. Derivatives are central differences with wrap, so the map is
    seamless. Alpha is 255 everywhere like every honoured normal map."""
    step = 1.0 / size
    px = bytearray(size * size * 4)
    for row in range(size):
        v = (row + 0.5) / size
        for col in range(size):
            u = (col + 0.5) / size
            du = (fn(u + step, v) - fn(u - step, v)) * size
            dv = (fn(u, v + step) - fn(u, v - step)) * size
            nx, ny, nz = -du * strength, -dv * strength, 1.0
            length = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
            o = (row * size + col) * 4
            px[o] = round(((nx / length) * 0.5 + 0.5) * 255)
            px[o + 1] = round(((ny / length) * 0.5 + 0.5) * 255)
            px[o + 2] = round(((nz / length) * 0.5 + 0.5) * 255)
            px[o + 3] = 255
    return bytes(px)


def core_texture(size=TEX_SIZE):
    """The core's base colour, sRGB: brushed steel-blue with a violet sheen,
    panel seams along stud boundaries, and a highlight that follows the studs.
    Periodic in u and v, so it tiles exactly."""
    px = bytearray(size * size * 4)
    for row in range(size):
        v = row / size
        for col in range(size):
            u = col / size
            seam = abs((u * 2) % 0.5 - 0.25) < 0.012 or abs((v * 2) % 0.5 - 0.25) < 0.012
            gu, gv = u * 2 - 0.5, v * 2 - 0.5
            stud = math.exp(-((gu % 0.5 - 0.25) ** 2 + (gv % 0.5 - 0.25) ** 2) / 0.012)
            grain = value_noise(u * 16, v * 16, 16)
            r = 0.50 + 0.10 * stud + 0.06 * grain - (0.28 if seam else 0.0)
            g = 0.54 + 0.11 * stud + 0.07 * grain - (0.30 if seam else 0.0)
            b = 0.62 + 0.12 * stud + 0.09 * grain - (0.34 if seam else 0.0)
            o = (row * size + col) * 4
            px[o] = round(clamp01(r) * 255)
            px[o + 1] = round(clamp01(g) * 255)
            px[o + 2] = round(clamp01(b) * 255)
            px[o + 3] = 255
    return bytes(px)


def ring_texture(size=TEX_SIZE):
    """The ring's base colour, sRGB: teal anodising, brightness picked out on
    the ridge tops with a warm flash at the brightest ridges. Periodic in u by
    construction (sin over whole cycles) and grain-wrapped in v."""
    px = bytearray(size * size * 4)
    for row in range(size):
        v = row / size
        for col in range(size):
            u = col / size
            ridge = (0.5 + 0.5 * math.sin(2 * math.pi * u * 18)) ** 3
            grain = value_noise(u * 24, v * 10, 24)
            r = 0.30 + 0.34 * ridge + 0.10 * grain + 0.12 * ridge * ridge
            g = 0.62 + 0.30 * ridge + 0.12 * grain
            b = 0.70 + 0.26 * ridge + 0.13 * grain
            o = (row * size + col) * 4
            px[o] = round(clamp01(r) * 255)
            px[o + 1] = round(clamp01(g) * 255)
            px[o + 2] = round(clamp01(b) * 255)
            px[o + 3] = 255
    return bytes(px)


def uv_sphere(radius, segments, rings):
    """Indexed sphere with per-vertex normals, plus TEXCOORD_0 (u wraps the
    longitude, v spans pole to pole). Returns (positions, normals, uvs, indices)."""
    positions, normals, uvs, indices = [], [], [], []
    for r in range(rings + 1):
        phi = math.pi * r / rings
        for s in range(segments + 1):
            theta = 2 * math.pi * s / segments
            nx = math.sin(phi) * math.cos(theta)
            ny = math.cos(phi)
            nz = math.sin(phi) * math.sin(theta)
            positions += [nx * radius, ny * radius, nz * radius]
            normals += [nx, ny, nz]
            uvs += [s / segments, r / rings]
    for r in range(rings):
        for s in range(segments):
            a = r * (segments + 1) + s
            b = a + segments + 1
            indices += [a, b, a + 1, b, b + 1, a + 1]
    return positions, normals, uvs, indices


def torus(major, minor, segments, sides):
    """Indexed torus in the XY plane (before the node's own rotation), with
    TEXCOORD_0 (u around the major circumference, v around the tube)."""
    positions, normals, uvs, indices = [], [], [], []
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
            uvs += [i / segments, j / sides]
    for i in range(segments):
        for j in range(sides):
            a = i * (sides + 1) + j
            b = a + sides + 1
            indices += [a, b, a + 1, b, b + 1, a + 1]
    return positions, normals, uvs, indices


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

    def raw(self, data):
        """Embed opaque bytes (a PNG image) with no alignment requirement of
        its own; the buffer stays 4-byte aligned afterwards."""
        self.pad(4)
        offset = len(self.data)
        self.data += data
        return offset, len(data)


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

    def add_indexed_triangles(positions, normals, uvs, indices, textured=False):
        pos_view = add_view(*blob.floats(positions), target=34962)
        nrm_view = add_view(*blob.floats(normals), target=34962)
        idx_view = add_view(*blob.ushorts(indices), target=34963)
        prim = {
            "attributes": {
                "POSITION": add_accessor(pos_view, FLOAT, "VEC3", len(positions) // 3),
                "NORMAL": add_accessor(nrm_view, FLOAT, "VEC3", len(normals) // 3),
            },
            "indices": add_accessor(idx_view, USHORT, "SCALAR", len(indices)),
            "mode": 4,
        }
        if textured:
            uv_view = add_view(*blob.floats(uvs), target=34962)
            prim["attributes"]["TEXCOORD_0"] = add_accessor(uv_view, FLOAT, "VEC2", len(uvs) // 2)
        return prim

    def add_flat_triangles(positions):
        pos_view = add_view(*blob.floats(positions), target=34962)
        return {
            "attributes": {"POSITION": add_accessor(pos_view, FLOAT, "VEC3", len(positions) // 3)},
            "mode": 4,
        }

    sphere = uv_sphere(1.55, 28, 18)
    ring = torus(2.7, 0.30, 40, 16)
    shard = octahedron(0.9)

    # The four textures: base colour and tangent-space normals for the two
    # textured primitives, each a self-contained PNG in its own buffer view.
    tex_bytes = [
        encode_png(TEX_SIZE, TEX_SIZE, core_texture()),                     # 0 core base colour
        encode_png(TEX_SIZE, TEX_SIZE, height_field_to_rgba(height_field_core)),    # 1 core normal
        encode_png(TEX_SIZE, TEX_SIZE, ring_texture()),                     # 2 ring base colour
        encode_png(TEX_SIZE, TEX_SIZE, height_field_to_rgba(height_field_ring)),    # 3 ring normal
    ]
    image_views = [add_view(*blob.raw(data)) for data in tex_bytes]
    images = [{"bufferView": view, "mimeType": "image/png"} for view in image_views]
    samplers = [{
        "wrapS": TEX_WRAP_REPEAT,
        "wrapT": TEX_WRAP_REPEAT,
        "magFilter": MAG_LINEAR,
        "minFilter": MIN_LINEAR_MIPMAP_LINEAR,
    }]
    textures = [{"sampler": 0, "source": i} for i in range(len(images))]

    # TEXCOORD_0 and the texture tables must agree: indices are (0 base, 1
    # normal) for the core and (2 base, 3 normal) for the ring.
    core_prim = add_indexed_triangles(*sphere, textured=True)
    core_prim["material"] = 0
    ring_prim = add_indexed_triangles(*ring, textured=True)
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
                "baseColorTexture": {"index": 0},
                "metallicFactor": 0.9, "roughnessFactor": 0.2},
             "normalTexture": {"index": 1, "texCoord": 0, "scale": 1.0}},
            {"name": "ring", "pbrMetallicRoughness": {
                "baseColorFactor": [0.38, 0.62, 1.0, 1.0],
                "baseColorTexture": {"index": 2},
                "metallicFactor": 0.6, "roughnessFactor": 0.3},
             "normalTexture": {"index": 3, "texCoord": 0, "scale": 1.0}},
            {"name": "shard", "pbrMetallicRoughness": {
                "baseColorFactor": [1.0, 0.62, 0.32, 1.0],
                "metallicFactor": 0.2, "roughnessFactor": 0.55}},
        ],
        "images": images,
        "samplers": samplers,
        "textures": textures,
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

    triangles = len(sphere[3]) // 3 + len(ring[3]) // 3 + len(shard) // 9
    print(f"# {os.path.relpath(OUT, ROOT)}")
    print(f"# {len(out)} bytes · {len(gltf['meshes'])} meshes · "
          f"{len(gltf['nodes'])} nodes · {len(gltf['materials'])} materials · "
          f"{len(images)} images · {triangles} triangles")


if __name__ == "__main__":
    main()
