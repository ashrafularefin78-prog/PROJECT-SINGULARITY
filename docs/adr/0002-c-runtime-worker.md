# ADR 0002 — In-browser C runtime in a budgeted worker

## Status
Accepted (partial)

## Context
M2 needs to run student C without shipping clang, TCC or a WASM build pipeline.

## Decision
A hand-written lexer, parser and interpreter run inside a Web Worker with step,
heap, depth and wall-clock budgets. Diagnostics carry line and column; a kill
switch ends runaway programs; the heap is a bounds-checked arena.

## Consequences
- Zero runtime dependencies and no native toolchain.
- Only a C subset is supported: no variadic user functions, no full preprocessor,
  and a struct tag needs a typedef.
- Interpreter is slower than native/WASM.
