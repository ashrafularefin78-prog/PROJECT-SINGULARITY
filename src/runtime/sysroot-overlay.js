/**
 * Files installed on top of the vendored WASI sysroot after unpacking.
 *
 * The sysroot tarball is a pinned, hash-checked toolchain asset, so a missing
 * header is added here instead of repacking the archive: the compiler bytes
 * stay verifiable and the overlay is reviewable source. <stdatomic.h> is the
 * only overlay today.
 *
 * The bundled Clang 8.0.1 WebAssembly backend has no atomics feature:
 * `_Atomic` types and the GNU `__sync_*` / `__atomic_*` / `__c11_atomic_*`
 * builtins reach instruction selection and abort with "Cannot select". The
 * runtime also has no threads, no shared memory and no signal handlers, so no
 * second agent can observe an operation halfway through. The overlay therefore
 * exposes the C11 atomic API as volatile reads and writes, each of which is
 * trivially indivisible and sequentially consistent in this sandbox.
 *
 * This is a single-threaded compatibility layer, not a lock-free
 * implementation for a threaded target. A program moved to a runtime with
 * threads must not rely on these typedefs for atomicity; the sandbox still
 * refuses to create threads, and C++ <atomic> and raw _Atomic types are
 * refused with a named diagnostic instead of an LLVM crash.
 */
