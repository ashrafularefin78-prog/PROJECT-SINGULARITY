/**
 * The memory-error model used by M2's runtime sanitizer and by the static
 * audit in hardening.js. One table defines every finding kind, so a runtime
 * finding and a static finding of the same bug class carry the same severity,
 * the same CWE tag and the same advice - two vocabularies for one bug is how a
 * learner ends up trusting neither.
 *
 * The policy that matters: a finding is a REPORT, never a new crash. The
 * interpreter already fails closed on its own errors (a null dereference, an
 * access past the end of an allocation), and programs that depend on those
 * throws must keep depending on them. The sanitizer's job is the cases where
 * the runtime currently says nothing at all - a stale handle, a recycled block,
 * a heap byte that was never written - and those are surfaced as findings
 * without moving a single value the program can see.
 */

export const SANITIZER_VERSION = '1.0';

export const FINDING_KINDS = Object.freeze({
  'use-after-free': {
    severity: 'error',
    cwe: 'CWE-416',
    title: 'use after free',
    why: 'The block was released, so its bytes may already belong to another allocation: the read returns what the next malloc wrote there, and the write lands inside it.',
    fix: 'Set the pointer to NULL after free(), and never keep a second handle to the same block past the free.',
  },
  'double-free': {
    severity: 'error',
    cwe: 'CWE-415',
    title: 'double free',
    why: 'Releasing the same block twice puts it in the free list twice, so two later allocations can hand out the same memory to two owners.',
    fix: 'Free once, then assign NULL. A helper that frees should not be called from two paths that both think they own the block.',
  },
  'invalid-free': {
    severity: 'error',
    cwe: 'CWE-763',
    title: 'free of a pointer that is not an allocation',
    why: 'free() expects the exact pointer malloc returned. An interior offset, a stack address or a literal cannot be released.',
    fix: 'Free the pointer the allocation call handed back, not an arithmetic result derived from it.',
  },
  'uninitialized-read': {
    severity: 'error',
    cwe: 'CWE-457',
    title: 'read of heap that was never written',
    why: 'malloc does not clear memory, so an unwritten byte holds whatever the previous owner left. This sandbox zero-fills, which makes the bug invisible here and random under a real compiler.',
    fix: 'Write every field you read, or use calloc() when zeroed storage is the intent - calloc is a promise, malloc is not.',
  },
  'memory-leak': {
    severity: 'warning',
    cwe: 'CWE-401',
    title: 'allocation never released',
    why: 'The block is still live when main returns, so its memory is unreachable and unreleased. Bounded in a demo, fatal in a loop.',
    fix: 'Free along every exit path, including the early returns and the error branches.',
  },
  'unbounded-copy': {
    severity: 'error',
    cwe: 'CWE-119',
    title: 'copy with no destination bound',
    why: 'strcpy and strcat write until the source ends. The destination has to be proven at least that long, and the compiler cannot see the source length.',
    fix: 'snprintf(dst, sizeof(dst), "%s", src) - the size is a constant, so the bound is checkable.',
  },
  'unbounded-scan': {
    severity: 'error',
    cwe: 'CWE-120',
    title: 'input read with no field width',
    why: 'scanf("%s", buf) writes as many characters as the input contains. The buffer size is known at compile time; the input is not.',
    fix: 'Put the width in the format and keep it equal to the buffer: scanf("%15s", buf) for char buf[16].',
  },
  'dangerous-function': {
    severity: 'error',
    cwe: 'CWE-676',
    title: 'call to a function with no bound at all',
    why: 'gets() cannot be given a size, which is why it was deleted from the language; the caller has no way to stop it.',
    fix: 'fgets(buf, sizeof(buf), stdin) - it keeps the newline, so strip it if you do not want it.',
  },
  'format-string-from-input': {
    severity: 'error',
    cwe: 'CWE-134',
    title: 'format string that is not a literal',
    why: 'printf(s) with s under the user\'s control lets the input choose conversions, and %x and %n read and write the stack.',
    fix: 'printf("%s", s) - the format is yours, the data is theirs.',
  },
  'stack-address-escaped': {
    severity: 'error',
    cwe: 'CWE-562',
    title: 'pointer to a local handed out of its scope',
    why: 'The storage ends when the function returns, so the pointer names bytes the next call overwrites.',
    fix: 'Return the value, or allocate it and make the caller free it.',
  },
  'unterminated-string': {
    severity: 'error',
    cwe: 'CWE-170',
    title: 'copy that can leave the destination unterminated',
    why: 'strncpy stops at n without guaranteeing a NUL, so the destination is only a string if the source was shorter than the room you gave it.',
    fix: 'Copy with snprintf(dst, sizeof(dst), "%s", src), or reserve the last byte: strncpy(dst, src, size - 1); dst[size - 1] = 0;',
  },
  'unchecked-allocation': {
    severity: 'warning',
    cwe: 'CWE-252',
    title: 'allocation result used without a check',
    why: 'malloc returns NULL when it fails. Writing through it dereferences null on that path, and the size that failed is usually the interesting one.',
    fix: 'Check for NULL immediately after the call and exit or recover.',
  },
  'overflowing-size-computation': {
    severity: 'error',
    cwe: 'CWE-190',
    title: 'allocation size computed in a type that can wrap',
    why: 'n * sizeof(T) overflows in int, and the product that reaches malloc can be smaller than the array that is then written.',
    fix: 'Compute the size in size_t and bound n before multiplying.',
  },
});

