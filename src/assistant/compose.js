/**
 * SINGU composer - everyday C from typed blocks.
 *
 * The systems catalogue answers "write me an arena allocator". Most briefs are
 * smaller: "sum and average of numbers from stdin", "is this string a
 * palindrome", "primes up to 50". This module turns those into one complete
 * program by selecting typed *blocks* and assembling them:
 *
 *   - four input families: an integer array, one line of text, a fixed 3x3
 *     matrix, and a scalar N (optionally M);
 *   - each block is a function plus the main lines that print its result; a
 *     block never mutates the shared input, so request order cannot change an
 *     answer;
 *   - every block carries its own expectation, computed independently in
 *     JavaScript from the same demo data, which is what the autopilot checks;
 *   - with empty stdin the program announces a labelled demo and runs the same
 *     steps, so a first run is never a blank screen and never pretends it saw
 *     input.
 *
 * Still not a model, still no network, still only the M2 subset. The C this
 * emits is deliberately plain: bounded loops, explicit types, no library call
 * the interpreter does not implement.
 */

export const COMPOSER_VERSION = '1.0';

export const DEMO_INTS = [42, 7, 19, 3, 88, 15, 23, 4];
export const TEST_INTS = [1, 2, 3, 4, 5];
export const DEMO_TEXT = 'the quick brown fox jumps over the lazy dog';
export const TEST_TEXT = 'step on no pets';
export const DEMO_MATRIX = [[2, -1, 3], [0, 5, 4], [7, 2, 1]];
export const TEST_N = 12;
export const TEST_M = 5;

// ------------------------------------------------------- independent oracles
// These are the expectations, not the generator: a bug in the C cannot change
// them, and the suite runs the C and compares.

