# ADR 0003 — WebGL2-only 3D engine

## Status
Accepted (partial)

## Context
M3 must render a real 3D scene on a strict JavaScript budget and a WebGL2 target.

## Decision
Instanced draws with vertex-shader animation, a depth-only PCF shadow pass,
particles generated from gl_VertexID, Cook-Torrance PBR lit by a deterministic
procedural environment, and a glTF 2.0 loader that materialises accessors,
images, samplers and textures (SRGB8_ALPHA8 base-colour, RGBA8 normal maps).

## Consequences
- Runs on commodity hardware; 100k instances and 1M particles in 4 draw calls.
- No skeletal animation or WebGPU path yet; normals are generated flat when absent.
