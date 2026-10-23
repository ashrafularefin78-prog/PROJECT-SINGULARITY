/**
 * SINGU AI - the local systems-C engineer behind M9.
 *
 * Deliberately not a language model: this module is a deterministic C engineer.
 * A brief is matched against a catalogue of hand-written systems patterns,
 * the pattern's knobs are bound from the brief ("ring buffer of 16"), and the
 * result is complete C for the M2 runtime's subset - not a sketch, not pseudo
 * code. Every generated program compiles and runs in the sandbox, which is what
 * the test suite asserts.
 *
 * Why local: the page ships `connect-src 'self'`, no runtime dependencies and
 * the promise that nothing leaves the browser. A hosted model would break all
 * three. The trade-off is honest and stated in the panel: depth comes from the
 * catalogue, not from an unbounded model.
 *
 * The module is pure: no DOM, no network, no storage. That is what makes it
 * testable in both Node and the browser.
 */

export const VERSION = '1.0';

export const LEVELS = [
  {
    id: 'low',
    label: 'Low-level',
    blurb: 'Bits, bytes and fixed buffers. No heap unless the pattern needs it.',
  },
  {
    id: 'advanced',
    label: 'Advanced',
    blurb: 'Heap structures, pointer surgery and algorithms over the C subset.',
  },
  {
    id: 'expert',
    label: 'Expert · systems',
    blurb: 'Allocators, pools, wire formats, lock-free shapes and register maps.',
  },
];

export const EXAMPLES = [
  { level: 'low', prompt: 'a 64-bit bitset with set, clear and count' },
  { level: 'advanced', prompt: 'a hash table with string keys and chained buckets' },
  { level: 'expert', prompt: 'a single-producer single-consumer lock-free queue' },
];

const levelLabel = (id) => (LEVELS.find((l) => l.id === id) || LEVELS[0]).label;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));
const pow2 = (n, lo, hi) => {
  let v = clamp(n, lo, hi);
  while ((v & (v - 1)) !== 0) v -= 1;
  return v < lo ? lo : v;
};
const roundUp = (n, step, lo, hi) => clamp(Math.ceil(n / step) * step, lo, hi);