const sumOf = (xs) => xs.reduce((a, b) => a + b, 0);
const sortedOf = (xs) => [...xs].sort((a, b) => a - b);
const medianOf = (xs) => {
  const s = sortedOf(xs);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const varianceOf = (xs) => {
  const mean = sumOf(xs) / xs.length;
  return xs.reduce((a, x) => a + (x - mean) * (x - mean), 0) / xs.length;
};
const wordsOf = (text) => text.split(/\s+/).filter(Boolean);
const vowelsOf = (text) => [...text.toLowerCase()].filter((c) => 'aeiou'.includes(c)).length;
const consonantsOf = (text) =>
  [...text.toLowerCase()].filter((c) => c >= 'a' && c <= 'z' && !'aeiou'.includes(c)).length;
const caesarOf = (text, k) => {
  const shift = ((k % 26) + 26) % 26;
  return [...text].map((c) => {
    if (c >= 'a' && c <= 'z') return String.fromCharCode(97 + ((c.charCodeAt(0) - 97 + shift) % 26));
    if (c >= 'A' && c <= 'Z') return String.fromCharCode(65 + ((c.charCodeAt(0) - 65 + shift) % 26));
    return c;
  }).join('');
};
const rleOf = (text) => {
  let out = '';
  let i = 0;
  while (i < text.length) {
    let run = 1;
    while (text[i + run] === text[i]) run += 1;
    out += text[i] + String(run);
    i += run;
  }
  return out;
};
const longestWordOf = (text) => wordsOf(text).reduce((best, word) => (word.length > best.length ? word : best), '');
const mostCommonOf = (text) => {
  const freq = Array(26).fill(0);
  for (const c of text.toLowerCase()) if (c >= 'a' && c <= 'z') freq[c.charCodeAt(0) - 97] += 1;
  let best = 0;
  for (let i = 1; i < 26; i += 1) if (freq[i] > freq[best]) best = i;
  return { letter: String.fromCharCode(97 + best), count: freq[best] };
};
const matrixRow = (row, width = 4) => row.map((v) => String(v).padStart(width)).join('');
const matMul = (a, b) => a.map((row, i) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const transposeOf = (m) => m[0].map((_, j) => m.map((row) => row[j]));
const isPrimeOf = (n) => {
  if (n < 2) return false;
  for (let i = 2; i * i <= n; i += 1) if (n % i === 0) return false;
  return true;
};
const primesUpToOf = (n) => {
  const out = [];
  for (let i = 2; i <= n; i += 1) if (isPrimeOf(i)) out.push(i);
  return out;
};
const reverseNumberOf = (n) => Number(String(n).split('').reverse().join(''));
const digitSumOf = (n) => String(n).split('').reduce((a, c) => a + Number(c), 0);
const digitCountOf = (n) => String(n).length;
const isArmstrongOf = (n) => {
  const digits = String(n).split('');
  return digits.reduce((a, c) => a + Math.pow(Number(c), digits.length), 0) === n;
};
const isNumPalindromeOf = (n) => n === reverseNumberOf(n);
const fibonacciOf = (terms) => {
  const out = [];
  let a = 0;
  let b = 1;
  for (let i = 0; i < terms; i += 1) {
    out.push(a);
    const t = a + b;
    a = b;
    b = t;
  }
  return out;
};
const factorialOf = (n) => {
  let f = 1;
  for (let i = 2; i <= n; i += 1) f *= i;
  return f;
};
const gcdOf = (a, b) => {
  while (b !== 0) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
};
const hanoiOf = (n) => {
  const moves = [];
  const walk = (d, from, to, via) => {
    if (d === 0) return;
    walk(d - 1, from, via, to);
    moves.push(`move disk ${d}: ${from} -> ${to}`);
    walk(d - 1, via, to, from);
  };
  walk(n, 'A', 'C', 'B');
  return moves;
};
const collatzOf = (n) => {
  const chain = [n];
  let c = n;
  let guard = 0;
  while (c !== 1 && guard < 200) {
    c = c % 2 === 0 ? c / 2 : 3 * c + 1;
    chain.push(c);
    guard += 1;
  }
  return chain;
};
const fizzbuzzOf = (n) => {
  const out = [];
  for (let i = 1; i <= n; i += 1) {
    if (i % 15 === 0) out.push('FizzBuzz');
    else if (i % 3 === 0) out.push('Fizz');
    else if (i % 5 === 0) out.push('Buzz');
    else out.push(String(i));
  }
  return out;
};

// --------------------------------------------------------------- C fragments

const FN_MEAN = `double mean_of(const int *a, int n) {
  double s = 0.0;
  int i;
  for (i = 0; i < n; i++) s += a[i];
  return n > 0 ? s / n : 0.0;
}`;

const FN_SORT_ASC = `void sort_asc(int *x, int n) {
  int i, j, t;
  for (i = 0; i < n - 1; i++) {
    for (j = 0; j < n - 1 - i; j++) {
      if (x[j] > x[j + 1]) { t = x[j]; x[j] = x[j + 1]; x[j + 1] = t; }
    }
  }
}`;

const FN_SORT_DESC = `void sort_desc(int *x, int n) {
  int i, j, t;
  for (i = 0; i < n - 1; i++) {
    for (j = 0; j < n - 1 - i; j++) {
      if (x[j] < x[j + 1]) { t = x[j]; x[j] = x[j + 1]; x[j + 1] = t; }
    }
  }
}`;

const FN_REVERSE_NUMBER = `int reverse_number(int n) {
  int r = 0;
  while (n > 0) { r = r * 10 + n % 10; n /= 10; }
  return r;
}`;

const FN_IS_PRIME = `int is_prime(int n) {
  int i;
  if (n < 2) return 0;
  for (i = 2; i * i <= n; i++) if (n % i == 0) return 0;
  return 1;
}`;

const FN_DIGIT_COUNT = `int digit_count(int n) {
  int count = 0;
  int t = n;
  if (t == 0) return 1;
  while (t > 0) { count++; t /= 10; }
  return count;
}`;

const FN_GCD = `int gcd(int a, int b) {
  while (b != 0) { int t = a % b; a = b; b = t; }
  return a;
}`;

// ------------------------------------------------------------------- blocks
// A block = a family, keyword surface, help text, C (functions + declarations
// + main lines), and an expectation computed from the same demo data.

export const COMPOSER_TASKS = [
  // -------------------------------------------------------------- int array
  {
    id: 'sum',
    family: 'ints',
    level: 'low',
    title: 'Sum of an array',
    keywords: ['sum', 'total', 'add up', 'add them', 'sum of'],
    teaches: ['scan until EOF with a bounded array', 'accumulate in an int'],
    note: 'The read loop stops at MAXN and at the first non-integer, so a stray word ends input instead of looping forever.',
    cost: 'O(n)',
    defaultPrompt: 'the sum of numbers read from standard input',
    fns: {
      sum_of: `int sum_of(const int *a, int n) {
  int s = 0;
  int i;
  for (i = 0; i < n; i++) s += a[i];
  return s;
}`,
    },
    lines: () => ['  printf("sum: %d\\n", sum_of(a, n));'],
    expect: (v) => [`sum: ${sumOf(v.ints)}`],
  },
  {
    id: 'mean',
    family: 'ints',
    level: 'low',
    title: 'Mean (average)',
    keywords: ['average', 'mean', 'avg', 'arithmetic mean'],
    teaches: ['integer input to double accumulation', 'divide by the real count'],
    note: 'The sum is accumulated in a double, so the mean keeps its fraction instead of truncating like int division.',
    cost: 'O(n)',
    defaultPrompt: 'the average of numbers from stdin',
    fns: { mean_of: FN_MEAN },
    lines: () => ['  printf("mean: %.3f\\n", mean_of(a, n));'],
    expect: (v) => [`mean: ${(sumOf(v.ints) / v.ints.length).toFixed(3)}`],
  },
  {
    id: 'min-max',
    family: 'ints',
    level: 'low',
    title: 'Smallest and largest',
    keywords: ['min', 'max', 'minimum', 'maximum', 'smallest', 'largest', 'biggest', 'lowest', 'highest', 'range'],
    teaches: ['one pass, two running answers', 'out-parameters instead of a tuple'],
    note: 'One pass updates both answers, so the pair costs a single scan and cannot disagree about the input.',
    cost: 'O(n)',
    defaultPrompt: 'the smallest and largest values in an array',
    fns: {
      min_max: `void min_max(const int *a, int n, int *lo, int *hi) {
  int i;
  *lo = a[0];
  *hi = a[0];
  for (i = 1; i < n; i++) {
    if (a[i] < *lo) *lo = a[i];
    if (a[i] > *hi) *hi = a[i];
  }
}`,
    },
    decls: ['  int lo = 0;', '  int hi = 0;'],
    lines: () => [
      '  min_max(a, n, &lo, &hi);',
      '  printf("min: %d\\n", lo);',
      '  printf("max: %d\\n", hi);',
    ],
    expect: (v) => [`min: ${Math.min(...v.ints)}`, `max: ${Math.max(...v.ints)}`],
  },
  {
    id: 'sort-asc',
    family: 'ints',
    level: 'advanced',
    title: 'Sort ascending',
    keywords: ['sort', 'sorted', 'ascending', 'smallest first', 'in order'],
    teaches: ['bubble sort with a shrinking bound', 'sorting a copy, not the shared input'],
    note: 'The block copies the array before sorting, so a later step still sees the input in its original order.',
    cost: 'O(n^2)',
    defaultPrompt: 'sort the numbers in ascending order',
    fns: { sort_asc: FN_SORT_ASC },
    decls: ['  int asc[MAXN];'],
    lines: () => [
      '  for (i = 0; i < n; i++) asc[i] = a[i];',
      '  sort_asc(asc, n);',
      '  printf("ascending:");',
      '  for (i = 0; i < n; i++) printf(" %d", asc[i]);',
      '  printf("\\n");',
    ],
    expect: (v) => [`ascending: ${sortedOf(v.ints).join(' ')}`],
  },
  {
    id: 'sort-desc',
    family: 'ints',
    level: 'advanced',
    title: 'Sort descending',
    keywords: ['descending', 'sort descending', 'largest first', 'biggest first', 'reverse order'],
    teaches: ['the comparator is the only change', 'stable trace order'],
    note: 'Only the comparison flips; the loop structure is identical to the ascending sort, which makes the pair easy to compare.',
    cost: 'O(n^2)',
    defaultPrompt: 'sort the numbers in descending order',
    fns: { sort_desc: FN_SORT_DESC },
    decls: ['  int desc[MAXN];'],
    lines: () => [
      '  for (i = 0; i < n; i++) desc[i] = a[i];',
      '  sort_desc(desc, n);',
      '  printf("descending:");',
      '  for (i = 0; i < n; i++) printf(" %d", desc[i]);',
      '  printf("\\n");',
    ],
    expect: (v) => [`descending: ${sortedOf(v.ints).reverse().join(' ')}`],
  },
  {
    id: 'median',
    family: 'ints',
    level: 'advanced',
    title: 'Median',
    keywords: ['median', 'middle value', 'middle number'],
    teaches: ['even vs odd counts', 'sorting a local copy'],
    note: 'An even count averages the two middle values; the sort happens on a local copy so the caller keeps its order.',
    cost: 'O(n^2)',
    defaultPrompt: 'the median of an array of numbers',
    fns: {
      median_of: `double median_of(const int *a, int n) {
  int b[MAXN];
  int i, j, t;
  for (i = 0; i < n; i++) b[i] = a[i];
  for (i = 0; i < n - 1; i++) {
    for (j = 0; j < n - 1 - i; j++) {
      if (b[j] > b[j + 1]) { t = b[j]; b[j] = b[j + 1]; b[j + 1] = t; }
    }
  }
  if (n == 0) return 0.0;
  if (n % 2 == 1) return (double)b[n / 2];
  return ((double)b[n / 2 - 1] + (double)b[n / 2]) / 2.0;
}`,
    },
    lines: () => ['  printf("median: %.1f\\n", median_of(a, n));'],
    expect: (v) => [`median: ${medianOf(v.ints).toFixed(1)}`],
  },
  {
    id: 'variance',
    family: 'ints',
    level: 'advanced',
    title: 'Variance and standard deviation',
    keywords: ['variance', 'standard deviation', 'std dev', 'spread', 'deviation'],
    teaches: ['squared deviations from the mean', 'population variance', 'sqrt from math.h'],
    note: 'Population variance divides by n, not n - 1: the demo array is the whole data set, not a sample.',
    cost: 'O(n)',
    includes: ['math.h'],
    defaultPrompt: 'the variance and standard deviation of an array',
    fns: {
      mean_of: FN_MEAN,
      variance_of: `double variance_of(const int *a, int n) {
  double m, s;
  int i;
  if (n == 0) return 0.0;
  m = mean_of(a, n);
  s = 0.0;
  for (i = 0; i < n; i++) s += (a[i] - m) * (a[i] - m);
  return s / n;
}`,
    },
    lines: () => [
      '  printf("variance: %.3f\\n", variance_of(a, n));',
      '  printf("std dev: %.3f\\n", sqrt(variance_of(a, n)));',
    ],
    expect: (v) => [
      `variance: ${varianceOf(v.ints).toFixed(3)}`,
      `std dev: ${Math.sqrt(varianceOf(v.ints)).toFixed(3)}`,
    ],
  },
  {
    id: 'linear-search',
    family: 'ints',
    level: 'advanced',
    title: 'Linear search',
    keywords: ['search', 'look for', 'linear search', 'contains', 'index of'],
    teaches: ['a found/not-found contract via -1', 'early return'],
    note: 'A -1 return is the sentinel: an index of -1 can never be a valid array position, so the caller has one check.',
    cost: 'O(n)',
    usesTarget: true,
    demoTarget: 23,
    defaultPrompt: 'search an array for a value',
    fns: {
      find_linear: `int find_linear(const int *a, int n, int target) {
  int i;
  for (i = 0; i < n; i++) if (a[i] == target) return i;
  return -1;
}`,
    },
    lines: (p) => [
      `  if (find_linear(a, n, ${p.target}) >= 0) printf("search ${p.target}: found at index %d\\n", find_linear(a, n, ${p.target}));`,
      `  else printf("search ${p.target}: not found\\n");`,
    ],
    expect: (v) => [
      v.ints.includes(v.target)
        ? `search ${v.target}: found at index ${v.ints.indexOf(v.target)}`
        : `search ${v.target}: not found`,
    ],
  },
  {
    id: 'binary-search',
    family: 'ints',
    level: 'advanced',
    title: 'Binary search',
    keywords: ['binary search', 'bisect', 'logarithmic search', 'binary search tree'],
    teaches: ['sort before searching', 'halving the interval', 'O(log n) lookups'],
    note: 'The array is copied and sorted first: binary search on unsorted data is the classic silent failure.',
    cost: 'O(n^2) to prepare, O(log n) per lookup',
    usesTarget: true,
    demoTarget: 23,
    defaultPrompt: 'binary search for a value in a sorted array',
    fns: {
      sort_asc: FN_SORT_ASC,
      find_binary: `int find_binary(const int *a, int n, int target) {
  int lo = 0;
  int hi = n - 1;
  int mid;
  while (lo <= hi) {
    mid = (lo + hi) / 2;
    if (a[mid] == target) return mid;
    if (a[mid] < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}`,
    },
    decls: ['  int bykey[MAXN];'],
    lines: (p) => [
      '  for (i = 0; i < n; i++) bykey[i] = a[i];',
      '  sort_asc(bykey, n);',
      `  if (find_binary(bykey, n, ${p.target}) >= 0) printf("binary search ${p.target} in the sorted array: index %d\\n", find_binary(bykey, n, ${p.target}));`,
      `  else printf("binary search ${p.target} in the sorted array: not present\\n");`,
    ],
    expect: (v) => {
      const at = sortedOf(v.ints).indexOf(v.target);
      return [at >= 0
        ? `binary search ${v.target} in the sorted array: index ${at}`
        : `binary search ${v.target} in the sorted array: not present`];
    },
  },
  {
    id: 'reverse-array',
    family: 'ints',
    level: 'low',
    title: 'Reverse an array',
    keywords: ['reverse', 'reverse the array', 'reverse an array', 'in reverse order', 'flip'],
    teaches: ['two indices meeting in the middle', 'swap without a library call'],
    note: 'The swap loop runs to n / 2, not n: the second half would undo the first.',
    cost: 'O(n)',
    defaultPrompt: 'reverse an array of numbers',
    fns: {
      reverse_arr: `void reverse_arr(int *x, int n) {
  int i, t;
  for (i = 0; i < n / 2; i++) {
    t = x[i];
    x[i] = x[n - 1 - i];
    x[n - 1 - i] = t;
  }
}`,
    },
    decls: ['  int rev[MAXN];'],
    lines: () => [
      '  for (i = 0; i < n; i++) rev[i] = a[i];',
      '  reverse_arr(rev, n);',
      '  printf("reversed:");',
      '  for (i = 0; i < n; i++) printf(" %d", rev[i]);',
      '  printf("\\n");',
    ],
    expect: (v) => [`reversed: ${[...v.ints].reverse().join(' ')}`],
  },
  {
    id: 'evens-odds',
    family: 'ints',
    level: 'low',
    title: 'Even and odd counts',
    keywords: ['even', 'odd', 'evens', 'odds', 'parity'],
    requires: ['array', 'numbers', 'list', 'sequence'],
    teaches: ['modulo as a parity test', 'two counters in one pass'],
    note: 'C keeps the sign of the remainder, so a negative odd number still answers -1 and counts as odd.',
    cost: 'O(n)',
    defaultPrompt: 'count the even and odd numbers in an array',
    fns: {
      split_parity: `void split_parity(const int *a, int n, int *evens, int *odds) {
  int i;
  *evens = 0;
  *odds = 0;
  for (i = 0; i < n; i++) {
    if (a[i] % 2 == 0) (*evens)++;
    else (*odds)++;
  }
}`,
    },
    decls: ['  int evens = 0;', '  int odds = 0;'],
    lines: () => [
      '  split_parity(a, n, &evens, &odds);',
      '  printf("evens: %d\\n", evens);',
      '  printf("odds: %d\\n", odds);',
    ],
    expect: (v) => [
      `evens: ${v.ints.filter((x) => x % 2 === 0).length}`,
      `odds: ${v.ints.filter((x) => x % 2 !== 0).length}`,
    ],
  },
  {
    id: 'dedupe',
    family: 'ints',
    level: 'advanced',
    title: 'Remove duplicates',
    keywords: ['duplicate', 'duplicates', 'unique', 'dedupe', 'distinct', 'remove duplicates'],
    teaches: ['a write index that only advances on a new value', 'O(n^2) membership scan'],
    note: 'The write index m never passes the read index i, so the copy can share the input array safely.',
    cost: 'O(n^2)',
    defaultPrompt: 'remove the duplicates from an array',
    fns: {
      dedupe: `int dedupe(const int *x, int n, int *out) {
  int i, j, m = 0;
  for (i = 0; i < n; i++) {
    int seen = 0;
    for (j = 0; j < m; j++) if (out[j] == x[i]) { seen = 1; break; }
    if (!seen) out[m++] = x[i];
  }
  return m;
}`,
    },
    decls: ['  int uniq[MAXN];', '  int un = 0;'],
    lines: () => [
      '  un = dedupe(a, n, uniq);',
      '  printf("unique (%d):", un);',
      '  for (i = 0; i < un; i++) printf(" %d", uniq[i]);',
      '  printf("\\n");',
    ],
    expect: (v) => {
      const uniq = [...new Set(v.ints)];
      return [`unique (${uniq.length}): ${uniq.join(' ')}`];
    },
  },
  {
    id: 'second-largest',
    family: 'ints',
    level: 'advanced',
    title: 'Second largest',
    keywords: ['second largest', 'second biggest', 'runner up', 'second highest'],
    teaches: ['a running pair with an explicit tie rule', 'one pass instead of a sort'],
    note: 'An equal-to-best value does not become the second largest, so duplicates cannot inflate the answer.',
    cost: 'O(n)',
    defaultPrompt: 'the second largest value in an array',
    fns: {
      second_largest: `int second_largest(const int *a, int n) {
  int best = a[0];
  int second = a[0];
  int i;
  for (i = 1; i < n; i++) {
    if (a[i] > best) { second = best; best = a[i]; }
    else if (a[i] > second && a[i] != best) second = a[i];
  }
  return second;
}`,
    },
    lines: () => ['  printf("second largest: %d\\n", second_largest(a, n));'],
    expect: (v) => {
      const distinct = [...new Set(v.ints)].sort((a, b) => b - a);
      return [`second largest: ${distinct.length > 1 ? distinct[1] : distinct[0]}`];
    },
  },
  {
    id: 'two-sum',
    family: 'ints',
    level: 'advanced',
    title: 'Pair summing to a target',
    keywords: ['two sum', 'two numbers', 'pair', 'pairs', 'sum to', 'pair summing', 'add up to'],
    teaches: ['nested loops with j starting at i + 1', 'reporting two indices at once'],
    note: 'j starts at i + 1, so a pair is never considered twice and an element is never paired with itself.',
    cost: 'O(n^2)',
    usesTarget: true,
    demoTarget: 42,
    defaultPrompt: 'the pair of numbers that add up to 42',
    fns: {
      pair_sum: `int pair_sum(const int *a, int n, int target, int *pi, int *pj) {
  int i, j;
  for (i = 0; i < n; i++) {
    for (j = i + 1; j < n; j++) {
      if (a[i] + a[j] == target) { *pi = i; *pj = j; return 1; }
    }
  }
  return 0;
}`,
    },
    decls: ['  int pi = -1;', '  int pj = -1;'],
    lines: (p) => [
      `  if (pair_sum(a, n, ${p.target}, &pi, &pj)) printf("pair summing to ${p.target}: %d + %d\\n", a[pi], a[pj]);`,
      `  else printf("pair summing to ${p.target}: none\\n");`,
    ],
    expect: (v) => {
      for (let i = 0; i < v.ints.length; i += 1) {
        for (let j = i + 1; j < v.ints.length; j += 1) {
          if (v.ints[i] + v.ints[j] === v.target) return [`pair summing to ${v.target}: ${v.ints[i]} + ${v.ints[j]}`];
        }
      }
      return [`pair summing to ${v.target}: none`];
    },
  },

  // ------------------------------------------------------------------ text
  {
    id: 'reverse-text',
    family: 'text',
    level: 'low',
    title: 'Reverse a string',
    keywords: ['reverse', 'reverse the string', 'reverse a string', 'backwards', 'backward'],
    teaches: ['length from strlen', 'in-place swaps on a copy'],
    note: 'The program reverses a copy, so a later word count still sees the original sentence.',
    cost: 'O(n)',
    defaultPrompt: 'reverse a string from stdin',
    fns: {
      str_reverse: `void str_reverse(char *s) {
  int i, j, t;
  int n = (int)strlen(s);
  i = 0;
  j = n - 1;
  while (i < j) {
    t = s[i];
    s[i] = s[j];
    s[j] = t;
    i++;
    j--;
  }
}`,
    },
    decls: ['  char rev[MAXL];'],
    lines: () => [
      '  strncpy(rev, line, MAXL - 1);',
      '  rev[MAXL - 1] = 0;',
      '  str_reverse(rev);',
      '  printf("reversed: %s\\n", rev);',
    ],
    expect: (v) => [`reversed: ${[...v.text].reverse().join('')}`],
  },
  {
    id: 'palindrome',
    family: 'text',
    level: 'low',
    title: 'Palindrome check',
    keywords: ['palindrome', 'palindromic', 'same forwards and backwards', 'mirror'],
    teaches: ['two indices from both ends', 'strict byte comparison'],
    note: 'The check is exact: case and spaces count. Normalising them is a separate, explicit step a real tool should not hide.',
    cost: 'O(n)',
    defaultPrompt: 'check whether a string is a palindrome',
    fns: {
      is_palindrome: `int is_palindrome(const char *s) {
  int i = 0;
  int j = (int)strlen(s) - 1;
  while (i < j) {
    if (s[i] != s[j]) return 0;
    i++;
    j--;
  }
  return 1;
}`,
    },
    lines: () => ['  printf("palindrome: %s\\n", is_palindrome(line) ? "yes" : "no");'],
    expect: (v) => [`palindrome: ${[...v.text].reverse().join('') === v.text ? 'yes' : 'no'}`],
  },
  {
    id: 'vowels',
    family: 'text',
    level: 'low',
    title: 'Vowels and consonants',
    keywords: ['vowel', 'vowels', 'consonant', 'consonants', 'letters'],
    teaches: ['ctype tolower before the test', 'two counters in one pass'],
    note: 'tolower runs before the vowel test, so "A" and "a" cannot land in different buckets.',
    cost: 'O(n)',
    defaultPrompt: 'count the vowels and consonants in a sentence',
    fns: {
      count_vowels: `void count_vowels(const char *s, int *v, int *c) {
  int i;
  *v = 0;
  *c = 0;
  for (i = 0; s[i] != 0; i++) {
    char ch = (char)tolower(s[i]);
    if (ch >= 'a' && ch <= 'z') {
      if (ch == 'a' || ch == 'e' || ch == 'i' || ch == 'o' || ch == 'u') (*v)++;
      else (*c)++;
    }
  }
}`,
    },
    decls: ['  int vowels = 0;', '  int consonants = 0;'],
    lines: () => [
      '  count_vowels(line, &vowels, &consonants);',
      '  printf("vowels: %d\\n", vowels);',
      '  printf("consonants: %d\\n", consonants);',
    ],
    expect: (v) => [`vowels: ${vowelsOf(v.text)}`, `consonants: ${consonantsOf(v.text)}`],
  },
  {
    id: 'uppercase',
    family: 'text',
    level: 'low',
    title: 'Uppercase the line',
    keywords: ['uppercase', 'upper case', 'capitals', 'capitalise', 'capitalize'],
    teaches: ['toupper per character', 'writing into a copy'],
    note: 'Only a-z change; digits, spaces and punctuation pass through untouched.',
    cost: 'O(n)',
    defaultPrompt: 'convert a string to uppercase',
    fns: {
      to_upper: `void to_upper(char *s) {
  int i;
  for (i = 0; s[i] != 0; i++) s[i] = (char)toupper(s[i]);
}`,
    },
    decls: ['  char up[MAXL];'],
    lines: () => [
      '  strncpy(up, line, MAXL - 1);',
      '  up[MAXL - 1] = 0;',
      '  to_upper(up);',
      '  printf("uppercase: %s\\n", up);',
    ],
    expect: (v) => [`uppercase: ${v.text.toUpperCase()}`],
  },
  {
    id: 'word-count',
    family: 'text',
    level: 'low',
    title: 'Word count',
    keywords: ['word count', 'count the words', 'how many words', 'number of words', 'words'],
    teaches: ['an in-word flag instead of a lookahead', 'isspace from ctype'],
    note: 'The in-word flag counts a run of letters once, so repeated spaces cannot inflate the count.',
    cost: 'O(n)',
    defaultPrompt: 'count the words in a sentence',
    fns: {
      count_words: `int count_words(const char *s) {
  int i;
  int in = 0;
  int w = 0;
  for (i = 0; s[i] != 0; i++) {
    if (isspace(s[i])) in = 0;
    else if (!in) { in = 1; w++; }
  }
  return w;
}`,
    },
    lines: () => ['  printf("words: %d\\n", count_words(line));'],
    expect: (v) => [`words: ${wordsOf(v.text).length}`],
  },
  {
    id: 'char-frequency',
    family: 'text',
    level: 'advanced',
    title: 'Most common letter',
    keywords: ['most common letter', 'most frequent', 'frequency', 'letter frequency', 'character count'],
    teaches: ['a 26-slot histogram', 'first-wins tie-breaking'],
    note: 'Ties go to the alphabetically first letter because the scan only replaces the winner on a strict increase.',
    cost: 'O(n + 26)',
    defaultPrompt: 'find the most common letter in a sentence',
    fns: {
      most_common: `char most_common(const char *s, int *count) {
  int freq[26];
  int i;
  int best = 0;
  for (i = 0; i < 26; i++) freq[i] = 0;
  for (i = 0; s[i] != 0; i++) {
    char c = (char)tolower(s[i]);
    if (c >= 'a' && c <= 'z') freq[c - 'a']++;
  }
  for (i = 1; i < 26; i++) if (freq[i] > freq[best]) best = i;
  *count = freq[best];
  return (char)('a' + best);
}`,
    },
    decls: ['  int letterCount = 0;', '  char letter = 0;'],
    lines: () => [
      '  letter = most_common(line, &letterCount);',
      '  printf("most common letter: %c (%d times)\\n", letter, letterCount);',
    ],
    expect: (v) => {
      const { letter, count } = mostCommonOf(v.text);
      return [`most common letter: ${letter} (${count} times)`];
    },
  },
  {
    id: 'caesar',
    family: 'text',
    level: 'advanced',
    title: 'Caesar shift',
    keywords: ['caesar', 'caesar cipher', 'shift', 'cipher', 'rot13'],
    teaches: ['modular arithmetic that stays in range', 'separate handling for A-Z and a-z'],
    note: 'The shift is normalised with ((k % 26) + 26) % 26, so even a negative k still lands inside the alphabet.',
    cost: 'O(n)',
    demoShift: 3,
    defaultPrompt: 'a caesar cipher with a shift of 3',
    fns: {
      caesar_shift: `void caesar_shift(char *s, int k) {
  int i;
  k = ((k % 26) + 26) % 26;
  for (i = 0; s[i] != 0; i++) {
    char c = s[i];
    if (c >= 'a' && c <= 'z') s[i] = (char)('a' + (c - 'a' + k) % 26);
    else if (c >= 'A' && c <= 'Z') s[i] = (char)('A' + (c - 'A' + k) % 26);
  }
}`,
    },
    decls: ['  char enc[MAXL];'],
    lines: (p) => [
      '  strncpy(enc, line, MAXL - 1);',
      '  enc[MAXL - 1] = 0;',
      `  caesar_shift(enc, ${p.shift});`,
      `  printf("caesar shift ${p.shift}: %s\\n", enc);`,
    ],
    expect: (v) => [`caesar shift ${v.shift}: ${caesarOf(v.text, v.shift)}`],
  },
  {
    id: 'rle',
    family: 'text',
    level: 'advanced',
    title: 'Run-length encoding',
    keywords: ['run length', 'run-length', 'rle', 'compress runs', 'repeat count'],
    teaches: ['counting a run without an array', 'advancing by the run length'],
    note: 'The outer loop advances by the run length, so each character is visited once and the encoding is produced in order.',
    cost: 'O(n)',
    defaultPrompt: 'run-length encode a string',
    fns: {
      print_rle: `void print_rle(const char *s) {
  int i = 0;
  while (s[i] != 0) {
    int run = 1;
    while (s[i + run] == s[i]) run++;
    printf("%c%d", s[i], run);
    i += run;
  }
}`,
    },
    lines: () => [
      '  printf("rle: ");',
      '  print_rle(line);',
      '  printf("\\n");',
    ],
    expect: (v) => [`rle: ${rleOf(v.text)}`],
  },
  {
    id: 'longest-word',
    family: 'text',
    level: 'advanced',
    title: 'Longest word',
    keywords: ['longest word', 'shortest word', 'biggest word', 'length of a word'],
    teaches: ['scan words by hand', 'copy a slice into a bounded buffer'],
    note: 'The first of equal-length words wins, which makes the answer independent of any sort.',
    cost: 'O(n)',
    defaultPrompt: 'find the longest word in a sentence',
    fns: {
      longest_word: `void longest_word(const char *s, char *out, int cap) {
  int i = 0;
  int best = 0;
  int bestStart = 0;
  int start;
  int len;
  while (s[i] != 0) {
    while (s[i] != 0 && isspace(s[i])) i++;
    start = i;
    while (s[i] != 0 && !isspace(s[i])) i++;
    len = i - start;
    if (len > best) { best = len; bestStart = start; }
  }
  if (best > cap - 1) best = cap - 1;
  for (i = 0; i < best; i++) out[i] = s[bestStart + i];
  out[best] = 0;
}`,
    },
    decls: ['  char longest[MAXL];'],
    lines: () => [
      '  longest_word(line, longest, MAXL);',
      '  printf("longest word: %s (%d)\\n", longest, (int)strlen(longest));',
    ],
    expect: (v) => {
      const word = longestWordOf(v.text);
      return [`longest word: ${word} (${word.length})`];
    },
  },

  // ---------------------------------------------------------------- matrix
  {
    id: 'transpose',
    family: 'matrix',
    level: 'advanced',
    title: 'Matrix transpose',
    keywords: ['transpose', 'transposed', 'flip rows and columns', 'rows into columns'],
    teaches: ['swapping indices t[j][i] = m[i][j]', 'two-dimensional array parameters'],
    note: 'The destination is indexed as t[j][i]; writing t[i][j] would produce a copy, not a transpose.',
    cost: 'O(N^2)',
    defaultPrompt: 'transpose a matrix',
    fns: {
      mat_transpose: `void mat_transpose(int t[N][N], int m[N][N]) {
  int i, j;
  for (i = 0; i < N; i++)
    for (j = 0; j < N; j++)
      t[j][i] = m[i][j];
}`,
    },
    decls: ['  int t[N][N];'],
    lines: () => [
      '  mat_transpose(t, m);',
      '  printf("transposed:\\n");',
      '  for (i = 0; i < N; i++) {',
      '    for (j = 0; j < N; j++) printf("%4d", t[i][j]);',
      '    printf("\\n");',
      '  }',
    ],
    expect: (v) => ['transposed:', ...transposeOf(v.matrix).map((row) => matrixRow(row))],
  },
  {
    id: 'matmul',
    family: 'matrix',
    level: 'advanced',
    title: 'Matrix multiply',
    keywords: ['multiply', 'multiplication', 'matrix product', 'matmul', 'matrix multiplication'],
    teaches: ['three nested loops', 'the row-by-column dot product'],
    note: 'The product is m x transpose(m), which is square by construction and keeps the demo output small.',
    cost: 'O(N^3)',
    defaultPrompt: 'multiply two matrices',
    fns: {
      mat_mul: `void mat_mul(int r[N][N], int a[N][N], int b[N][N]) {
  int i, j, k, s;
  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) {
      s = 0;
      for (k = 0; k < N; k++) s += a[i][k] * b[k][j];
      r[i][j] = s;
    }
  }
}`,
    },
    decls: ['  int t[N][N];', '  int r[N][N];'],
    lines: () => [
      '  for (i = 0; i < N; i++)',
      '    for (j = 0; j < N; j++)',
      '      t[j][i] = m[i][j];',
      '  mat_mul(r, m, t);',
      '  printf("m x transpose(m):\\n");',
      '  for (i = 0; i < N; i++) {',
      '    for (j = 0; j < N; j++) printf("%6d", r[i][j]);',
      '    printf("\\n");',
      '  }',
    ],
    expect: (v) => ['m x transpose(m):', ...matMul(v.matrix, transposeOf(v.matrix)).map((row) => matrixRow(row, 6))],
  },
  {
    id: 'diagonals',
    family: 'matrix',
    level: 'advanced',
    title: 'Diagonal sums',
    keywords: ['diagonal', 'diagonals', 'main diagonal', 'anti diagonal', 'trace'],
    teaches: ['square-matrix index symmetry', 'one pass for both diagonals'],
    note: 'The anti-diagonal column is N - 1 - i; the centre cell belongs to both diagonals, which is correct.',
    cost: 'O(N)',
    defaultPrompt: 'sum the diagonals of a matrix',
    fns: {},
    decls: ['  int dmain = 0;', '  int danti = 0;'],
    lines: () => [
      '  for (i = 0; i < N; i++) {',
      '    dmain += m[i][i];',
      '    danti += m[i][N - 1 - i];',
      '  }',
      '  printf("main diagonal sum: %d\\n", dmain);',
      '  printf("anti diagonal sum: %d\\n", danti);',
    ],
    expect: (v) => [
      `main diagonal sum: ${v.matrix.reduce((s, row, i) => s + row[i], 0)}`,
      `anti diagonal sum: ${v.matrix.reduce((s, row, i) => s + row[row.length - 1 - i], 0)}`,
    ],
  },

  // ---------------------------------------------------------------- scalar
  {
    id: 'even-odd',
    family: 'scalar',
    level: 'low',
    title: 'Even or odd',
    keywords: ['even', 'odd', 'even or odd', 'parity'],
    requires: ['number', 'whether', 'check', 'divisible'],
    teaches: ['the modulo parity test', 'a ternary in printf'],
    note: 'The sign does not matter: any remainder other than zero is odd, including for negative input.',
    cost: 'O(1)',
    demoN: 12,
    limitN: 999999,
    defaultPrompt: 'check whether a number is even or odd',
    fns: {},
    lines: () => ['  printf("%d is %s\\n", n, n % 2 == 0 ? "even" : "odd");'],
    expect: (v) => [`${v.n} is ${v.n % 2 === 0 ? 'even' : 'odd'}`],
  },
  {
    id: 'prime-check',
    family: 'scalar',
    level: 'low',
    title: 'Primality test',
    keywords: ['prime', 'primality', 'is prime', 'prime number'],
    teaches: ['trial division up to sqrt(n)', 'early exits'],
    note: 'The loop stops at i * i > n, which is the smallest divisor argument and keeps the test fast enough for interactive traces.',
    cost: 'O(sqrt n)',
    demoN: 97,
    limitN: 1000000000,
    defaultPrompt: 'check whether 97 is prime',
    fns: { is_prime: FN_IS_PRIME },
    lines: () => ['  printf("%d is %s\\n", n, is_prime(n) ? "prime" : "not prime");'],
    expect: (v) => [`${v.n} is ${isPrimeOf(v.n) ? 'prime' : 'not prime'}`],
  },
  {
    id: 'sieve',
    family: 'scalar',
    level: 'advanced',
    title: 'Primes up to N',
    keywords: ['primes up to', 'list primes', 'all primes', 'sieve', 'prime numbers up to'],
    teaches: ['reusing the primality test over a range', 'counting while printing'],
    note: 'This is the readable version: it reuses is_prime for every candidate instead of allocating a table. N is capped at 300 so the trace stays useful.',
    cost: 'O(n sqrt n)',
    demoN: 30,
    limitN: 300,
    defaultPrompt: 'list all primes up to 30',
    fns: { is_prime: FN_IS_PRIME },
    decls: ['  int primes = 0;'],
    lines: () => [
      '  printf("primes up to %d:", n);',
      '  for (i = 2; i <= n; i++) {',
      '    if (is_prime(i)) { printf(" %d", i); primes++; }',
      '  }',
      '  printf("\\n");',
      '  printf("primes found: %d\\n", primes);',
    ],
    expect: (v) => [`primes up to ${v.n}: ${primesUpToOf(v.n).join(' ')}`, `primes found: ${primesUpToOf(v.n).length}`],
  },
  {
    id: 'prime-factors',
    family: 'scalar',
    level: 'advanced',
    title: 'Prime factorization',
    keywords: ['factor', 'factors', 'factorization', 'prime factors', 'factorise', 'factorize'],
    teaches: ['divide out each factor and continue', 'the leftover prime above sqrt(n)'],
    note: 'After the loop only one factor can remain above sqrt(n); the final n > 1 line prints it.',
    cost: 'O(sqrt n)',
    demoN: 84,
    limitN: 1000000000,
    defaultPrompt: 'the prime factors of 84',
    fns: {
      print_factors: `void print_factors(int n) {
  int d;
  printf("prime factors of %d:", n);
  for (d = 2; d * d <= n; d++) {
    while (n % d == 0) { printf(" %d", d); n /= d; }
  }
  if (n > 1) printf(" %d", n);
  printf("\\n");
}`,
    },
    lines: () => ['  print_factors(n);'],
    expect: (v) => {
      let rest = v.n;
      const factors = [];
      for (let d = 2; d * d <= rest; d += 1) {
        while (rest % d === 0) {
          factors.push(d);
          rest /= d;
        }
      }
      if (rest > 1) factors.push(rest);
      return [`prime factors of ${v.n}: ${factors.join(' ')}`];
    },
  },
  {
    id: 'factorial',
    family: 'scalar',
    level: 'advanced',
    title: 'Factorial',
    keywords: ['factorial', 'factorion', 'n!'],
    teaches: ['accumulate in long long', 'the 20! trace limit'],
    note: '20! is the largest factorial that fits in a signed 64-bit integer, so N is clamped to 20 before the loop.',
    cost: 'O(n)',
    demoN: 6,
    limitN: 20,
    defaultPrompt: 'the factorial of 6',
    fns: {
      factorial_of: `long long factorial_of(int n) {
  long long f = 1;
  int i;
  for (i = 2; i <= n; i++) f *= i;
  return f;
}`,
    },
    lines: () => ['  printf("%d! = %lld\\n", n, factorial_of(n));'],
    expect: (v) => [`${v.n}! = ${factorialOf(v.n)}`],
  },
  {
    id: 'fibonacci',
    family: 'scalar',
    level: 'advanced',
    title: 'Fibonacci sequence',
    keywords: ['fibonacci', 'fib', 'fibonacci sequence', 'fibonacci numbers'],
    teaches: ['two-value iteration without recursion', 'long long accumulation'],
    note: 'The sequence is iterative: no call depth, and the first N terms are printed as they are produced.',
    cost: 'O(n)',
    demoN: 10,
    limitN: 30,
    defaultPrompt: 'the first 10 fibonacci numbers',
    fns: {},
    decls: ['  long long fa = 0;', '  long long fb = 1;', '  long long ft = 0;'],
    lines: () => [
      '  printf("fibonacci (%d terms):", n);',
      '  for (i = 0; i < n; i++) {',
      '    printf(" %lld", fa);',
      '    ft = fa + fb;',
      '    fa = fb;',
      '    fb = ft;',
      '  }',
      '  printf("\\n");',
    ],
    expect: (v) => [`fibonacci (${v.n} terms): ${fibonacciOf(v.n).join(' ')}`],
  },
  {
    id: 'gcd-lcm',
    family: 'scalar',
    level: 'advanced',
    title: 'GCD and LCM',
    keywords: ['gcd', 'hcf', 'greatest common divisor', 'lcm', 'least common multiple', 'lowest common multiple'],
    teaches: ['Euclid\'s algorithm', 'lcm from gcd without overflow'],
    note: 'lcm is computed as n / g * m, not n * m / g: dividing first keeps the intermediate value inside 64 bits.',
    cost: 'O(log min(n, m))',
    needsM: true,
    demoN: 48,
    demoM: 18,
    limitN: 1000000000,
    limitM: 1000000000,
    defaultPrompt: 'the gcd and lcm of 48 and 18',
    fns: { gcd: FN_GCD },
    decls: ['  int g = 0;'],
    lines: () => [
      '  g = gcd(n, m);',
      '  printf("gcd(%d, %d) = %d\\n", n, m, g);',
      '  if (g == 0) printf("lcm(%d, %d) = 0\\n", n, m);',
      '  else printf("lcm(%d, %d) = %lld\\n", n, m, (long long)n / g * m);',
    ],
    expect: (v) => {
      const g = gcdOf(v.n, v.m);
      return [
        `gcd(${v.n}, ${v.m}) = ${g}`,
        g === 0 ? `lcm(${v.n}, ${v.m}) = 0` : `lcm(${v.n}, ${v.m}) = ${(v.n / g) * v.m}`,
      ];
    },
  },
  {
    id: 'reverse-digits',
    family: 'scalar',
    level: 'low',
    title: 'Reverse the digits',
    keywords: ['reverse a number', 'reverse number', 'reverse the digits', 'reverse digits', 'digits reversed'],
    teaches: ['building a number digit by digit', 'integer division and modulo'],
    note: 'Trailing zeros disappear in the reversed number because the value, not the text, is reversed: 120 becomes 21.',
    cost: 'O(digits)',
    demoN: 12345,
    limitN: 1000000000,
    defaultPrompt: 'reverse the digits of 12345',
    fns: { reverse_number: FN_REVERSE_NUMBER },
    lines: () => ['  printf("reverse of %d: %d\\n", n, reverse_number(n));'],
    expect: (v) => [`reverse of ${v.n}: ${reverseNumberOf(v.n)}`],
  },
  {
    id: 'digit-sum',
    family: 'scalar',
    level: 'low',
    title: 'Digit sum',
    keywords: ['digit sum', 'sum of digits', 'sum of the digits', 'add the digits', 'digit sum of'],
    teaches: ['repeated modulo and division', 'a loop that consumes the number'],
    note: 'The function works on a copy of n, so the caller keeps its value.',
    cost: 'O(digits)',
    demoN: 9875,
    limitN: 1000000000,
    defaultPrompt: 'the sum of the digits of 9875',
    fns: {
      digit_sum: `int digit_sum(int n) {
  int s = 0;
  while (n > 0) { s += n % 10; n /= 10; }
  return s;
}`,
    },
    lines: () => ['  printf("digit sum of %d: %d\\n", n, digit_sum(n));'],
    expect: (v) => [`digit sum of ${v.n}: ${digitSumOf(v.n)}`],
  },
  {
    id: 'digit-count',
    family: 'scalar',
    level: 'low',
    title: 'Digit count',
    keywords: ['number of digits', 'count the digits', 'digit count', 'how many digits'],
    teaches: ['counting digits without a log', 'the zero special case'],
    note: 'Zero is special-cased to one digit; the loop alone would answer zero.',
    cost: 'O(digits)',
    demoN: 9875,
    limitN: 1000000000,
    defaultPrompt: 'count the digits of 9875',
    fns: { digit_count: FN_DIGIT_COUNT },
    lines: () => ['  printf("digits in %d: %d\\n", n, digit_count(n));'],
    expect: (v) => [`digits in ${v.n}: ${digitCountOf(v.n)}`],
  },
  {
    id: 'armstrong',
    family: 'scalar',
    level: 'advanced',
    title: 'Armstrong number',
    keywords: ['armstrong', 'narcissistic', 'self number'],
    teaches: ['digit count first, then powers', 'sum of powers equals the number'],
    note: 'The digit count is computed before the sum because every digit is raised to that count.',
    cost: 'O(digits^2)',
    demoN: 153,
    limitN: 1000000000,
    defaultPrompt: 'check whether 153 is an armstrong number',
    fns: {
      is_armstrong: `int is_armstrong(int n) {
  int digits = digit_count(n);
  int t = n;
  int total = 0;
  while (t > 0) {
    int d = t % 10;
    int p = 1;
    int i;
    for (i = 0; i < digits; i++) p *= d;
    total += p;
    t /= 10;
  }
  return total == n;
}`,
      digit_count: FN_DIGIT_COUNT,
    },
    lines: () => ['  printf("%d %s an Armstrong number\\n", n, is_armstrong(n) ? "is" : "is not");'],
    expect: (v) => [`${v.n} ${isArmstrongOf(v.n) ? 'is' : 'is not'} an Armstrong number`],
  },
  {
    id: 'number-palindrome',
    family: 'scalar',
    level: 'advanced',
    title: 'Palindromic number',
    keywords: ['palindrome number', 'number palindrome', 'palindromic number', 'number is a palindrome'],
    teaches: ['reusing the digit reversal', 'comparing values, not strings'],
    note: 'The number is reversed arithmetically, so leading zeros are not part of the comparison.',
    cost: 'O(digits)',
    demoN: 12321,
    limitN: 1000000000,
    defaultPrompt: 'check whether 12321 is a palindrome number',
    fns: {
      reverse_number: FN_REVERSE_NUMBER,
      is_num_palindrome: `int is_num_palindrome(int n) {
  return n == reverse_number(n);
}`,
    },
    lines: () => ['  printf("%d %s a palindrome number\\n", n, is_num_palindrome(n) ? "is" : "is not");'],
    expect: (v) => [`${v.n} ${isNumPalindromeOf(v.n) ? 'is' : 'is not'} a palindrome number`],
  },
  {
    id: 'binary',
    family: 'scalar',
    level: 'advanced',
    title: 'Decimal to binary',
    keywords: ['binary', 'to binary', 'binary representation', 'decimal to binary'],
    teaches: ['collecting bits into an array', 'printing in reverse collection order'],
    note: 'Bits are collected least-significant first and printed from the top of the stack, which is why the array exists.',
    cost: 'O(log n)',
    demoN: 42,
    limitN: 1000000000,
    defaultPrompt: 'print 42 in binary',
    fns: {
      print_binary: `void print_binary(int n) {
  int bits[32];
  int used = 0;
  int t = n;
  if (t == 0) bits[used++] = 0;
  while (t > 0) {
    bits[used++] = t % 2;
    t /= 2;
  }
  while (used > 0) {
    used--;
    printf("%d", bits[used]);
  }
}`,
    },
    lines: () => ['  printf("binary of %d: ", n);', '  print_binary(n);', '  printf("\\n");'],
    expect: (v) => [`binary of ${v.n}: ${v.n.toString(2)}`],
  },
  {
    id: 'count-bits',
    family: 'scalar',
    level: 'advanced',
    title: 'Count set bits',
    keywords: ['set bits', 'count bits', 'bit count', 'popcount', 'number of ones', 'hamming weight'],
    teaches: ['the Kernighan v & (v - 1) trick', 'one pass per set bit'],
    note: 'Each step clears exactly one set bit, so the loop runs popcount(n) times, not 32.',
    cost: 'O(popcount n)',
    demoN: 42,
    limitN: 1000000000,
    defaultPrompt: 'count the set bits in 42',
    fns: {
      popcount: `int popcount(int n) {
  int count = 0;
  int t = n;
  while (t > 0) {
    t = t & (t - 1);
    count++;
  }
  return count;
}`,
    },
    lines: () => ['  printf("set bits in %d: %d\\n", n, popcount(n));'],
    expect: (v) => [`set bits in ${v.n}: ${v.n.toString(2).split('').filter((c) => c === '1').length}`],
  },
  {
    id: 'power',
    family: 'scalar',
    level: 'advanced',
    title: 'Integer power',
    keywords: ['power', 'exponent', 'raised to', 'to the power', 'pow'],
    teaches: ['repeated multiplication in long long', 'an exponent bound before overflow'],
    note: 'The exponent is clamped to 15 so the 64-bit result stays printable and comparable with the expectation.',
    cost: 'O(exp)',
    needsM: true,
    demoN: 2,
    demoM: 10,
    limitN: 20,
    limitM: 15,
    defaultPrompt: '2 to the power of 10',
    fns: {
      ipow: `long long ipow(int base, int exp) {
  long long r = 1;
  int i;
  for (i = 0; i < exp; i++) r *= base;
  return r;
}`,
    },
    lines: () => ['  printf("%d ^ %d = %lld\\n", n, m, ipow(n, m));'],
    expect: (v) => [`${v.n} ^ ${v.m} = ${Math.pow(v.n, v.m)}`],
  },
  {
    id: 'times-table',
    family: 'scalar',
    level: 'low',
    title: 'Multiplication table',
    keywords: ['multiplication table', 'times table', 'table of'],
    teaches: ['a loop that prints one full row per step', 'the n x i shape'],
    note: 'Every row prints its own product; the table is capped at 12 rows so the trace stays readable.',
    cost: 'O(n)',
    demoN: 5,
    limitN: 12,
    defaultPrompt: 'the multiplication table of 5',
    fns: {},
    lines: () => [
      '  for (i = 1; i <= n; i++) printf("%d x %d = %d\\n", n, i, n * i);',
    ],
    expect: (v) => Array.from({ length: v.n }, (_, k) => `${v.n} x ${k + 1} = ${v.n * (k + 1)}`),
  },
  {
    id: 'fizzbuzz',
    family: 'scalar',
    level: 'low',
    title: 'FizzBuzz',
    keywords: ['fizzbuzz', 'fizz buzz', 'fizz'],
    teaches: ['the order of the divisible checks', 'the 15 rule before 3 and 5'],
    note: 'The combined case is tested first: testing 3 before 15 would print Fizz where FizzBuzz belongs.',
    cost: 'O(n)',
    demoN: 15,
    limitN: 30,
    defaultPrompt: 'fizzbuzz up to 15',
    fns: {},
    lines: () => [
      '  for (i = 1; i <= n; i++) {',
      '    if (i % 15 == 0) printf("FizzBuzz\\n");',
      '    else if (i % 3 == 0) printf("Fizz\\n");',
      '    else if (i % 5 == 0) printf("Buzz\\n");',
      '    else printf("%d\\n", i);',
      '  }',
    ],
    expect: (v) => fizzbuzzOf(v.n),
  },
  {
    id: 'collatz',
    family: 'scalar',
    level: 'advanced',
    title: 'Collatz sequence',
    keywords: ['collatz', 'hailstone', '3n+1'],
    teaches: ['a terminating loop with a hard guard', 'long long to hold the peaks'],
    note: 'The loop stops at 200 steps even if the sequence has not reached 1, so a conjecture failure cannot hang the sandbox.',
    cost: 'O(steps)',
    demoN: 6,
    limitN: 1000000,
    defaultPrompt: 'the collatz sequence for 6',
    fns: {},
    decls: ['  long long c = 0;', '  int steps = 0;'],
    lines: () => [
      '  c = n;',
      '  printf("collatz %d:", n);',
      '  while (c != 1 && steps < 200) {',
      '    printf(" %lld", c);',
      '    if (c % 2 == 0) c = c / 2;',
      '    else c = 3 * c + 1;',
      '    steps++;',
      '  }',
      '  printf(" %lld\\n", c);',
      '  printf("steps: %d\\n", steps);',
    ],
    expect: (v) => {
      const chain = collatzOf(v.n);
      return [`collatz ${v.n}: ${chain.join(' ')}`, `steps: ${chain.length - 1}`];
    },
  },
  {
    id: 'leap-year',
    family: 'scalar',
    level: 'low',
    title: 'Leap year',
    keywords: ['leap year', 'leap-year', 'leap'],
    teaches: ['the 4 / 100 / 400 rule', 'short-circuit boolean operators'],
    note: 'Divisible by 4 but not 100, or divisible by 400 - the order of the tests keeps 1900 out and 2000 in.',
    cost: 'O(1)',
    demoN: 2024,
    limitN: 9999,
    defaultPrompt: 'check whether 2024 is a leap year',
    fns: {
      is_leap: `int is_leap(int year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}`,
    },
    lines: () => ['  printf("%d: %s\\n", n, is_leap(n) ? "leap year" : "not a leap year");'],
    expect: (v) => [`${v.n}: ${(v.n % 4 === 0 && v.n % 100 !== 0) || v.n % 400 === 0 ? 'leap year' : 'not a leap year'}`],
  },
  {
    id: 'sum-to-n',
    family: 'scalar',
    level: 'low',
    title: 'Sum from 1 to N',
    keywords: ['sum of the first', 'sum 1 to', 'sum from 1', 'sum of numbers up to', 'add 1 to', 'numbers from 1'],
    teaches: ['the closed form n(n+1)/2', 'widening before multiplying'],
    note: 'The cast to long long happens before the multiplication: n * (n + 1) in int would overflow above 46340.',
    cost: 'O(1)',
    demoN: 100,
    limitN: 1000000000,
    nFromLast: true,
    defaultPrompt: 'the sum of the numbers from 1 to 100',
    fns: {},
    lines: () => ['  printf("sum 1..%d = %lld\\n", n, (long long)n * (n + 1) / 2);'],
    expect: (v) => [`sum 1..${v.n} = ${(v.n * (v.n + 1)) / 2}`],
  },
  {
    id: 'hanoi',
    family: 'scalar',
    level: 'advanced',
    title: 'Tower of Hanoi',
    keywords: ['tower of hanoi', 'hanoi', 'towers of hanoi'],
    teaches: ['recursion with three pegs', 'the 2^n - 1 move count'],
    note: 'The moves are printed as they are made, and the counter is passed by pointer so every recursive call updates one total.',
    cost: 'O(2^n)',
    demoN: 3,
    limitN: 6,
    defaultPrompt: 'solve the tower of hanoi with 3 disks',
    fns: {
      hanoi: `void hanoi(int d, char from, char to, char via, int *moves) {
  if (d == 0) return;
  hanoi(d - 1, from, via, to, moves);
  (*moves)++;
  printf("move disk %d: %c -> %c\\n", d, from, to);
  hanoi(d - 1, via, to, from, moves);
}`,
    },
    decls: ['  int moves = 0;'],
    lines: () => [
      "  hanoi(n, 'A', 'C', 'B', &moves);",
      '  printf("total moves: %d\\n", moves);',
    ],
    expect: (v) => [...hanoiOf(v.n), `total moves: ${hanoiOf(v.n).length}`],
  },
];

export const FAMILIES = {
  ints: {
    label: 'integer array',
    article: 'an',
    input: 'reads integers from stdin into a bounded array (MAXN = 100), falling back to an announced 8-value demo',
    testStdin: TEST_INTS.join(' '),
    hazards: [
      'Input stops at MAXN = 100 values; extra numbers stay unread on stdin.',
      'The demo fallback is announced in the output, so a run with no input never pretends it saw your data.',
      'Every loop is bounded by n or by a constant trace limit, so the step budget cannot be hit by input size alone.',
    ],
  },
  text: {
    label: 'line of text',
    article: 'a',
    input: 'reads one line with fgets into a 160-byte buffer, trims the newline, and falls back to an announced demo sentence',
    testStdin: TEST_TEXT,
    hazards: [
      'A line longer than 159 characters is truncated at the buffer bound, and the program cannot tell you it happened.',
      'len is an int cast from strlen because size_t is an int alias in the M2 subset.',
      'The checks are byte-wise and ASCII-only; a multi-byte character counts as several bytes.',
    ],
  },
  matrix: {
    label: '3x3 matrix',
    article: 'a',
    input: 'uses a fixed 3x3 integer matrix so the trace is short and every product is visible',
    testStdin: '',
    hazards: [
      'N is fixed at 3 so the demo stays readable; the loops are written in terms of N, not hard-coded 3s.',
      'Matrix multiply computes m x transpose(m), which is square by construction.',
      'The values are small integers chosen to keep every product inside a 32-bit int.',
    ],
  },
  scalar: {
    label: 'scalar N',
    article: 'a',
    input: 'reads N (and M for the two-number tasks) from stdin, clamps it to the block trace limit, and announces both a missing input and any clamp',
    testStdin: `${TEST_N} ${TEST_M}`,
    hazards: [
      'N is clamped to the strictest selected block before any loop runs, and the output says when it clamps.',
      'long long results are printed with %lld; 20! is the largest factorial the composer allows.',
      'The demo fallback is announced, so an empty stdin never looks like real input.',
    ],
  },
};

// ------------------------------------------------------------------- matching

const STOP = new Set([
  'a', 'an', 'the', 'me', 'please', 'write', 'create', 'make', 'build', 'generate', 'implement',
  'code', 'program', 'programme', 'c', 'in', 'into', 'using', 'use', 'with', 'for', 'to', 'of',
  'that', 'which', 'and', 'or', 'my', 'i', 'want', 'need', 'should', 'can', 'you', 'it', 'is',
  'some', 'simple', 'small', 'example', 'sample', 'from', 'read', 'reads', 'given', 'print',
  'prints', 'output', 'return', 'returns', 'them', 'these', 'those', 'value', 'values',
]);

const normalise = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9+#-]+/g, ' ').trim();
const wordSet = (text) => new Set(normalise(text).split(' ').filter((w) => w && !STOP.has(w)));
const clampInt = (value, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(value) || 0)));
const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Only a brief that actually joins clauses may compose several blocks. Without
 * this, "binary search a sorted array" would also drag in the ascending sort
 * because both mention "sorted".
 */