export const SYSROOT_OVERLAY = {
  'include/stdatomic.h': String.raw`/*
 * <stdatomic.h> for the single-threaded WASI sandbox.
 *
 * Every atomic type is a volatile scalar and every operation is an ordinary
 * volatile access. With one thread, no shared memory and no signal handlers,
 * that is trivially sequentially consistent; the memory-order arguments are
 * accepted and ignored. This is not a lock-free implementation for a threaded
 * target: code moved off this runtime must not rely on these typedefs for
 * atomicity. _Atomic types, the GNU __sync_/__atomic_ builtins, Clang's
 * __c11_atomic_ builtins and C++ <atomic> are not supported by the bundled
 * backend.
 */
#ifndef _STDATOMIC_H
#define _STDATOMIC_H

#include <stddef.h>
#include <stdint.h>
#include <uchar.h>

typedef enum {
  memory_order_relaxed = 0,
  memory_order_consume = 1,
  memory_order_acquire = 2,
  memory_order_release = 3,
  memory_order_acq_rel = 4,
  memory_order_seq_cst = 5
} memory_order;

typedef volatile _Bool atomic_bool;
typedef volatile char atomic_char;
typedef volatile signed char atomic_schar;
typedef volatile unsigned char atomic_uchar;
typedef volatile short atomic_short;
typedef volatile unsigned short atomic_ushort;
typedef volatile int atomic_int;
typedef volatile unsigned int atomic_uint;
typedef volatile long atomic_long;
typedef volatile unsigned long atomic_ulong;
typedef volatile long long atomic_llong;
typedef volatile unsigned long long atomic_ullong;
typedef volatile char16_t atomic_char16_t;
typedef volatile char32_t atomic_char32_t;
typedef volatile wchar_t atomic_wchar_t;
typedef volatile intptr_t atomic_intptr_t;
typedef volatile uintptr_t atomic_uintptr_t;
typedef volatile size_t atomic_size_t;
typedef volatile ptrdiff_t atomic_ptrdiff_t;
typedef volatile intmax_t atomic_intmax_t;
typedef volatile uintmax_t atomic_uintmax_t;
typedef volatile int_least8_t atomic_int_least8_t;
typedef volatile uint_least8_t atomic_uint_least8_t;
typedef volatile int_least16_t atomic_int_least16_t;
typedef volatile uint_least16_t atomic_uint_least16_t;
typedef volatile int_least32_t atomic_int_least32_t;
typedef volatile uint_least32_t atomic_uint_least32_t;
typedef volatile int_least64_t atomic_int_least64_t;
typedef volatile uint_least64_t atomic_uint_least64_t;
typedef volatile int_fast8_t atomic_int_fast8_t;
typedef volatile uint_fast8_t atomic_uint_fast8_t;
typedef volatile int_fast16_t atomic_int_fast16_t;
typedef volatile uint_fast16_t atomic_uint_fast16_t;
typedef volatile int_fast32_t atomic_int_fast32_t;
typedef volatile uint_fast32_t atomic_uint_fast32_t;
typedef volatile int_fast64_t atomic_int_fast64_t;
typedef volatile uint_fast64_t atomic_uint_fast64_t;

typedef volatile int atomic_flag;

#define ATOMIC_FLAG_INIT 0
#define ATOMIC_VAR_INIT(value) (value)
#define ATOMIC_BOOL_LOCK_FREE 2
#define ATOMIC_CHAR_LOCK_FREE 2
#define ATOMIC_CHAR16_T_LOCK_FREE 2
#define ATOMIC_CHAR32_T_LOCK_FREE 2
#define ATOMIC_WCHAR_T_LOCK_FREE 2
#define ATOMIC_SHORT_LOCK_FREE 2
#define ATOMIC_INT_LOCK_FREE 2
#define ATOMIC_LONG_LOCK_FREE 2
#define ATOMIC_LLONG_LOCK_FREE 2
#define ATOMIC_POINTER_LOCK_FREE 2

#define atomic_init(object, value) \
  __extension__ ({ __typeof__(object) __p = (object); *__p = (value); (void)0; })
#define atomic_store_explicit(object, desired, order) \
  __extension__ ({ __typeof__(object) __p = (object); *__p = (desired); (void)0; })
#define atomic_store(object, desired) \
  atomic_store_explicit((object), (desired), memory_order_seq_cst)
#define atomic_load_explicit(object, order) \
  __extension__ ({ __typeof__(object) __p = (object); *__p; })
#define atomic_load(object) \
  atomic_load_explicit((object), memory_order_seq_cst)
#define atomic_is_lock_free(object) ((void)(object), (_Bool)1)
#define atomic_exchange_explicit(object, desired, order) \
  __extension__ ({ __typeof__(object) __p = (object); __typeof__(*__p + 0) __old = *__p; *__p = (desired); __old; })
#define atomic_exchange(object, desired) \
  atomic_exchange_explicit((object), (desired), memory_order_seq_cst)
#define atomic_compare_exchange_strong_explicit(object, expected, desired, success, failure) \
  __extension__ ({ \
    __typeof__(object) __p = (object); \
    __typeof__(expected) __e = (expected); \
    __typeof__(*__p + 0) __old = *__p; \
    _Bool __ok = __old == *__e; \
    if (__ok) *__p = (desired); else *__e = __old; \
    __ok; \
  })
#define atomic_compare_exchange_strong(object, expected, desired) \
  atomic_compare_exchange_strong_explicit((object), (expected), (desired), memory_order_seq_cst, memory_order_seq_cst)
#define atomic_compare_exchange_weak_explicit(object, expected, desired, success, failure) \
  atomic_compare_exchange_strong_explicit((object), (expected), (desired), (success), (failure))
#define atomic_compare_exchange_weak(object, expected, desired) \
  atomic_compare_exchange_strong((object), (expected), (desired))
#define atomic_fetch_add_explicit(object, operand, order) \
  __extension__ ({ __typeof__(object) __p = (object); __typeof__(*__p + 0) __old = *__p; *__p = __old + (operand); __old; })
#define atomic_fetch_add(object, operand) \
  atomic_fetch_add_explicit((object), (operand), memory_order_seq_cst)
#define atomic_fetch_sub_explicit(object, operand, order) \
  __extension__ ({ __typeof__(object) __p = (object); __typeof__(*__p + 0) __old = *__p; *__p = __old - (operand); __old; })
#define atomic_fetch_sub(object, operand) \
  atomic_fetch_sub_explicit((object), (operand), memory_order_seq_cst)
#define atomic_fetch_or_explicit(object, operand, order) \
  __extension__ ({ __typeof__(object) __p = (object); __typeof__(*__p + 0) __old = *__p; *__p = __old | (operand); __old; })
#define atomic_fetch_or(object, operand) \
  atomic_fetch_or_explicit((object), (operand), memory_order_seq_cst)
#define atomic_fetch_xor_explicit(object, operand, order) \
  __extension__ ({ __typeof__(object) __p = (object); __typeof__(*__p + 0) __old = *__p; *__p = __old ^ (operand); __old; })
#define atomic_fetch_xor(object, operand) \
  atomic_fetch_xor_explicit((object), (operand), memory_order_seq_cst)
#define atomic_fetch_and_explicit(object, operand, order) \
  __extension__ ({ __typeof__(object) __p = (object); __typeof__(*__p + 0) __old = *__p; *__p = __old & (operand); __old; })
#define atomic_fetch_and(object, operand) \
  atomic_fetch_and_explicit((object), (operand), memory_order_seq_cst)

static inline _Bool atomic_flag_test_and_set_explicit(atomic_flag *flag, memory_order order) {
  _Bool was_set = *flag != 0;
  *flag = 1;
  (void)order;
  return was_set;
}
static inline _Bool atomic_flag_test_and_set(atomic_flag *flag) {
  return atomic_flag_test_and_set_explicit(flag, memory_order_seq_cst);
}
static inline void atomic_flag_clear_explicit(atomic_flag *flag, memory_order order) {
  *flag = 0;
  (void)order;
}
static inline void atomic_flag_clear(atomic_flag *flag) {
  atomic_flag_clear_explicit(flag, memory_order_seq_cst);
}
static inline void atomic_thread_fence(memory_order order) { (void)order; }
static inline void atomic_signal_fence(memory_order order) { (void)order; }
#define kill_dependency(value) (value)

#endif
`,
};