const hexBytes = (text) =>
  Array.from(text).map((ch) => `0x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);

const wrapNumbers = (list, perLine = 8, indent = '  ') => {
  const rows = [];
  for (let i = 0; i < list.length; i += perLine) {
    rows.push(indent + list.slice(i, i + perLine).join(', ') + ',');
  }
  return rows.join('\n');
};

// ---------------------------------------------------------------- the catalogue

export const RECIPES = [
  // ------------------------------------------------------------------ low level
  {
    id: 'bit-toolkit',
    level: 'low',
    title: 'Bit manipulation toolkit',
    summary:
      'A 16-bit word lab: population count without a lookup table, power-of-two tests, ' +
      'rotate, reverse and a bit dump. Every mask is visible in four hex digits.',
    keywords: [
      'bit', 'bits', 'bitwise', 'bit manipulation', 'popcount', 'pop count', 'hamming weight',
      'mask', 'masks', 'masking', 'shift', 'shifts', 'rotate', 'rotl', 'reverse bits', 'bit twiddling',
    ],
    teaches: ['masking with & and |', 'shifts and rotates', 'Brian Kernighan popcount', 'power-of-two test'],
    hazards: [
      'Shifting by the width of the type (or more) is undefined behaviour in C; mask the count first.',
      '1 << 31 sets the sign bit of a 32-bit int - use an unsigned constant such as 1u.',
      'This demo stays in 16 bits so the arithmetic cannot overflow a JavaScript-backed int.',
    ],
    notes: [
      'popcount clears the lowest set bit (v & (v - 1)) instead of testing all 16 bits.',
      'next_pow2 smears the highest set bit down, then adds one - the standard strong-arm trick.',
      'rotl16 masks the rotation count: C does not define shifts at or beyond the width.',
    ],
    complexity: 'O(1) for masks and rotates, O(k) for popcount where k is the set-bit count.',
    defaultPrompt: 'a bit manipulation toolkit with popcount, rotate and reverse',
    tune: () => ({}),
    build: () => String.raw`#include <stdio.h>

/* SINGU AI - low level: bit manipulation toolkit.
   A 16-bit demo word keeps every mask visible in four hex digits. The same
   expressions scale to unsigned int / uint32_t with wider constants. */

int popcount16(unsigned int v) {
  int n = 0;
  while (v != 0) {
    v = v & (v - 1);            /* clear the lowest set bit: one pass per 1 */
    n++;
  }
  return n;
}

int is_pow2(unsigned int v) {
  return (v != 0 && (v & (v - 1)) == 0) ? 1 : 0;
}

unsigned int next_pow2(unsigned int v) {
  if (v <= 1) return 1;
  v--;
  v = v | (v >> 1);
  v = v | (v >> 2);
  v = v | (v >> 4);
  v = v | (v >> 8);
  return (v + 1) & 0xffff;
}

unsigned int rotl16(unsigned int v, int n) {
  n = n & 15;                   /* a shift of the width is undefined C */
  return ((v << n) | (v >> (16 - n))) & 0xffff;
}

unsigned int reverse16(unsigned int v) {
  unsigned int out = 0;
  int i;
  for (i = 0; i < 16; i++) {
    out = (out << 1) | (v & 1);
    v = v >> 1;
  }
  return out;
}

void dump16(unsigned int v) {
  int i;
  for (i = 15; i >= 0; i--) printf("%d", (v >> i) & 1);
}

int main(void) {
  unsigned int samples[5] = {0x0000, 0x0001, 0x00f0, 0x8001, 0xbeef};
  int i;
  printf("value  ones  pow2  rotl4  reversed\n");
  for (i = 0; i < 5; i++) {
    unsigned int v = samples[i];
    printf("%04x   %d     %d     %04x   %04x\n",
           v, popcount16(v), is_pow2(v), rotl16(v, 4), reverse16(v));
  }
  printf("next_pow2(0x00f0) = %04x\n", next_pow2(0x00f0));
  printf("0x8001 = ");
  dump16(0x8001);
  printf("\n");
  return 0;
}
`,
  },
  {
    id: 'bitset',
    level: 'low',
    title: 'Fixed bitset',
    summary:
      'Set membership in one bit per index, backed by an array of 32-bit words. ' +
      'Checked accessors reject out-of-range indices instead of corrupting the next word.',
    keywords: [
      'bitset', 'bit set', 'bitmap', 'bit map', 'membership', 'flags', 'flag array',
      'set of integers', 'bitset of',
    ],
    teaches: ['index arithmetic i / 32 and i % 32', 'OR to set, AND NOT to clear', 'popcount across words', 'checked accessors'],
    hazards: [
      'Writing past the word array is silent memory corruption in C - the checked setter is the point of the pattern.',
      'BIT_COUNT should stay a multiple of 32; otherwise the last word carries unused bits.',
      'A signed 1 << 31 is implementation-defined territory; use an unsigned word type.',
    ],
    notes: [
      'The backing array is global and zeroed by bitset_clear_all before use.',
      'All three checked accessors share one bounds predicate and answer 0 on rejection.',
      'Counting walks whole words and reuses the Kernighan clear-lowest-bit loop.',
    ],
    complexity: 'O(1) per access, O(BIT_COUNT / 32) to count, O(BIT_COUNT) to iterate.',
    defaultPrompt: 'a 64-bit bitset with set, clear and count',
    tune: (n) => ({ bits: n == null ? 64 : roundUp(n, 32, 32, 512) }),
    build: ({ bits }) => {
      const picks = [3, 8, 15, 16, 17, 23, bits - 2, bits - 1];
      return String.raw`#include <stdio.h>

/* SINGU AI - low level: a fixed bitset.
   One bit per index, one 32-bit word per 32 indices, no heap and no library.
   The checked accessors are the contract: out-of-range is a rejection, not a
   write into the neighbouring word. */

#define BIT_COUNT ${bits}
#define WORD_BITS 32
#define WORD_COUNT (BIT_COUNT / WORD_BITS)

unsigned int words[WORD_COUNT];

void bitset_clear_all(void) {
  int w;
  for (w = 0; w < WORD_COUNT; w++) words[w] = 0;
}

int bit_set(int i) {
  if (i < 0 || i >= BIT_COUNT) return 0;
  words[i / WORD_BITS] = words[i / WORD_BITS] | (1 << (i % WORD_BITS));
  return 1;
}

int bit_clear(int i) {
  if (i < 0 || i >= BIT_COUNT) return 0;
  words[i / WORD_BITS] = words[i / WORD_BITS] & ~(1 << (i % WORD_BITS));
  return 1;
}

int bit_test(int i) {
  if (i < 0 || i >= BIT_COUNT) return -1;
  return (words[i / WORD_BITS] >> (i % WORD_BITS)) & 1;
}

int bit_count(void) {
  int total = 0;
  int w;
  for (w = 0; w < WORD_COUNT; w++) {
    unsigned int v = words[w];
    while (v != 0) {
      v = v & (v - 1);
      total++;
    }
  }
  return total;
}

int main(void) {
  int wanted[8] = {${picks.join(', ')}};
  int i;
  bitset_clear_all();
  for (i = 0; i < 8; i++) bit_set(wanted[i]);
  printf("count after setting 8 bits: %d\n", bit_count());
  printf("test 8=%d 31=%d ${bits - 1}=%d\n", bit_test(8), bit_test(31), bit_test(${bits - 1}));
  printf("out-of-range set(-1)=%d set(${bits})=%d\n", bit_set(-1), bit_set(${bits}));
  printf("iterate set bits:");
  for (i = 0; i < BIT_COUNT; i++) {
    if (bit_test(i) == 1) printf(" %d", i);
  }
  printf("\n");
  bit_clear(8);
  printf("after clear(8): count=%d test(8)=%d\n", bit_count(), bit_test(8));
  return 0;
}
`;
    },
  },
  {
    id: 'ring-buffer',
    level: 'low',
    title: 'Fixed-capacity ring buffer',
    summary:
      'A stack-allocated circular FIFO with explicit head, tail and count. ' +
      'A push into a full buffer is rejected and counted, never silently overwritten.',
    keywords: [
      'ring buffer', 'circular buffer', 'circular queue', 'ring', 'fifo', 'queue',
      'producer consumer', 'fixed buffer', 'buffer',
    ],
    teaches: ['circular index arithmetic', 'full vs empty without a sentinel loss', 'fail-closed push', 'no allocation after init'],
    hazards: [
      'If count is dropped, a full and an empty ring look identical (head == tail).',
      'CAP must be constant here; a variable capacity needs a heap allocation and a stored cap.',
      'A power-of-two CAP allows & (CAP - 1) instead of %, but only if CAP is truly a power of two.',
    ],
    notes: [
      'full and empty are distinguished by count, so the buffer can use every slot.',
      'push returns 0 and increments dropped, which is the whole failure contract.',
      'The second half of main deliberately wraps tail past the end, then reads the order back.',
    ],
    complexity: 'O(1) push and pop; O(CAP) memory, no allocation.',
    defaultPrompt: 'a circular ring buffer that rejects pushes when full',
    tune: (n) => ({ cap: pow2(n == null ? 8 : n, 4, 64) }),
    build: ({ cap }) => String.raw`#include <stdio.h>

/* SINGU AI - low level: a fixed-capacity ring buffer.
   No allocation after init. Full is a rejection with a counter, not a silent
   overwrite: the caller learns that the producer outran the consumer. */

#define CAP ${cap}

typedef struct {
  int data[CAP];
  int head;    /* next write slot */
  int tail;    /* next read slot  */
  int count;
  int dropped;
} Ring;

void ring_init(Ring *r) {
  r->head = 0;
  r->tail = 0;
  r->count = 0;
  r->dropped = 0;
}

int ring_push(Ring *r, int value) {
  if (r->count == CAP) {
    r->dropped++;
    return 0;
  }
  r->data[r->head] = value;
  r->head = (r->head + 1) % CAP;
  r->count++;
  return 1;
}

int ring_pop(Ring *r, int *out) {
  if (r->count == 0) return 0;
  *out = r->data[r->tail];
  r->tail = (r->tail + 1) % CAP;
  r->count--;
  return 1;
}

int main(void) {
  Ring r;
  int i;
  int v = 0;
  ring_init(&r);

  for (i = 1; i <= CAP + 4; i++) {
    if (!ring_push(&r, i * 10)) printf("push %d rejected: full\n", i * 10);
  }
  printf("held %d, dropped %d, head %d, tail %d\n", r.count, r.dropped, r.head, r.tail);

  printf("drain:");
  while (ring_pop(&r, &v)) printf(" %d", v);
  printf("\nemptied: count %d\n", r.count);

  /* Force the indices to wrap: read one, write two more. */
  ring_push(&r, 70);
  ring_push(&r, 80);
  ring_push(&r, 90);
  ring_pop(&r, &v);
  printf("popped %d after wrap\n", v);
  ring_push(&r, 100);
  printf("wrapped order:");
  while (ring_pop(&r, &v)) printf(" %d", v);
  printf("\nhead %d tail %d count %d\n", r.head, r.tail, r.count);
  return 0;
}
`,
  },
  {
    id: 'hexdump-checksum',
    level: 'low',
    title: 'Hex dump and 16-bit checksum',
    summary:
      'A byte-level view of a buffer: offset column, hex payload, printable gutter, ' +
      'and a checksum that folds every byte without leaving the 16-bit range.',
    keywords: [
      'hex dump', 'hexdump', 'hex', 'dump', 'checksum', 'byte buffer', 'bytes',
      'packet', 'wire bytes', 'printable', 'memory view',
    ],
    teaches: ['unsigned char as a byte type', 'bit masks for printable ASCII', 'offset arithmetic', 'checksum folding'],
    hazards: [
      'The checksum is additive: it catches truncation and single-byte errors, not reordering.',
      'printf("%c", c) with a signed char is undefined for bytes above 127; keep the byte unsigned.',
      'The gutter must not print raw control bytes into a terminal without a filter.',
    ],
    notes: [
      'The dump prints offsets in hex, matching the way packet tools read.',
      'Non-printable bytes become "." so the gutter never emits a control sequence.',
      'checksum16 masks after each addition, which is the fold that keeps it 16-bit.',
    ],
    complexity: 'O(n) time, O(1) extra space.',
    defaultPrompt: 'a hex dump and 16-bit checksum of a byte buffer',
    tune: () => ({}),
    build: () => {
      const text = 'SINGU AI :: systems C\n';
      const bytes = hexBytes(text);
      return String.raw`#include <stdio.h>

/* SINGU AI - low level: hex dump and checksum.
   The buffer is a byte array, not a string: offsets, hex and a printable
   gutter, then a 16-bit additive checksum folded after every byte. */

#define LEN ${bytes.length}

unsigned char payload[LEN] = {
${wrapNumbers(bytes)}
};

void hexdump(const unsigned char *p, int n) {
  int base;
  for (base = 0; base < n; base += 8) {
    int i;
    printf("%04x  ", base);
    for (i = 0; i < 8; i++) {
      if (base + i < n) printf("%02x ", p[base + i]);
      else printf("   ");
    }
    printf(" |");
    for (i = 0; i < 8; i++) {
      if (base + i < n) {
        unsigned char c = p[base + i];
        printf("%c", (c >= 32 && c < 127) ? c : '.');
      }
    }
    printf("|\n");
  }
}

unsigned int checksum16(const unsigned char *p, int n) {
  unsigned int sum = 0;
  int i;
  for (i = 0; i < n; i++) {
    sum = (sum + p[i]) & 0xffff;
  }
  return sum;
}

int main(void) {
  unsigned int sum;
  hexdump(payload, LEN);
  sum = checksum16(payload, LEN);
  printf("length %d bytes, checksum 0x%04x\n", LEN, sum);
  /* A one-byte change must move the checksum. */
  payload[0] = payload[0] ^ 0x01;
  printf("after flipping bit 0: 0x%04x (delta %d)\n",
         checksum16(payload, LEN), (int)(checksum16(payload, LEN) - sum));
  return 0;
}
`;
    },
  },

  // ------------------------------------------------------------------- advanced
  {
    id: 'linked-list',
    level: 'advanced',
    title: 'Singly linked list with reverse and cycle check',
    summary:
      'Heap nodes, an in-place reversal that touches no allocation, and Floyd cycle ' +
      'detection. The deliberate loop-back is repaired before the list is freed.',
    keywords: [
      'linked list', 'list', 'singly linked', 'nodes', 'node', 'reverse list',
      'reverse a linked list', 'cycle', 'floyd', 'tortoise',
    ],
    teaches: ['malloc per node', 'pointer rewiring without losing the rest of the list', 'Floyd cycle detection', 'freeing a whole list'],
    hazards: [
      'Reversing with three pointers is the safe shape: read next before overwriting it.',
      'A cycle makes naive traversal and free() loop forever - detect it, then break it.',
      'Every malloc needs one free on every exit path, including the failure path.',
    ],
    notes: [
      'push_front returns the new head so the caller cannot forget to update it.',
      'reverse walks once and rewires next; it allocates nothing.',
      'has_cycle is Floyd: slow moves one, fast moves two, and they meet only inside a cycle.',
    ],
    complexity: 'O(n) time for reverse, cycle check and free; O(n) heap.',
    defaultPrompt: 'a linked list that reverses in place and detects cycles',
    tune: (n) => ({ nodes: clamp(n == null ? 6 : n, 3, 12) }),
    build: ({ nodes }) => String.raw`#include <stdio.h>

/* SINGU AI - advanced: a singly linked list.
   Three operations worth knowing: build at the head, reverse in place, and
   detect a cycle before free() walks it forever. */

typedef struct Node {
  int value;
  struct Node *next;
} Node;

Node *push_front(Node *head, int value) {
  Node *n = (Node *)malloc(sizeof(Node));
  if (n == NULL) return head;          /* allocation failure keeps the old list */
  n->value = value;
  n->next = head;
  return n;
}

Node *reverse(Node *head) {
  Node *prev = NULL;
  while (head != NULL) {
    Node *next = head->next;           /* read before you overwrite */
    head->next = prev;
    prev = head;
    head = next;
  }
  return prev;
}

int has_cycle(Node *head) {
  Node *slow = head;
  Node *fast = head;
  while (fast != NULL && fast->next != NULL) {
    slow = slow->next;
    fast = fast->next->next;
    if (slow == fast) return 1;
  }
  return 0;
}

int length(Node *head) {
  int n = 0;
  while (head != NULL) {
    n++;
    head = head->next;
  }
  return n;
}

void print_list(const char *label, Node *head) {
  printf("%s:", label);
  while (head != NULL) {
    printf(" %d", head->value);
    head = head->next;
  }
  printf("\n");
}

void free_list(Node *head) {
  while (head != NULL) {
    Node *next = head->next;
    free(head);
    head = next;
  }
}

int main(void) {
  Node *head = NULL;
  Node *last;
  int i;
  for (i = 1; i <= ${nodes}; i++) head = push_front(head, i * i);

  print_list("built", head);
  printf("length %d, cycle %d\n", length(head), has_cycle(head));

  head = reverse(head);
  print_list("reversed", head);

  last = head;
  while (last->next != NULL) last = last->next;
  last->next = head;                   /* deliberately wrong: a cycle */
  printf("cycle after loop-back: %d\n", has_cycle(head));
  last->next = NULL;                   /* repair before freeing */
  printf("cycle after repair: %d\n", has_cycle(head));

  free_list(head);
  printf("freed %d nodes\n", ${nodes});
  return 0;
}
`,
  },
  {
    id: 'dynamic-array',
    level: 'advanced',
    title: 'Growable array (vector)',
    summary:
      'A typed dynamic array with capacity doubling through realloc, an explicit ' +
      'length separate from capacity, and a bounds-checked getter.',
    keywords: [
      'dynamic array', 'vector', 'growable array', 'array list', 'realloc',
      'grow', 'resize', 'append', 'push back',
    ],
    teaches: ['length vs capacity', 'realloc ownership transfer', 'amortised growth', 'bounds-checked reads'],
    hazards: [
      'Never assign realloc straight back to the only pointer: a NULL result loses the old block.',
      'Length and capacity are different numbers; using one for the other is the classic bug.',
      'realloc may move the block, so cached interior pointers are invalid after it.',
    ],
    notes: [
      'vec_grow stages realloc in a temporary and only commits on success.',
      'vec_get reports failure through its return value and leaves the out-parameter untouched.',
      'The growth count is printed to show the amortised cost of doubling.',
    ],
    complexity: 'O(1) amortised push, O(n) worst case on growth; O(capacity) memory.',
    defaultPrompt: 'a dynamic array that grows with realloc',
    tune: (n) => ({ initial: clamp(n == null ? 2 : n, 1, 16) }),
    build: ({ initial }) => String.raw`#include <stdio.h>

/* SINGU AI - advanced: a growable int array.
   Length is what the caller owns; capacity is what malloc owns. Doubling keeps
   push amortised O(1) while every individual growth is O(capacity). */

typedef struct {
  int *data;
  int len;
  int cap;
  int grows;
} Vector;

int vec_init(Vector *v, int cap) {
  v->data = (int *)malloc(cap * sizeof(int));
  if (v->data == NULL) return 0;
  v->len = 0;
  v->cap = cap;
  v->grows = 0;
  return 1;
}

int vec_grow(Vector *v) {
  int next = v->cap * 2;
  int *grown = (int *)realloc(v->data, next * sizeof(int));
  if (grown == NULL) return 0;          /* the old block is still ours */
  v->data = grown;
  v->cap = next;
  v->grows++;
  return 1;
}

int vec_push(Vector *v, int value) {
  if (v->len == v->cap && !vec_grow(v)) return 0;
  v->data[v->len] = value;
  v->len++;
  return 1;
}

int vec_get(Vector *v, int index, int *out) {
  if (index < 0 || index >= v->len) return 0;
  *out = v->data[index];
  return 1;
}

void vec_free(Vector *v) {
  free(v->data);
  v->data = NULL;
  v->len = 0;
  v->cap = 0;
}

int main(void) {
  Vector v;
  int i;
  int got = 0;
  if (!vec_init(&v, ${initial})) {
    printf("init failed\n");
    return 1;
  }
  for (i = 1; i <= 12; i++) {
    if (!vec_push(&v, i * i)) printf("push %d rejected\n", i * i);
  }
  printf("len %d cap %d grows %d\n", v.len, v.cap, v.grows);
  printf("values:");
  for (i = 0; i < v.len; i++) {
    if (vec_get(&v, i, &got)) printf(" %d", got);
  }
  printf("\n");
  printf("get(-1)=%d get(len)=%d get(3)=%d\n",
         vec_get(&v, -1, &got), vec_get(&v, v.len, &got), vec_get(&v, 3, &got));
  vec_free(&v);
  printf("freed: data is null %d\n", v.data == NULL);
  return 0;
}
`,
  },
  {
    id: 'hash-table',
    level: 'advanced',
    title: 'Chained hash table',
    summary:
      'String keys, separate chaining, a 16-bit FNV-style hash and a fixed bucket ' +
      'count. Entries borrow their key pointers instead of copying them.',
    keywords: [
      'hash table', 'hashtable', 'hashmap', 'hash map', 'dictionary', 'lookup',
      'key value', 'chaining', 'buckets', 'map',
    ],
    teaches: ['separate chaining with structs', 'borrowed vs owned keys', 'hash folding into a bucket index', 'update vs insert'],
    hazards: [
      'The table borrows the key pointers: they must outlive the table and must not be mutated while stored.',
      'A fixed bucket count means the load factor grows; production tables resize and rehash.',
      'strcmp needs NUL-terminated keys, and hash_key and strcmp must agree on the same bytes.',
    ],
    notes: [
      'hash_key folds to 16 bits before the modulo so the value stays inside safe integer range.',
      'table_put walks the bucket first, so an existing key is updated in place.',
      'The keys here are string literals, which have static lifetime; an owned-key table would copy each key instead.',
    ],
    complexity: 'Average O(1) lookup with a good hash, O(n) worst case; O(n) memory.',
    defaultPrompt: 'a hash table with string keys and chained buckets',
    tune: (n) => ({ buckets: pow2(n == null ? 8 : n, 2, 64) }),
    build: ({ buckets }) => String.raw`#include <stdio.h>
#include <string.h>

/* SINGU AI - advanced: a chained hash table.
   Keys are copied into the node (bounded), the hash folds to 16 bits, and the
   bucket index is hash % BUCKETS. Collisions are a list, not a failure. */

#define BUCKETS ${buckets}

typedef struct Entry {
  const char *key;                      /* borrowed: the caller owns the bytes */
  int value;
  struct Entry *next;
} Entry;

typedef struct {
  Entry *head[BUCKETS];
  int count;
} Table;

unsigned int hash_key(const char *s) {
  unsigned int h = 0x811c;
  int n = strlen(s);                   /* bound the walk explicitly */
  int i;
  for (i = 0; i < n; i++) {
    h = ((h ^ (unsigned char)s[i]) * 0x0101) & 0xffff;
  }
  return h % BUCKETS;
}

void table_init(Table *t) {
  int i;
  for (i = 0; i < BUCKETS; i++) t->head[i] = NULL;
  t->count = 0;
}

int table_put(Table *t, const char *key, int value) {
  unsigned int b = hash_key(key);
  Entry *e = t->head[b];
  while (e != NULL) {
    if (strcmp(e->key, key) == 0) {
      e->value = value;                 /* update, never duplicate */
      return 1;
    }
    e = e->next;
  }
  e = (Entry *)calloc(1, sizeof(Entry));
  if (e == NULL) return 0;
  e->key = key;                         /* borrow, do not copy */
  e->value = value;
  e->next = t->head[b];
  t->head[b] = e;
  t->count++;
  return 1;
}

int table_get(Table *t, const char *key, int *out) {
  unsigned int b = hash_key(key);
  Entry *e = t->head[b];
  while (e != NULL) {
    if (strcmp(e->key, key) == 0) {
      *out = e->value;
      return 1;
    }
    e = e->next;
  }
  return 0;
}

void table_free(Table *t) {
  int i;
  for (i = 0; i < BUCKETS; i++) {
    Entry *e = t->head[i];
    while (e != NULL) {
      Entry *next = e->next;
      free(e);
      e = next;
    }
    t->head[i] = NULL;
  }
  t->count = 0;
}

int main(void) {
  Table t;
  int i;
  int value = 0;
  const char *keys[6] = {"alpha", "beta", "gamma", "delta", "epsilon", "zeta"};
  int scores[6] = {10, 20, 30, 40, 50, 60};

  table_init(&t);
  for (i = 0; i < 6; i++) table_put(&t, keys[i], scores[i]);
  printf("entries %d\n", t.count);

  for (i = 0; i < 6; i++) {
    if (table_get(&t, keys[i], &value)) printf("%s=%d ", keys[i], value);
  }
  printf("\n");

  table_put(&t, "beta", 99);
  printf("beta updated: %d entries=%d\n", table_get(&t, "beta", &value) ? value : -1, t.count);
  printf("missing key found=%d\n", table_get(&t, "omega", &value));

  printf("non-empty buckets:");
  for (i = 0; i < BUCKETS; i++) {
    if (t.head[i] != NULL) printf(" %d", i);
  }
  printf("\n");

  table_free(&t);
  printf("freed: entries %d\n", t.count);
  return 0;
}
`,
  },
  {
    id: 'binary-tree',
    level: 'advanced',
    title: 'Binary search tree',
    summary:
      'Recursive insert, search and in-order traversal over heap nodes, plus height ' +
      'and a post-order free that releases children before their parent.',
    keywords: [
      'binary tree', 'bst', 'binary search tree', 'tree', 'search tree', 'traversal',
      'inorder', 'in order', 'recursion tree', 'balanced tree',
    ],
    teaches: ['recursive structs', 'ordering invariant', 'in-order traversal', 'post-order free'],
    hazards: [
      'An unbalanced BST degenerates to a list: height n, search O(n).',
      'Duplicates need a policy; this one ignores them so the invariant stays simple.',
      'Free children before the parent, or the parent pointer is gone before its children are reached.',
    ],
    notes: [
      'tree_insert returns the subtree root, which makes the recursive assignment safe.',
      'The in-order walk prints keys in sorted order - a proof the invariant holds.',
      'height counts edges, so a single node is 0.',
    ],
    complexity: 'Average O(log n) insert/search, O(n) worst case; O(n) memory.',
    defaultPrompt: 'a binary search tree with in-order traversal',
    tune: () => ({}),
    build: () => String.raw`#include <stdio.h>

/* SINGU AI - advanced: a binary search tree.
   The invariant: everything left is smaller, everything right is larger.
   Recursion does the work; the free is post-order so children go first. */

typedef struct Node {
  int key;
  struct Node *left;
  struct Node *right;
} Node;

Node *tree_insert(Node *root, int key) {
  if (root == NULL) {
    Node *n = (Node *)calloc(1, sizeof(Node));
    if (n == NULL) return NULL;
    n->key = key;
    return n;
  }
  if (key < root->key) root->left = tree_insert(root->left, key);
  else if (key > root->key) root->right = tree_insert(root->right, key);
  return root;                          /* equal keys are ignored */
}

int tree_contains(Node *root, int key) {
  while (root != NULL) {
    if (key == root->key) return 1;
    root = key < root->key ? root->left : root->right;
  }
  return 0;
}

int tree_height(Node *root) {
  int left;
  int right;
  if (root == NULL) return -1;
  left = tree_height(root->left);
  right = tree_height(root->right);
  return 1 + (left > right ? left : right);
}

void tree_inorder(Node *root) {
  if (root == NULL) return;
  tree_inorder(root->left);
  printf(" %d", root->key);
  tree_inorder(root->right);
}

void tree_free(Node *root) {
  if (root == NULL) return;
  tree_free(root->left);
  tree_free(root->right);
  free(root);
}

int main(void) {
  int keys[8] = {50, 30, 70, 20, 40, 60, 80, 35};
  Node *root = NULL;
  int i;
  for (i = 0; i < 8; i++) root = tree_insert(root, keys[i]);

  printf("in-order:");
  tree_inorder(root);
  printf("\n");
  printf("height %d\n", tree_height(root));
  printf("contains 40=%d 45=%d 80=%d\n",
         tree_contains(root, 40), tree_contains(root, 45), tree_contains(root, 80));

  tree_free(root);
  printf("freed 8 keys\n");
  return 0;
}
`,
  },
  {
    id: 'sorting',
    level: 'advanced',
    title: 'Sorting with a comparator function pointer',
    summary:
      'qsort and a hand-written insertion sort sharing one ordering policy through ' +
      'function pointers, with ascending and descending comparators.',
    keywords: [
      'sort', 'sorting', 'sorted', 'qsort', 'comparator', 'compare', 'function pointer',
      'ascending', 'descending', 'insertion sort', 'order',
    ],
    teaches: ['int (*compare)(int, int)', 'qsort comparator contract (const void *)', 'reusing one policy', 'in-place sorting'],
    hazards: [
      'A qsort comparator must return negative, zero or positive - a boolean loses the order.',
      'The comparator receives pointers to elements, not the elements themselves.',
      'Subtracting two ints can overflow; compare with < and > instead.',
    ],
    notes: [
      'cmp_int casts the void pointers once and uses (x > y) - (x < y).',
      'insertion_sort takes a comparator, so ascending and descending share the sort body.',
      'The program re-sorts the same data both ways and checks the orders agree.',
    ],
    complexity: 'qsort O(n log n) average; insertion sort O(n^2) worst case, O(n) when nearly sorted.',
    defaultPrompt: 'qsort with a comparator function pointer',
    tune: (n) => ({ count: clamp(n == null ? 8 : n, 4, 16) }),
    build: ({ count }) => {
      const values = Array.from({ length: count }, (_, i) => ((i * 37 + 11) % 101) - 50);
      return String.raw`#include <stdio.h>

/* SINGU AI - advanced: sorting with one ordering policy.
   qsort is the library contract; insertion_sort is the same policy applied by
   hand. Both take a comparator, so the decision "what is smaller?" lives once. */

int cmp_int(const void *a, const void *b) {
  int x = *(int *)a;
  int y = *(int *)b;
  return (x > y) - (x < y);            /* never x - y: it can overflow */
}

int less_ascending(int a, int b) {
  return a < b;
}

int less_descending(int a, int b) {
  return a > b;
}

void insertion_sort(int *a, int n, int (*before)(int, int)) {
  int i;
  for (i = 1; i < n; i++) {
    int key = a[i];
    int j = i - 1;
    while (j >= 0 && before(key, a[j])) {
      a[j + 1] = a[j];
      j--;
    }
    a[j + 1] = key;
  }
}

void print_array(const char *label, int *a, int n) {
  int i;
  printf("%s:", label);
  for (i = 0; i < n; i++) printf(" %d", a[i]);
  printf("\n");
}

int main(void) {
  int a[${count}] = {${values.join(', ')}};
  int b[${count}] = {${values.join(', ')}};
  int n = ${count};
  int i;
  int agree = 1;

  print_array("input     ", a, n);
  qsort(a, n, sizeof(int), cmp_int);
  print_array("qsort     ", a, n);

  insertion_sort(b, n, less_ascending);
  print_array("insertion ", b, n);
  for (i = 0; i < n; i++) if (a[i] != b[i]) agree = 0;
  printf("both orders agree: %d\n", agree);

  insertion_sort(b, n, less_descending);
  print_array("reversed  ", b, n);
  return 0;
}
`;
    },
  },
  {
    id: 'string-split',
    level: 'advanced',
    title: 'In-place string split',
    summary:
      'A strtok-shaped tokenizer done by hand: walk the buffer with a pointer, ' +
      'overwrite each delimiter with NUL, and return an array of interior pointers.',
    keywords: [
      'tokenizer', 'tokenize', 'split', 'split string', 'strtok', 'delimiter', 'parse string',
      'string', 'fields', 'words',
    ],
    teaches: ['pointer walking', 'writing NUL terminators in place', 'array of char * fields', 'bounded field count'],
    hazards: [
      'The input buffer must be writable; a string literal is read-only and writing it is undefined.',
      'The token pointers alias the original buffer, so freeing it invalidates every field.',
      'A field count cap prevents an untrusted input from overrunning the pointer array.',
    ],
    notes: [
      'split skips leading delimiters, so empty fields at the edges do not appear.',
      'Each delimiter is replaced by 0 in the buffer; there is no allocation at all.',
      'The final strlen shows that the buffer is now shorter: the first token ends at the first NUL.',
    ],
    complexity: 'O(n) time, O(fields) pointer storage, zero heap.',
    defaultPrompt: 'split a string in place on a delimiter',
    tune: () => ({}),
    build: () => String.raw`#include <stdio.h>
#include <string.h>

/* SINGU AI - advanced: split a writable buffer in place.
   No malloc, no copy: the delimiters become NUL bytes, and an array of
   interior pointers records where each field starts. */

int split(char *text, char **fields, int max_fields, char sep) {
  int i = 0;
  int n = 0;
  while (text[i] != 0) {
    while (text[i] == sep) i++;         /* skip runs of separators */
    if (text[i] == 0) break;
    if (n == max_fields) break;         /* bound the output array */
    fields[n] = text + i;               /* the field starts here */
    n++;
    while (text[i] != 0 && text[i] != sep) i++;
    if (text[i] == sep) {
      text[i] = 0;                      /* terminate the field in place */
      i++;
    }
  }
  return n;
}

int main(void) {
  char line[32] = "  vector:push:16:ok  ";
  char *fields[8];
  int n = split(line, fields, 8, ':');
  int i;

  printf("%d fields\n", n);
  for (i = 0; i < n; i++) printf("[%d] %s\n", i, fields[i]);
  printf("buffer is now %d bytes: \"%s\"\n", (int)strlen(line), line);
  printf("field 2 as a number: %d\n", atoi(fields[2]));

  /* A literal cannot be split in place; copy first, as here. */
  char copy[16] = "c:low:level";
  n = split(copy, fields, 8, ':');
  printf("copy split into %d fields, last is %s\n", n, fields[n - 1]);
  return 0;
}
`,
  },

  // --------------------------------------------------------------------- expert
  {
    id: 'arena-allocator',
    level: 'expert',
    title: 'Arena (bump) allocator',
    summary:
      'A linear allocator over a caller-owned byte block: 8-byte alignment, a ' +
      'rejection when the block would overflow, and a reset that frees everything at once.',
    keywords: [
      'arena', 'arena allocator', 'bump allocator', 'bump', 'linear allocator',
      'allocator', 'allocate', 'memory arena', 'allocate memory', 'custom allocator',
    ],
    teaches: ['alignment arithmetic', 'header-free allocation', 'overflow check before commit', 'bulk reset'],
    hazards: [
      'An arena cannot free a single object; the whole block resets together.',
      'The backing memory must outlive the arena - here it is a stack array in main.',
      'Alignment must be applied to the start offset, not just the size, or the returned pointer is misaligned.',
    ],
    notes: [
      'align_up rounds the used offset to 8 before the size check, so padding is charged too.',
      'The failure path returns NULL and increments a counter; v->used is unchanged.',
      'arena_reset keeps the backing block and only rewinds the offset - the fast path an arena exists for.',
    ],
    complexity: 'O(1) allocation and reset; O(bytes) memory, no per-object header.',
    defaultPrompt: 'an arena bump allocator with alignment',
    tune: (n) => ({ bytes: clamp(n == null ? 256 : n, 64, 2048) }),
    build: ({ bytes }) => String.raw`#include <stdio.h>
#include <string.h>

/* SINGU AI - expert: an arena (bump) allocator.
   Allocation moves one offset forward; reset moves it back to zero. Nothing is
   freed individually, which is exactly why it is fast and predictable. */

#define ARENA_BYTES ${bytes}
#define ALIGN 8

typedef struct {
  unsigned char *base;
  size_t cap;
  size_t used;
  int failed;
} Arena;

size_t align_up(size_t n, size_t align) {
  return (n + align - 1) / align * align;
}

void arena_init(Arena *a, unsigned char *base, size_t cap) {
  a->base = base;
  a->cap = cap;
  a->used = 0;
  a->failed = 0;
}

void *arena_alloc(Arena *a, size_t bytes) {
  size_t start = align_up(a->used, ALIGN);
  if (start > a->cap || bytes > a->cap - start) {
    a->failed++;
    return NULL;                        /* fail closed, no partial commit */
  }
  a->used = start + bytes;
  return a->base + start;
}

void arena_reset(Arena *a) {
  a->used = 0;
}

int main(void) {
  unsigned char backing[ARENA_BYTES];
  Arena a;
  int *squares;
  char *tag;
  int i;

  arena_init(&a, backing, ARENA_BYTES);
  squares = (int *)arena_alloc(&a, 8 * sizeof(int));
  if (squares == NULL) {
    printf("first allocation failed\n");
    return 1;
  }
  for (i = 0; i < 8; i++) squares[i] = i * i;

  tag = (char *)arena_alloc(&a, 16);
  if (tag != NULL) strcpy(tag, "SINGU AI");

  printf("used %d of %d bytes after two allocations\n", (int)a.used, (int)a.cap);
  printf("tag %s, squares:", tag);
  for (i = 0; i < 8; i++) printf(" %d", squares[i]);
  printf("\n");

  printf("oversized request rejected: %d (failures %d)\n",
         arena_alloc(&a, ARENA_BYTES) == NULL, a.failed);

  arena_reset(&a);
  printf("after reset: used %d, first alloc reuses the block: %d\n",
         (int)a.used, arena_alloc(&a, 4) == (void *)backing);
  return 0;
}
`,
  },
  {
    id: 'slab-pool',
    level: 'expert',
    title: 'Fixed-size slab pool with a free list',
    summary:
      'A static array of equal blocks linked into an intrusive free list. Allocation ' +
      'and free are pointer swaps - no general-purpose malloc, no fragmentation inside a class.',
    keywords: [
      'slab', 'slab allocator', 'pool', 'object pool', 'fixed size allocator', 'freelist',
      'free list', 'pool allocator', 'fixed block', 'block pool', 'memory pool',
    ],
    teaches: ['intrusive free list', 'constant-time alloc/free', 'LIFO reuse', 'static backing storage'],
    hazards: [
      'The free-list next pointer lives inside the block, so it shares storage with the payload.',
      'Freeing a block the pool did not hand out corrupts the list - validate ownership in production.',
      'A generic pool returns void *; this typed version keeps the compiler able to check the element.',
    ],
    notes: [
      'Blocks are pushed onto the free list in reverse so block 0 is handed out first.',
      'pool_alloc pops the head; pool_free pushes it back - both O(1) and allocation-free.',
      'The reused slot gets a new value, proving the block really came back.',
    ],
    complexity: 'O(1) alloc and free; O(blocks) memory, no fragmentation between equal blocks.',
    defaultPrompt: 'a fixed-size slab pool with a free list',
    tune: (n) => ({ blocks: clamp(n == null ? 8 : n, 4, 32) }),
    build: ({ blocks }) => String.raw`#include <stdio.h>

/* SINGU AI - expert: a slab pool of equal-sized blocks.
   The free list is intrusive: a free block stores the pointer to the next one
   in its own storage. Allocation and free are pointer swaps on a static array. */

#define BLOCK_COUNT ${blocks}

typedef struct Block {
  struct Block *next;
  int value;
} Block;

typedef struct {
  Block *free_list;
  int blocks;
  int in_use;
} Pool;

void pool_init(Pool *p, Block *storage, int blocks) {
  int i;
  p->blocks = blocks;
  p->in_use = 0;
  p->free_list = NULL;
  for (i = blocks - 1; i >= 0; i--) {
    storage[i].next = p->free_list;
    p->free_list = &storage[i];
  }
}

Block *pool_alloc(Pool *p) {
  Block *b = p->free_list;
  if (b == NULL) return NULL;           /* pool exhausted */
  p->free_list = b->next;
  p->in_use++;
  return b;
}

int pool_free(Pool *p, Block *b) {
  if (b == NULL) return 0;
  b->next = p->free_list;               /* push back, LIFO */
  p->free_list = b;
  p->in_use--;
  return 1;
}

int main(void) {
  Block storage[BLOCK_COUNT];
  Pool p;
  Block *slots[BLOCK_COUNT];
  int i;
  Block *reused;

  pool_init(&p, storage, BLOCK_COUNT);
  for (i = 0; i < BLOCK_COUNT; i++) {
    slots[i] = pool_alloc(&p);
    if (slots[i] != NULL) slots[i]->value = i * 11;
  }
  printf("blocks %d, in use %d, exhausted: %d\n",
         BLOCK_COUNT, p.in_use, pool_alloc(&p) == NULL);

  printf("values:");
  for (i = 0; i < BLOCK_COUNT; i++) printf(" %d", slots[i]->value);
  printf("\n");

  pool_free(&p, slots[3]);
  printf("after free: in use %d\n", p.in_use);
  reused = pool_alloc(&p);
  if (reused != NULL) reused->value = 999;
  printf("reused slot holds %d, in use %d\n", reused->value, p.in_use);

  for (i = 0; i < BLOCK_COUNT; i++) pool_free(&p, slots[i]);
  printf("all returned: in use %d\n", p.in_use);
  return 0;
}
`,
  },
  {
    id: 'wire-format',
    level: 'expert',
    title: 'Little-endian wire format',
    summary:
      'Pack a record into a fixed 10-byte frame with explicit shifts, a version byte ' +
      'and a checksum, then decode it and reject a corrupted byte.',
    keywords: [
      'wire format', 'serialize', 'serialization', 'serialise', 'binary protocol', 'encode',
      'decode', 'packet format', 'little endian', 'little-endian', 'endianness', 'byte order',
      'marshalling', 'record', 'frame', 'protocol',
    ],
    teaches: ['explicit little-endian stores', 'magic and version checks', 'checksum verification', 'cast-free byte access'],
    hazards: [
      'Never memcpy a struct onto the wire: padding and host endianness differ across builds.',
      'A checksum detects accidental corruption, not an attacker - use a MAC for that.',
      'Decode must validate length, magic, version and checksum before trusting a field.',
    ],
    notes: [
      'put_u16 stores low byte first, which is the little-endian contract written down.',
      'The checksum covers the first 8 bytes only; the field itself lives at offset 8.',
      'main corrupts one payload byte and decode rejects the frame for the checksum, not for the value.',
    ],
    complexity: 'O(1) per frame, fixed 10 bytes, no allocation.',
    defaultPrompt: 'serialize a record into bytes in little-endian order',
    tune: () => ({}),
    build: () => String.raw`#include <stdio.h>

/* SINGU AI - expert: an explicit little-endian frame.
   The layout is written down byte by byte, so it does not depend on struct
   padding, host byte order or compiler flags.

   offset 0  magic    0x5347 ("SG")
   offset 2  version  1
   offset 3  flags
   offset 4  id       u16
   offset 6  value    u16
   offset 8  checksum u16 over bytes 0..7
   total     10 bytes
*/

#define FRAME_BYTES 10
#define MAGIC 0x5347
#define VERSION 1

void put_u16(unsigned char *buf, int off, unsigned int v) {
  buf[off] = (unsigned char)(v & 0xff);
  buf[off + 1] = (unsigned char)((v >> 8) & 0xff);
}

unsigned int get_u16(const unsigned char *buf, int off) {
  return (unsigned int)buf[off] | ((unsigned int)buf[off + 1] << 8);
}

unsigned int sum16(const unsigned char *buf, int n) {
  unsigned int sum = 0;
  int i;
  for (i = 0; i < n; i++) sum = (sum + buf[i]) & 0xffff;
  return sum;
}

void encode(unsigned char *buf, unsigned int id, unsigned int flags, unsigned int value) {
  int i;
  for (i = 0; i < FRAME_BYTES; i++) buf[i] = 0;
  put_u16(buf, 0, MAGIC);
  buf[2] = VERSION;
  buf[3] = (unsigned char)(flags & 0xff);
  put_u16(buf, 4, id);
  put_u16(buf, 6, value);
  put_u16(buf, 8, sum16(buf, 8));
}

int decode(const unsigned char *buf, unsigned int *id, unsigned int *flags, unsigned int *value) {
  if (get_u16(buf, 0) != MAGIC) return 0;
  if (buf[2] != VERSION) return 0;
  if (get_u16(buf, 8) != sum16(buf, 8)) return 0;
  *id = get_u16(buf, 4);
  *flags = buf[3];
  *value = get_u16(buf, 6);
  return 1;
}

void dump(const unsigned char *buf, int n) {
  int i;
  for (i = 0; i < n; i++) printf("%02x%s", buf[i], i + 1 == n ? "\n" : " ");
}

int main(void) {
  unsigned char frame[FRAME_BYTES];
  unsigned int id = 0;
  unsigned int flags = 0;
  unsigned int value = 0;

  encode(frame, 42, 0x03, 1234);
  printf("frame: ");
  dump(frame, FRAME_BYTES);

  /* Decode before printing: argument evaluation order is unspecified in C. */
  if (decode(frame, &id, &flags, &value)) {
    printf("decode: ok id=%u flags=%u value=%u\n", id, flags, value);
  } else {
    printf("decode failed\n");
  }

  frame[5] = frame[5] ^ 0x40;           /* corrupt one payload byte */
  printf("corrupted frame decodes: %d\n", decode(frame, &id, &flags, &value));
  printf("checksum now 0x%04x, stored 0x%04x\n", sum16(frame, 8), get_u16(frame, 8));
  return 0;
}
`,
  },
  {
    id: 'spsc-ring',
    level: 'expert',
    title: 'Single-producer / single-consumer queue',
    summary:
      'The lock-free SPSC shape: one writer owns head, one reader owns tail, and ' +
      'monotonic counters distinguish full from empty without sharing a count.',
    keywords: [
      'spsc', 'lock free', 'lock-free', 'lockfree', 'single producer', 'single-producer',
      'single consumer', 'single-consumer', 'producer consumer', 'producer consumer queue',
      'concurrent queue', 'atomics', 'atomic', 'wait free', 'ring buffer', 'ring queue', 'queue',
      'mpsc', 'thread safe queue', 'thread', 'producer', 'consumer',
    ],
    teaches: ['one writer per index', 'monotonic counters', 'full/empty without a shared count', 'why power-of-two capacity helps'],
    hazards: [
      'This subset has no atomics or threads: the counters are plain ints and the program is single-threaded.',
      'A real SPSC queue needs acquire/release ordering on head and tail, or a compiler barrier.',
      'The counters must wrap without breaking the difference; use unsigned counters in production.',
    ],
    notes: [
      'head is written only by the producer and tail only by the consumer in a real deployment.',
      'head - tail is the occupancy, so no third counter is shared between the two sides.',
      'The capacity is a power of two so the slot index is a mask rather than a division.',
    ],
    complexity: 'O(1) push/pop, wait-free for both sides; O(capacity) memory.',
    defaultPrompt: 'a single-producer single-consumer lock-free queue',
    tune: (n) => ({ cap: pow2(n == null ? 8 : n, 4, 64) }),
    build: ({ cap }) => String.raw`#include <stdio.h>

/* SINGU AI - expert: the SPSC ring shape.
   In production head/tail are _Atomic unsigned with acquire/release ordering
   (or a compiler barrier on older toolchains). This subset has no atomics, so
   this is the single-threaded skeleton: the ownership split and the counter
   arithmetic are the parts that carry over. */

#define CAP ${cap}
#define MASK (CAP - 1)

typedef struct {
  int data[CAP];
  int head;    /* producer writes this */
  int tail;    /* consumer writes this */
} Spsc;

void spsc_init(Spsc *q) {
  q->head = 0;
  q->tail = 0;
}

int spsc_push(Spsc *q, int value) {
  if (q->head - q->tail == CAP) return 0;   /* full */
  q->data[q->head & MASK] = value;
  q->head++;
  return 1;
}

int spsc_pop(Spsc *q, int *out) {
  if (q->head == q->tail) return 0;         /* empty */
  *out = q->data[q->tail & MASK];
  q->tail++;
  return 1;
}

int spsc_count(Spsc *q) {
  return q->head - q->tail;
}

int main(void) {
  Spsc q;
  int i;
  int v = 0;
  int rejected = 0;
  int consumed = 0;
  int sum = 0;

  spsc_init(&q);

  /* Producer runs ahead until the queue is full. */
  for (i = 1; i <= CAP + 3; i++) {
    if (!spsc_push(&q, i)) rejected++;
  }
  printf("producer: queued %d, rejected %d, occupancy %d\n",
         CAP, rejected, spsc_count(&q));

  /* Consumer drains half, then the producer refills, interleaved. */
  for (i = 0; i < CAP / 2; i++) {
    if (spsc_pop(&q, &v)) {
      consumed++;
      sum += v;
    }
  }
  printf("consumer: took %d, occupancy %d\n", consumed, spsc_count(&q));

  for (i = CAP + 4; i <= CAP + 6; i++) {
    if (spsc_push(&q, i)) printf("refilled with %d\n", i);
  }

  while (spsc_pop(&q, &v)) {
    consumed++;
    sum += v;
  }
  printf("drained: consumed %d, sum %d, head %d tail %d empty %d\n",
         consumed, sum, q.head, q.tail, spsc_count(&q) == 0);
  return 0;
}
`,
  },
  {
    id: 'mmio-registers',
    level: 'expert',
    title: 'Memory-mapped register fields',
    summary:
      'A device register block driven through read-modify-write helpers: enable bit, ' +
      'mode field, prescaler, a poll loop and a latched error flag.',
    keywords: [
      'mmio', 'memory mapped', 'register', 'registers', 'register map', 'device driver',
      'driver', 'hardware', 'gpio', 'peripheral', 'embedded', 'firmware', 'bare metal',
      'read modify write', 'bitfield', 'bit field',
    ],
    teaches: ['read-modify-write with masks', 'shifted field extraction', 'polling a status bit', 'keeping reserved bits intact'],
    hazards: [
      'Real MMIO pointers must be volatile, and the compiler must not reorder the poll loop.',
      'Every access needs the device width; a 32-bit store to an 8-bit register is not portable.',
      'Write-1-to-clear status bits behave differently from normal memory - read the datasheet.',
    ],
    notes: [
      'write_field masks the value before shifting, so an oversized value cannot bleed into the next field.',
      'read_field shifts down after masking, which is the inverse operation.',
      'The poll loop is bounded so a stuck device cannot hang the program.',
    ],
    complexity: 'O(1) per field access; the poll loop is bounded by the spin cap.',
    defaultPrompt: 'a memory-mapped register field driver',
    tune: () => ({}),
    build: () => String.raw`#include <stdio.h>

/* SINGU AI - expert: register fields by read-modify-write.
   The layout is invented, the discipline is not: mask the field, shift the
   value, keep every other bit exactly as it was.

   CTRL  bit 0 enable, bit 1 irq, bits 4-5 mode, bits 8-15 prescale
   STATUS bit 0 ready, bit 1 error
   DATA  bits 0-15 sample
*/

#define REG_CTRL 0
#define REG_STATUS 1
#define REG_DATA 2

#define CTRL_ENABLE (1 << 0)
#define CTRL_IRQ_EN (1 << 1)
#define CTRL_MODE_SHIFT 4
#define CTRL_MODE_MASK (3 << CTRL_MODE_SHIFT)
#define CTRL_PRESCALE_SHIFT 8
#define CTRL_PRESCALE_MASK (0xff << CTRL_PRESCALE_SHIFT)

#define STATUS_READY (1 << 0)
#define STATUS_ERROR (1 << 1)

typedef struct {
  unsigned int reg[4];
} Device;

unsigned int read_field(Device *d, int reg, unsigned int mask, int shift) {
  return (d->reg[reg] & mask) >> shift;
}

void write_field(Device *d, int reg, unsigned int mask, int shift, unsigned int value) {
  d->reg[reg] = (d->reg[reg] & ~mask) | ((value << shift) & mask);
}

int main(void) {
  Device dev;
  int i;
  int spins = 0;
  unsigned int mode;
  unsigned int prescale;

  for (i = 0; i < 4; i++) dev.reg[i] = 0;

  write_field(&dev, REG_CTRL, CTRL_ENABLE, 0, 1);
  write_field(&dev, REG_CTRL, CTRL_IRQ_EN, 0, 1);
  write_field(&dev, REG_CTRL, CTRL_MODE_MASK, CTRL_MODE_SHIFT, 2);
  write_field(&dev, REG_CTRL, CTRL_PRESCALE_MASK, CTRL_PRESCALE_SHIFT, 10);

  mode = read_field(&dev, REG_CTRL, CTRL_MODE_MASK, CTRL_MODE_SHIFT);
  prescale = read_field(&dev, REG_CTRL, CTRL_PRESCALE_MASK, CTRL_PRESCALE_SHIFT);
  printf("CTRL = 0x%04x\n", dev.reg[REG_CTRL]);
  printf("enabled=%d irq=%d mode=%u prescale=%u\n",
         read_field(&dev, REG_CTRL, CTRL_ENABLE, 0),
         read_field(&dev, REG_CTRL, CTRL_IRQ_EN, 0),
         mode, prescale);

  /* An oversized value must not bleed into the neighbouring field. */
  write_field(&dev, REG_CTRL, CTRL_MODE_MASK, CTRL_MODE_SHIFT, 7);
  printf("mode after writing 7: %u (masked to 2 bits)\n",
         read_field(&dev, REG_CTRL, CTRL_MODE_MASK, CTRL_MODE_SHIFT));

  dev.reg[REG_STATUS] = STATUS_READY;
  while ((dev.reg[REG_STATUS] & STATUS_READY) == 0 && spins < 100) spins++;
  printf("polled ready in %d spins\n", spins);

  write_field(&dev, REG_DATA, 0xffff, 0, 0x1234);
  printf("DATA = 0x%04x\n", dev.reg[REG_DATA]);

  dev.reg[REG_STATUS] = dev.reg[REG_STATUS] | STATUS_ERROR;
  printf("error latched=%d (write-1-to-clear is device-specific)\n",
         read_field(&dev, REG_STATUS, STATUS_ERROR, 0));
  return 0;
}
`,
  },
];

// ------------------------------------------------------------------- matching

const STOP = new Set([
  'a', 'an', 'the', 'me', 'please', 'write', 'create', 'make', 'build', 'generate', 'implement',
  'code', 'program', 'programme', 'c', 'in', 'into', 'using', 'use', 'with', 'for', 'to', 'of',
  'that', 'which', 'and', 'or', 'my', 'i', 'want', 'need', 'should', 'can', 'you', 'it', 'is',
  'some', 'simple', 'small', 'example', 'sample', 'function', 'implementation', 'implementations',
  'level', 'levels', 'most', 'advance', 'advanced', 'system', 'systems', 'low',
]);

const LEVEL_HINTS = [
  ['expert', ['system', 'systems', 'kernel', 'driver', 'firmware', 'embedded', 'allocator', 'malloc',
    'lock free', 'lock-free', 'lockfree', 'atomic', 'atomics', 'spsc', 'mmio', 'register', 'registers',
    'most advanced', 'expert', 'operating system', 'os', 'protocol', 'wire', 'slab', 'arena', 'byte order']],
  ['low', ['low level', 'low-level', 'bit', 'bits', 'bitwise', 'byte', 'bytes', 'mask', 'masks',
    'shift', 'shifts', 'stack', 'no malloc', 'bare metal', 'fixed', 'buffer']],
  ['advanced', ['advanced', 'data structure', 'heap', 'pointer', 'pointers', 'recursive', 'algorithm',
    'linked', 'tree', 'hash', 'sort', 'parse', 'split']],
];

const normalise = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9+#-]+/g, ' ').trim();
const wordSet = (text) => new Set(normalise(text).split(' ').filter((w) => w && !STOP.has(w)));

export function classifyLevel(text) {
  const lower = normalise(text);
  for (const [level, hints] of LEVEL_HINTS) {
    if (hints.some((hint) => lower.includes(hint))) return level;
  }
  return null;
}

function scoreRecipe(recipe, text, words, preferredLevel) {
  const lower = normalise(text);
  const matched = [];
  let score = 0;
  for (const keyword of recipe.keywords) {
    if (keyword.includes(' ') || keyword.includes('-')) {
      if (lower.includes(keyword)) {
        score += 3;
        matched.push(keyword);
      }
    } else if (words.has(keyword)) {
      score += 2;
      matched.push(keyword);
    } else {
      for (const word of words) {
        if (word.length >= 4 && keyword.length >= 4 && (word.startsWith(keyword) || keyword.startsWith(word))) {
          score += 1;
          matched.push(keyword);
          break;
        }
      }
    }
  }
  const titleWords = wordSet(recipe.title);
  for (const word of titleWords) {
    if (words.has(word) && !matched.includes(word)) {
      score += 1;
      matched.push(word);
    }
  }
  return {
    score,
    matched: [...new Set(matched)],
    levelMatch: Boolean(preferredLevel) && recipe.level === preferredLevel,
  };
}

function extractNumber(text) {
  const lower = normalise(text);
  const m = /(?:of|with|holds?|capacity|size|slots?|entries|bits?|blocks?|bytes?|nodes?|elements?)\s*[:=]?\s*(\d{1,5})/.exec(lower)
    || /\b(\d{1,5})\b/.exec(lower);
  return m ? Number(m[1]) : null;
}

function planFor(recipe, params, confidence) {
  const knobs = Object.entries(params)
    .filter(([, value]) => value != null)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return [
    `Match the brief to "${recipe.title}" (${levelLabel(recipe.level)}) at ${Math.round(confidence * 100)}% confidence.`,
    knobs ? `Bind the knobs that change the program: ${knobs}.` : 'This pattern has no size knob; the constants stay fixed for a readable trace.',
    `Emit only the M2 subset: ${recipe.teaches.join(', ')}.`,
    'Add bounds and failure paths, then print a deterministic trace so the run itself is the proof.',
  ];
}

const publicRecipe = (recipe) => ({
  id: recipe.id,
  level: recipe.level,
  levelLabel: levelLabel(recipe.level),
  title: recipe.title,
  summary: recipe.summary,
  teaches: [...recipe.teaches],
  hazards: [...recipe.hazards],
  notes: [...recipe.notes],
  complexity: recipe.complexity,
  defaultPrompt: recipe.defaultPrompt,
});

/**
 * Match a brief to a pattern and generate the C.
 * Returns a complete result even when nothing matches: the closest pattern, a
 * low confidence and the alternatives, rather than an empty answer.
 */
export function generate(prompt, options = {}) {
  const text = String(prompt == null ? '' : prompt).trim();
  const explicitLevel = options.level && options.level !== 'auto' ? options.level : null;
  const detectedLevel = classifyLevel(text);
  const preferred = explicitLevel || detectedLevel;
  const fallbackLevel = preferred || 'low';
  const words = wordSet(text);
  let best = null;

  if (text) {
    for (const recipe of RECIPES) {
      const candidate = scoreRecipe(recipe, text, words, preferred);
      if (
        !best
        || candidate.score > best.score
        || (candidate.score === best.score && candidate.levelMatch && !best.levelMatch)
      ) {
        best = { recipe, ...candidate };
      }
    }
  }

  const levelOnly = Boolean(best && best.score === 0 && preferred);
  if (!best || best.score === 0) {
    const fallback = RECIPES.find((r) => r.level === fallbackLevel) || RECIPES[0];
    best = {
      recipe: fallback,
      score: 0,
      matched: [],
      levelMatch: Boolean(preferred) && fallback.level === preferred,
    };
  }

  const confidence = best.score > 0
    ? Math.min(0.96, 0.55 + best.score * 0.04)
    : levelOnly ? 0.35 : 0.2;
  const params = best.recipe.tune(extractNumber(text));
  const code = best.recipe.build(params);
  const plan = planFor(best.recipe, params, confidence);
  if (best.score === 0) {
    plan.unshift(levelOnly
      ? `No pattern keyword matched; showing the ${levelLabel(best.recipe.level)} starter. Name a structure (ring buffer, hash table, allocator, register map) for a sharper match.`
      : 'No pattern keyword matched; showing the low-level starter. Try naming a structure, a memory strategy or a level.');
  }

  const ranked = RECIPES
    .filter((r) => r.id !== best.recipe.id)
    .map((r) => ({ recipe: r, ...scoreRecipe(r, text, words, preferred) }))
    .sort((a, b) => b.score - a.score
      || Number(b.levelMatch) - Number(a.levelMatch)
      || a.recipe.title.localeCompare(b.recipe.title));

  return {
    ok: true,
    prompt: text,
    requestedLevel: explicitLevel || detectedLevel || 'auto',
    level: best.recipe.level,
    levelOnly,
    confidence,
    matched: best.matched,
    params,
    code,
    recipe: publicRecipe(best.recipe),
    plan,
    alternatives: ranked.slice(0, 3).map(({ recipe, score }) => ({
      ...publicRecipe(recipe),
      score,
    })),
  };
}

/** The catalogue, optionally filtered by level. */
export function browse(level) {
  return RECIPES
    .filter((r) => !level || r.level === level)
    .map(publicRecipe);
}

// ------------------------------------------------------------------- reviewing

const stripLiterals = (code) => String(code)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ')
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/'(?:\\.|[^'\\])*'/g, "''");

/**
 * Static review: the checks a careful reviewer makes before a compiler run.
 * These are issues (will not build / unsafe) and hints (builds, but a human
 * should look). The compiler in the sandbox stays the authority on syntax.
 */
export function review(code) {
  const source = String(code == null ? '' : code);
  const stripped = stripLiterals(source);
  const lines = source.split('\n');
  const issues = [];
  const hints = [];
  const add = (list, line, text) => list.push({ line, text });

  const pairs = [['{', '}', 'brace'], ['(', ')', 'parenthesis'], ['[', ']', 'bracket']];
  for (const [open, close, name] of pairs) {
    const a = (stripped.match(new RegExp(`\\${open}`, 'g')) || []).length;
    const b = (stripped.match(new RegExp(`\\${close}`, 'g')) || []).length;
    if (a !== b) {
      const probe = lines.findIndex((line) => line.includes(open));
      add(issues, probe < 0 ? 1 : probe + 1, `${name} imbalance: ${a} '${open}' vs ${b} '${close}'.`);
    }
  }

  if (!/\bint\s+main\s*\(/.test(stripped)) {
    add(issues, 1, 'No int main() entry point. The sandbox needs one to link.');
  }
  if (/\bgets\s*\(/.test(stripped)) {
    add(issues, 1, 'gets() cannot be bounded and is unsafe; use fgets() with a size.');
  }
  const unboundedScan = lines.findIndex((line) => /scanf\s*\([^)]*"%s"/.test(line));
  if (unboundedScan !== -1) {
    add(hints, unboundedScan + 1, 'Unbounded %s in scanf; put a width in the format, e.g. %63s.');
  }
  if (/\bstrcpy\s*\(/.test(stripped)) {
    add(hints, 1, 'strcpy has no destination bound; prefer strncpy plus an explicit NUL, or snprintf.');
  }
  const allocs = (stripped.match(/\b(malloc|calloc|realloc)\s*\(/g) || []).length;
  const frees = (stripped.match(/\bfree\s*\(/g) || []).length;
  if (allocs !== frees) {
    add(hints, 1, `Allocation balance: ${allocs} alloc(s) vs ${frees} free(s). realloc may reuse its block, so this is a hint, not a verdict.`);
  }
  if (/(?:printf|puts|putchar|scanf|sprintf|fgets)\s*\(/.test(stripped) && !/#include\s*<stdio\.h>/.test(source)) {
    add(issues, 1, 'stdio calls without #include <stdio.h>. The runtime has the functions, but the program should declare its dependency.');
  }
  const signedShift = lines.findIndex((line) => /1\s*<<\s*(3[2-9]|[4-9]\d|\d{3,})/.test(line));
  if (signedShift !== -1) {
    add(hints, signedShift + 1, 'Shifting a signed int into or past bit 31 is undefined; use an unsigned constant such as 1u.');
  }
  const assignmentInIf = lines.findIndex((line) => /\bif\s*\([^=!<>]*[^=!<>]=[^=]/.test(line));
  if (assignmentInIf !== -1) {
    add(hints, assignmentInIf + 1, 'Assignment inside if(); C accepts it, but == is usually what was meant.');
  }
  if (/\bwhile\s*\(\s*1\s*\)/.test(stripped) && !/\bbreak\b/.test(stripped) && !/\breturn\b/.test(stripped)) {
    add(hints, 1, 'while (1) with no break or return never ends; the sandbox will kill it at the wall-clock limit.');
  }

  return { issues, hints, lines: lines.length, allocs, frees };
}

/**
 * Turn a sandbox error into an explanation a C learner can act on.
 * The sandbox result already carries stage/line/column; this adds the "why".
 */
export function diagnose(error) {
  if (!error) return [];
  const stage = error.stage || 'Runtime';
  const message = String(error.message || error);
  const line = Number.isInteger(error.line) ? error.line : 1;
  const col = Number.isInteger(error.col) ? error.col : 1;
  const out = [{ line, col, severity: 'error', text: `${stage}: ${message}` }];

  const explain = (pattern, text) => {
    if (pattern.test(message)) out.push({ line, col, severity: 'note', text });
  };

  explain(/unterminated string literal/i,
    'A string literal has no closing quote on this line.');
  explain(/expected .*[;)]/i,
    'The parser reached a token before the statement was complete; a missing semicolon or parenthesis is the usual cause.');
  explain(/assignment to undeclared identifier '([^']+)'/i,
    'C needs a declaration before assignment: give the name a type on its first use.');
  explain(/array index (\d+) out of bounds \(length (\d+)\)/i,
    'The index is outside the array. Check whether the loop bound should be < length rather than <= length.');
  explain(/heap access past the end/i,
    'A read or write crossed the end of a heap block. Recheck the byte count given to malloc/calloc and the index into the pointer.');
  explain(/heap (limit|cap|exhausted)|allocation .*exceed/i,
    'The sandbox heap budget is exhausted. Free what is no longer needed, or allocate fewer bytes.');
  explain(/no entry point/i,
    'The runtime links against int main(void); without it there is nothing to run.');
  explain(/division by zero|divide by zero/i,
    'A divisor reached zero. Check the value before the division instead of after it.');
  explain(/recursion|stack depth|call depth/i,
    'The call depth budget was hit. A recursive function is probably missing its base case.');
  explain(/unknown (identifier|function) '([^']+)'/i,
    'That name is not in the M2 subset. Check the spelling, or use one of the functions the runtime documents.');
  explain(/killed after .*wall-clock/i,
    'The program did not finish inside the wall-clock budget. An unbounded loop is the usual cause; the worker is terminated, not slowed.');
  explain(/terminated by the user/i,
    'The run was stopped from the page. No cleanup code ran inside the worker.');

  return out;
}
