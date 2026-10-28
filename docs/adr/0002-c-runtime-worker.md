# ADR 0002 — In-browser C runtime in a budgeted worker

## Status
Accepted (partial)

## Context
M2 must compile real C/C++ locally while keeping untrusted execution off the page.
The browser/WebAssembly approach was chosen instead of a compilation server.

## Decision
Self-host Clang 8.0.1, lld, memfs and a WASI C/C++ sysroot as compressed assets.
A disposable worker checks hashes, compiles multiple sources, links WebAssembly
and runs it with restricted WASI imports. Compilation and execution have separate
wall-clock limits. The hand-written C interpreter remains a selectable mode with
step, heap and depth budgets and a bounds-checked arena.

The compiler path caps combined stdout/stderr bytes across compilation, linking
and execution at 1 MiB. Execution also permits at most 4096 nonempty runtime
writes; empty writes do not consume this count. Exceeding either output budget
fails the run rather than allowing unbounded terminal output or worker messages.
These output limits do not bound compiler working memory.

## Consequences
- No source upload or npm dependencies; third-party runtime assets are explicit.
- About 18.4 MiB shipped compressed toolchain assets including notices; the compiler loads its assets on demand, separately from the deferred JavaScript graph. Compiler working memory is additional.
- Clang 8.0.1 supports C through C11 and C++ through C++17; no C++ exceptions, native OS APIs, threads or network.
- The default 32 MiB generated-program linear-memory cap is not a compiler-memory cap; no compiler-memory limit is claimed.
- The interpreter is a separate C subset, not a full C/C++ implementation.