export const findingKind = (kind) => FINDING_KINDS[kind] || null;

/** One finding, positioned in the program that caused it. */
export function makeFinding(kind, { line = 1, col = 1, detail = '' } = {}) {
  const meta = FINDING_KINDS[kind];
  if (!meta) throw new Error(`unknown finding kind '${kind}'`);
  return { kind, severity: meta.severity, cwe: meta.cwe, title: meta.title, why: meta.why, fix: meta.fix, line, col, detail };
}

/**
 * A live heap block, as the sanitizer sees it.
 *
 * `generation` is what makes a stale handle detectable: an offset can be handed
 * out again after it is freed, and two handles over the same offset are only
 * distinguishable by which allocation each one came from. The count is per
 * offset, so a block that is allocated, freed and re-allocated at the same
 * address gets a generation the older handle cannot match.
 */
class Block {
  constructor(offset, size, generation, { cleared = false, line = 1 } = {}) {
    this.offset = offset;
    this.size = size;
    this.generation = generation;
    this.line = line;
    // One flag per byte: written by the program, or only zero-filled by the
    // allocator. calloc clears as a promise, malloc does not clear at all, and
    // the difference is exactly what the uninitialized check reports.
    this.written = new Uint8Array(size);
    if (cleared) this.written.fill(1);
  }
}

/**
 * The runtime side of the model. The interpreter owns the arena and calls this
 * on each event; it never changes what a program reads or writes, and it throws
 * nothing. Every method is cheap when the event is not one it can judge.
 */
export class Sanitizer {
  constructor() {
    this.blocks = new Map();
    this.generations = new Map();
    // Field address -> the generation the pointer stored there was born from.
    // A pointer field holds an arena offset, and an offset outlives the block it
    // came from, so the number alone cannot say whether the block behind it is
    // still the one that was written. Remembering the generation at write time
    // turns a later read of that field into a checkable claim.
    this.fieldGen = new Map();
    this.findings = [];
    // One report per (kind, line): a loop that reads the same stale handle a
    // thousand times is one bug, not a thousand, and a wall of text hides the
    // second finding that matters.
    this.reported = new Set();
    this.counts = { allocs: 0, frees: 0, writes: 0, reads: 0 };
  }

  /** @param {{cleared?: boolean, line?: number}} info - calloc passes cleared. */
  onAlloc(offset, size, info = {}) {
    const generation = (this.generations.get(offset) || 0) + 1;
    this.generations.set(offset, generation);
    this.blocks.set(offset, new Block(offset, size, generation, info));
    this.counts.allocs += 1;
    return generation;
  }