const MULTI_CUE = /\band\b|\bthen\b|\balso\b|\bplus\b|;|,/i;

/**
 * Score a block against the brief. Two refinements over "count the keywords":
 * a keyword contained in a longer matched keyword does not count twice
 * ("sum" inside "sum of"), and ties prefer the more specific phrase, so
 * "the sum of the digits" picks the digit-sum block, not the array sum.
 */
function scoreTask(task, lower, words, preferredLevel) {
  // Some blocks share a word with a near-namesake ("even" counts vs "is it
  // even"). `requires` makes the input-family context part of the match.
  if (task.requires && !task.requires.some((need) => (need.includes(' ') ? lower.includes(need) : words.has(need)))) {
    return { score: 0, matched: [], specificity: 0, at: Infinity, rank: 0 };
  }
  const matches = [];
  for (const keyword of task.keywords) {
    if (keyword.includes(' ')) {
      const at = lower.indexOf(keyword);
      if (at >= 0) matches.push({ keyword, weight: 3, at });
    } else if (words.has(keyword)) {
      const found = new RegExp(`(?:^| )${escapeRe(keyword)}(?= |$)`).exec(lower);
      matches.push({ keyword, weight: 2, at: found ? found.index : 0 });
    } else {
      for (const word of words) {
        // Only an inflected form of the keyword counts ("sorted" for "sort",
        // "duplicates" for "duplicate"); a shorter word inside a longer keyword
        // ("sort" inside "sorted") is not evidence that the keyword is present.
        const plural = keyword.endsWith('s') && keyword.slice(0, -1) === word;
        if (word.length >= 4 && keyword.length >= 4 && (word.startsWith(keyword) || plural)) {
          matches.push({ keyword, weight: 1, at: lower.indexOf(word) });
          break;
        }
      }
    }
  }
  const kept = matches
    .filter((m) => !matches.some((other) => other !== m && other.keyword.length > m.keyword.length && other.weight >= m.weight && other.keyword.includes(m.keyword)))
    .sort((a, b) => b.weight - a.weight || b.keyword.length - a.keyword.length);
  const score = kept.reduce((total, m) => total + m.weight, 0);
  const specificity = kept.reduce((max, m) => Math.max(max, m.keyword.length), 0);
  return {
    score,
    matched: [...new Set(kept.map((m) => m.keyword))],
    specificity,
    at: kept.length ? Math.min(...kept.map((m) => m.at)) : Infinity,
    rank: score + (preferredLevel && task.level === preferredLevel ? 2 : 0),
  };
}