export function installSysrootOverlay(fs) {
  for (const [path, text] of Object.entries(SYSROOT_OVERLAY)) fs.addFile(path, text);
}

const ATOMIC_CONSTRUCTS = [
  { pattern: /\b_Atomic\b/, what: 'the _Atomic type specifier' },
  { pattern: /\b__c11_atomic_[A-Za-z0-9_]+/, what: 'Clang __c11_atomic_* builtins' },
  { pattern: /\b__sync_[A-Za-z0-9_]+/, what: 'GNU __sync_* atomic builtins' },
  { pattern: /\b__atomic_[A-Za-z0-9_]+/, what: 'GNU __atomic_* builtins' },
  { pattern: /\bstd\s*::\s*atomic\b/, what: 'C++ std::atomic' },
];

/* Blank comments and string/char literals, preserving every offset so the
 * reported line and column still point at the original source. */
function maskLiterals(text) {
  let out = '';
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') { out += ' '; i += 1; }
    } else if (c === '/' && text[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < text.length) { out += '  '; i += 2; }
    } else if (c === '"' || c === "'") {
      const quote = c;
      out += ' ';
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') {
          out += '  ';
          i += 2;
        } else if (text[i] === quote) {
          out += ' ';
          i += 1;
          break;
        } else {
          out += text[i] === '\n' ? '\n' : ' ';
          i += 1;
        }
      }
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function positionOf(text, index) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') { line += 1; col = 1; } else col += 1;
  }
  return { line, col };
}

/**
 * Turn an LLVM "Cannot select" abort into an actionable diagnostic when the
 * program uses a construct the WebAssembly backend cannot code-generate.
 * Returns null for every other compiler failure, so ordinary positions are
 * preserved untouched.
 */
export function explainBackendFailure(diagnostics, files) {
  if (!/Cannot select|error in backend/.test(diagnostics)) return null;
  for (const [file, source] of Object.entries(files)) {
    const masked = maskLiterals(source);
    for (const { pattern, what } of ATOMIC_CONSTRUCTS) {
      const match = pattern.exec(masked);
      if (!match) continue;
      const { line, col } = positionOf(masked, match.index);
      return {
        stage: 'Compile',
        message: `${what} cannot be code-generated by the bundled Clang 8.0.1 WASI backend (it has no atomics feature); include <stdatomic.h> and use atomic_int / atomic_load / atomic_fetch_add for single-threaded C11 atomics, or remove the construct`,
        line,
        col,
        file,
      };
    }
  }
  return {
    stage: 'Compile',
    message: 'the bundled Clang 8.0.1 WASI backend could not generate code for this program; it supports C11/C++17 with the documented limits, and this construct is outside them',
    line: 1,
    col: 1,
  };
}