  /**
   * Returns 'ok', 'double' or 'foreign'. The interpreter refuses the release in
   * the last two cases regardless of this result: putting a range in the free
   * list twice is what turns a reported bug into an aliased allocation.
   */
  onFree(offset, node = null) {
    this.counts.frees += 1;
    const block = this.blocks.get(offset);
    if (!block) {
      const known = this.generations.has(offset);
      this.report(known ? 'double-free' : 'invalid-free', node, known
        ? `offset ${offset} was already released`
        : `offset ${offset} was never handed out by malloc`);
      return known ? 'double' : 'foreign';
    }
    this.blocks.delete(offset);
    return 'ok';
  }

  /** The block a handle came from, or null when the handle is not an arena pointer. */
  blockOf(handle) {
    if (!handle || handle.__gen === undefined) return null;
    const block = this.blocks.get(handle.base);
    return block && block.generation === handle.__gen ? block : null;
  }

  /** True when a handle's block is gone or has been recycled - a stale handle. */
  isStale(handle) {
    if (!handle || handle.__gen === undefined) return false;
    const generation = this.generations.get(handle.base);
    return generation !== undefined && generation !== handle.__gen;
  }

  /**
   * What an arena offset means right now: a live block's generation, null for
   * an offset that was allocated and then released, undefined for an address
   * this run never allocated. The middle case is what a pointer field read back
   * out of memory can be checked against.
   */
  generationOf(offset) {
    const block = this.blocks.get(offset);
    if (block) return block.generation;
    return this.generations.has(offset) ? null : undefined;
  }

  /** Remember which allocation a pointer field was written with. */
  onFieldWrite(at, handle) {
    this.fieldGen.set(at, handle && typeof handle.__gen === 'number' ? handle.__gen : null);
  }

  /**
   * 'ok', 'released' or 'recycled' for a pointer field read back out of memory.
   * 'released' is the block is gone; 'recycled' is the address is live again but
   * belongs to a later allocation, which is the case a linked list walking a
   * freed node's `next` pointer runs into.
   */
  onFieldRead(at, offset) {
    const current = this.generationOf(offset);
    if (current === null) return 'released';
    const stored = this.fieldGen.get(at);
    if (stored !== undefined && stored !== null && typeof current === 'number' && current !== stored) return 'recycled';
    return 'ok';
  }

  /** Called for every arena access. Reports staleness; never blocks the access. */
  onAccess(handle, at, size, mode, node = null) {
    if (mode === 'read') this.counts.reads += 1;
    if (this.isStale(handle)) {
      this.report('use-after-free', node, `${mode === 'write' ? 'write' : 'read'} at offset ${at}, ${at - (handle.base || 0)} byte(s) into a block that was released`);
      return;
    }
    if (mode !== 'read') return;
    const block = this.blockOf(handle);
    if (!block) return;
    const from = at - block.offset;
    const to = Math.min(block.size, from + size);
    for (let i = Math.max(0, from); i < to; i += 1) {
      if (block.written[i]) return;
    }
    this.report('uninitialized-read', node, `${mode} of ${size} byte(s) at offset ${at}, which no assignment in the program ever wrote`);
  }

  onWrite(handle, at, size) {
    this.counts.writes += 1;
    const block = this.blockOf(handle);
    if (!block) return;
    const from = at - block.offset;
    for (let i = Math.max(0, from); i < Math.min(block.size, from + size); i += 1) block.written[i] = 1;
  }

  /** memset, memcpy and realloc copy bytes without going through a write access. */
  markWritten(offset, at, size) {
    const block = this.blocks.get(offset);
    if (!block) return;
    const from = at - block.offset;
    for (let i = Math.max(0, from); i < Math.min(block.size, from + size); i += 1) block.written[i] = 1;
  }

  /**
   * Blocks still live at the end of main, one finding each with the allocation
   * line. The interpreter's own counter is the authority on how many there
   * were; this reports where they came from, which is the part a leak check is
   * actually for.
   */
  onFinish() {
    for (const block of this.blocks.values()) {
      this.report('memory-leak', { line: block.line, col: 1 }, `${block.size} byte(s) allocated here were never released`);
    }
    return this;
  }

  report(kind, node, detail) {
    const line = Number.isInteger(node && node.line) ? node.line : 1;
    const key = `${kind}:${line}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.findings.push(makeFinding(kind, { line, col: (node && node.col) || 1, detail }));
  }

  /** The findings in source order, so a transcript reads like the program. */
  list() {
    return [...this.findings].sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  }
}