/** Two blocks that matched the same words are one request, not two steps. */
const overlaps = (a, b) => a.matched.some((x) => b.matched.some((y) => x.includes(y) || y.includes(x)));

function extractNumbers(text) {
  return (normalise(text).match(/\d{1,9}/g) || []).map(Number).filter((n) => n <= 999999999);
}

// ---------------------------------------------------------------- assembly

const cLiteral = (text) => `"${String(text)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\r/g, '\\r')
  .replace(/\n/g, '\\n')
  .replace(/\t/g, '\\t')}"`;

const cFormatSafe = (text) => String(text).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"');

const includesFor = (selected) => {
  const wanted = new Set(['stdio.h']);
  for (const task of selected) for (const header of task.includes || []) wanted.add(header);
  return [...wanted].map((header) => `#include <${header}>`).join('\n');
};

function assemble(selected, params, meta) {
  const family = selected[0].family;
  const functions = new Map();
  for (const task of selected) {
    for (const [name, code] of Object.entries(task.fns || {})) functions.set(name, code);
  }
  const decls = [...new Set(selected.flatMap((task) => task.decls || []))];
  const lines = selected.flatMap((task) => task.lines({
    target: params.target,
    shift: params.shift,
  }));
  const title = meta.title;
  const header = [
    `/* SINGU composer - ${title}.`,
    `   ${meta.summary}`,
    '   Blocks are independent of the shared input, so the order of the steps',
    '   cannot change any result. Emitted for the M2 C-subset interpreter. */',
  ].join('\n');
  const includeBlock = includesFor(selected);
  const fnBlock = [...functions.values()].join('\n\n');
  const declBlock = decls.length ? '\n' + decls.join('\n') : '';
  const body = lines.join('\n');
  const titleLine = `  printf("composer: ${cFormatSafe(title)}\\n");`;

  if (family === 'ints') {
    return `${header}
${includeBlock}

#define MAXN 100
#define DEMO_N ${DEMO_INTS.length}

${fnBlock}

int main(void) {
  int a[MAXN];
  int n = 0;
  int i;
  int x;
  int demo[DEMO_N] = {${DEMO_INTS.join(', ')}};${declBlock}
${titleLine}
  while (n < MAXN && scanf("%d", &x) == 1) a[n++] = x;
  if (n == 0) {
    for (i = 0; i < DEMO_N; i++) a[i] = demo[i];
    n = DEMO_N;
    printf("no input: using the %d-value demo array\\n", n);
  }
  printf("values (%d):", n);
  for (i = 0; i < n; i++) printf(" %d", a[i]);
  printf("\\n");
${body}
  printf("composer: ${selected.length} step(s) complete\\n");
  return 0;
}
`;
  }

  if (family === 'text') {
    return `${header}
${includeBlock}
#include <string.h>
#include <ctype.h>

#define MAXL 160

${fnBlock}

int main(void) {
  char line[MAXL];
  char demo[MAXL] = ${cLiteral(DEMO_TEXT)};
  int len;
  int i;${declBlock}
${titleLine}
  if (fgets(line, MAXL, stdin) == NULL) {
    strncpy(line, demo, MAXL - 1);
    line[MAXL - 1] = 0;
    printf("no input: using the demo line\\n");
  }
  len = (int)strlen(line);
  while (len > 0 && (line[len - 1] == '\\n' || line[len - 1] == '\\r')) line[--len] = 0;
  printf("line (%d chars): %s\\n", len, line);
${body}
  printf("composer: ${selected.length} step(s) complete\\n");
  return 0;
}
`;
  }

  if (family === 'matrix') {
    const rows = DEMO_MATRIX.map((row) => `{${row.join(', ')}}`).join(', ');
    return `${header}
${includeBlock}

#define N 3

${fnBlock}

int main(void) {
  int m[N][N] = {${rows}};
  int i;
  int j;${declBlock}
${titleLine}
  printf("matrix:\\n");
  for (i = 0; i < N; i++) {
    for (j = 0; j < N; j++) printf("%4d", m[i][j]);
    printf("\\n");
  }
${body}
  printf("composer: ${selected.length} step(s) complete\\n");
  return 0;
}
`;
  }

  const n0 = params.n;
  const m0 = params.m;
  const readLines = [
    '  if (scanf("%d", &n) != 1) {',
    `    n = ${n0};`,
    '    printf("no input: using N = %d\\n", n);',
    '  }',
  ];
  if (params.needsM) {
    readLines.push(
      '  if (scanf("%d", &m) != 1) m = ' + m0 + ';',
      '  printf("M = %d\\n", m);',
    );
  }
  readLines.push(
    '  if (n < 0) n = 0;',
    `  if (n > ${params.limitN}) { printf("N %d is above the trace limit; using ${params.limitN}\\n", n); n = ${params.limitN}; }`,
  );
  if (params.needsM) {
    readLines.push(
      '  if (m < 0) m = 0;',
      `  if (m > ${params.limitM}) { printf("M %d is above the trace limit; using ${params.limitM}\\n", m); m = ${params.limitM}; }`,
    );
  }
  readLines.push('  printf("N = %d\\n", n);');
  return `${header}
${includeBlock}

${fnBlock}

int main(void) {
  int n = ${n0};
  int m = ${m0};
  int i;${declBlock}
${titleLine}
${readLines.join('\n')}
${body}
  printf("composer: ${selected.length} step(s) complete\\n");
  return 0;
}
`;
}

// ------------------------------------------------------------------ public

/**
 * Compose one program from the brief.
 * Returns null when no block keyword is present, so the caller can fall back to
 * the systems catalogue or its starter without inventing a task.
 */
export function compose(prompt, options = {}) {
  const text = String(prompt == null ? '' : prompt);
  const lower = normalise(text);
  const words = wordSet(text);
  if (!words.size) return null;
  const preferredLevel = options.level && options.level !== 'auto' ? options.level : null;

  const byRank = (a, b) => b.rank - a.rank || a.at - b.at || COMPOSER_TASKS.indexOf(a.task) - COMPOSER_TASKS.indexOf(b.task);
  const scored = COMPOSER_TASKS.map((task) => ({ task, ...scoreTask(task, lower, words, preferredLevel) }));
  let best = scored[0];
  for (const candidate of scored) {
    if (candidate.rank !== best.rank) {
      if (candidate.rank > best.rank) best = candidate;
    } else if (candidate.score !== best.score) {
      if (candidate.score > best.score) best = candidate;
    } else if (candidate.specificity !== best.specificity) {
      if (candidate.specificity > best.specificity) best = candidate;
    } else if (candidate.at < best.at) {
      best = candidate;
    }
  }
  if (best.score === 0) return null;

  const family = best.task.family;
  const canCompose = MULTI_CUE.test(text);
  const extras = [];
  if (canCompose) {
    const contenders = scored
      .filter((s) => s.task.family === family && s !== best && s.score >= 2)
      .sort(byRank);
    for (const candidate of contenders) {
      if (extras.length >= 3) break;
      if ([best, ...extras].some((chosen) => overlaps(chosen, candidate))) continue;
      extras.push(candidate);
    }
  }
  const chosen = [best, ...extras];
  const selected = COMPOSER_TASKS.filter((task) => chosen.some((s) => s.task === task));
  // One program reads one input family. A second family named in the same brief
  // is reported, not silently dropped.
  const aside = canCompose
    ? scored.filter((s) => s.task.family !== family && s.score >= 2).sort(byRank).slice(0, 3)
    : [];

  const nums = extractNumbers(text);
  const limitN = Math.min(...selected.map((task) => task.limitN ?? Infinity));
  const limitM = Math.min(...selected.map((task) => task.limitM ?? Infinity));
  const needsM = selected.some((task) => task.needsM);
  // "from 1 to 100" names the endpoint last, so sum-to-n binds the final number
  // rather than the lower bound it starts from.
  const nRaw = best.task.nFromLast && nums.length ? nums[nums.length - 1] : (nums[0] ?? best.task.demoN ?? 10);
  const n = clampInt(nRaw, 0, Number.isFinite(limitN) ? limitN : 1e9);
  const mDefault = best.task.demoM ?? selected.find((task) => task.demoM != null)?.demoM ?? 0;
  const mRaw = nums[1] ?? mDefault;
  const m = clampInt(mRaw, 0, Number.isFinite(limitM) ? limitM : 1e9);
  const target = clampInt(nums[0] ?? best.task.demoTarget ?? 23, 0, 1e9);
  const shift = clampInt(nums[0] ?? best.task.demoShift ?? 3, 1, 25);

  const titles = selected.map((task) => task.title);
  const title = titles.length === 1 ? titles[0] : titles.slice(0, -1).join(', ') + ' and ' + titles[titles.length - 1];
  const summary = `${titles.join('; ')} over ${FAMILIES[family].article} ${FAMILIES[family].label}. ${FAMILIES[family].input}.`;
  const demo = { ints: DEMO_INTS, text: DEMO_TEXT, matrix: DEMO_MATRIX, n, m, target, shift };
  const testValues = {
    ints: TEST_INTS,
    text: TEST_TEXT,
    matrix: DEMO_MATRIX,
    n: clampInt(TEST_N, 0, Number.isFinite(limitN) ? limitN : 1e9),
    m: clampInt(TEST_M, 0, Number.isFinite(limitM) ? limitM : 1e9),
    target,
    shift,
  };

  const meta = { title, summary };
  const code = assemble(selected, {
    n, m, target, shift, needsM, limitN: Number.isFinite(limitN) ? limitN : 1e9, limitM: Number.isFinite(limitM) ? limitM : 1e9,
  }, meta);

  const tests = [];
  if (family !== 'matrix') {
    tests.push({ name: 'demo (no stdin)', stdin: '', expect: selected.flatMap((task) => task.expect(demo)) });
  }
  tests.push({
    name: 'stdin',
    stdin: FAMILIES[family].testStdin,
    expect: selected.flatMap((task) => task.expect(testValues)),
  });

  const confidence = Math.min(0.95, 0.55 + best.score * 0.05 + Math.max(0, selected.length - 1) * 0.05);
  const functions = new Set();
  for (const task of selected) for (const name of Object.keys(task.fns || {})) functions.add(name);

  const notes = selected.map((task) => `${task.title}: ${task.note}`);
  const hazards = [...FAMILIES[family].hazards];
  if (aside.length) {
    notes.push(
      `Detected but not emitted: ${aside.map((s) => s.task.title).join(', ')}. One program reads one input family (${FAMILIES[family].label}), so those steps need their own run.`,
    );
    hazards.push('Named steps from another input family are listed, not silently dropped; the emitted program covers one family only.');
  }

  const plan = [
    `Composer: recognised ${selected.map((task) => `"${task.title}"`).join(' + ')} in the brief.`,
    `Read ${FAMILIES[family].article} ${FAMILIES[family].label}: ${FAMILIES[family].input}.`,
    `Emit ${functions.size} helper(s) and one main; no block mutates the shared input, so step order cannot change a result.`,
    `Ship ${tests.length} acceptance test(s) with the program: the autopilot runs them without a model.`,
  ];
  if (aside.length) plan.push(`Report ${aside.map((s) => `"${s.task.title}"`).join(', ')} as a separate ${aside[0].task.family} brief instead of mixing input formats.`);

  const alternatives = [...aside, ...scored.filter((s) => !chosen.includes(s) && s.score > 0)]
    .sort((a, b) => b.score - a.score || COMPOSER_TASKS.indexOf(a.task) - COMPOSER_TASKS.indexOf(b.task))
    .slice(0, 3)
    .map(({ task }) => ({ title: task.title, prompt: task.defaultPrompt, level: task.level, engine: 'composer' }));

  return {
    engine: 'composer',
    ok: true,
    id: `composer:${selected.map((task) => task.id).join('+')}`,
    title,
    summary,
    level: best.task.level,
    confidence,
    matched: [...new Set(selected.flatMap((task) => scoreTask(task, lower, words, preferredLevel).matched))],
    family,
    steps: selected.map((task) => ({ id: task.id, title: task.title, level: task.level })),
    teaches: [...new Set(selected.flatMap((task) => task.teaches))],
    notes,
    hazards,
    aside: aside.map(({ task }) => ({ title: task.title, prompt: task.defaultPrompt, family: task.family, level: task.level })),
    complexity: [...new Set(selected.map((task) => task.cost))].join('; '),
    plan,
    code,
    params: { n, m, target, shift, limitN: Number.isFinite(limitN) ? limitN : 1e9, limitM: Number.isFinite(limitM) ? limitM : 1e9 },
    tests,
    defaultPrompt: best.task.defaultPrompt,
    alternatives,
  };
}

/** The block library, optionally filtered by family or level. */
export function browseComposer({ family, level } = {}) {
  return COMPOSER_TASKS
    .filter((task) => (!family || task.family === family) && (!level || task.level === level))
    .map((task) => ({
      id: task.id,
      family: task.family,
      level: task.level,
      title: task.title,
      defaultPrompt: task.defaultPrompt,
      keywords: [...task.keywords],
    }));
}
