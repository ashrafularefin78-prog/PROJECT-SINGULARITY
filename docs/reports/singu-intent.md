# SINGU intent model — trained, sized and measured 2026-11-01

A real trained network inside SINGU, with every published number read out of
the file it ships in. This is not a language model and does not pretend to be
one: it is a two-layer classifier — averaged embedding over hashed word and
character n-grams, then a linear softmax — that picks **which of the 15
catalogue patterns** a brief asks for. It cannot emit a line of C. The programs
still come from the hand-written generator in `src/assistant/singu.js`, so the
guarantee that SINGU's output compiles and runs is untouched by this file.

Artifact: [`singu-intent.bin`](../../assets/models/singu-intent.bin) (the weight
file the page fetches). This JSON is evidence, not a synced document:
`tools/check-docs.js` verifies the recorded hash and fails the build if the file
changes.
SHA-256: `43a7d0e9e6f749e00574fba346509f6bca2294c7343024b415ac3040f7e1ba3a`.

The digest is reproducible: the seed, corpus, typo stream and learning-rate
schedule are fixed and no timestamp is written into the weight file, so
`node tools/train-singu-model.js --sweep` rebuilds these exact bytes. If the
digest moves, the weights moved.

```powershell
node tools/train-singu-model.js --sweep            # writes the artifact and the JSON below
node tools/train-singu-model.js --sweep --json     # the same search, printed, writing nothing
```

| | |
|---|---|
| Shape | 2048 hashed feature rows × 16 hidden units → 16 classes (15 patterns + `__none__`) |
| Parameters | 33,040 parameters (32,768 embedding + 256 output + 16 bias), counted from the parsed file |
| File | 41,752 bytes, 40,312 bytes gzipped, int8 weights with per-row and per-column f32 scales |
| Training | 3,456 synthetic briefs, 160 epochs, SGD with weight decay 1e-4, seed 7 |
| Supervision | the catalogue's own keywords, titles, teach lines and default prompts |
| Held-out phrasings | 2,788 / 2,838 correct (10 unseen templates the model never trained on) |
| Held-out typos | 2,611 / 2,838 correct (the same briefs with one character edited) |
| Matcher baseline | 2276 / 2838 and 1718 / 2838 for the shipped keyword matcher on the same briefs |
| Cost | 0 wrong commitments on clean unseen phrasings, 52 on typo'd ones (the table below) |
| Inference | 0.015 ms median, 0.262 ms slowest of 2,838 briefs, quantized path, Node |

## What the model is actually for

`scoreRecipe` matches literal keywords. When it finds none and the composer
finds no task, SINGU has nothing to offer and says so. That silence is the only
place the model is consulted — see `plan()` in `src/assistant/planner.js`, and
note that a brief the matcher answered *wrongly* is deliberately left with the
matcher rather than overridden by the network.

Measured on exactly that population, the held-out briefs where the shipped
matcher returned no match at all:

| | clean phrasings | with typos |
|---|---|---|
| briefs the matcher was silent on | 341 | 820 |
| **pattern named correctly by the model** | **332** | **686** |
| named wrongly | 0 | 52 |
| declined (no pattern offered) | 9 | 108 |

So the net effect on the shipped page is 332 more answered briefs on unseen
phrasings and 686 more on typo'd ones, bought against 52 wrong picks. A wrong
pick here means the *right kind of program with the wrong teaching target* — it
still compiles and runs, because the generator was never bypassed.

## Why 33,040 and not a billion

The size search is in the report, all nine configurations, including the ones
that lost:

| dims × hidden | parameters | unseen phrasings | typos | gzipped |
|---|---|---|---|---|
| 1024 × 16 | 16,656 | 0.971459 | 0.883369 | 20,446 |
| **2048 × 16** | **33,040** | **0.982382** | **0.920014** | **40,312** |
| 2048 × 32 | 66,064 | 0.981677 | 0.916843 | 73,212 |
| 4096 × 32 | 131,600 | 0.982382 | 0.919662 | 145,718 |
| 4096 × 64 | 263,184 | 0.983791 | 0.920366 | 277,174 |
| 8192 × 32 | 262,672 | 0.981677 | 0.921776 | 290,409 |
| 8192 × 64 | 525,328 | 0.981677 | 0.924242 | 553,384 |
| 16384 × 128 | 2,099,216 | 0.982030 | 0.923538 | 2,152,449 |
| 16384 × 256 | 4,198,416 | 0.981325 | 0.923890 | 4,250,586 |

The shipped row is not the one with the best score. It is chosen by a rule
stated in `tools/train-singu-model.js`: *the smallest configuration whose worst
held-out score is within one standard error of the best* — here 0.006025, the
largest standard error among the nine rows, each of which is measured over 2,838
briefs. Seven of the nine configurations are inside that band. 4,198,416 parameters — 127 times the size — buy 0.0039 of a point on
the weaker held-out number, which is less than the measurement can resolve.

That is the honest answer to "make it a billion parameters": at this task, this
dataset and this architecture, parameters past ~33,000 are not accuracy, they
are bytes. The count is not a boast here; it is the output of a search that
could have picked a larger number and did not.

## What this does not mean

- **It cannot recognise a pattern the catalogue does not contain.** Supervision
  comes from the catalogue itself, so held-out accuracy measures generalisation
  to unseen *phrasings*, never to unseen *ideas*.
- **It is not a language model.** No vocabulary, no sampling, no generation, no
  context window. Its entire output is one of 16 class ids and their
  probabilities.
- **The 4-bit "500 MB" framing does not apply.** A billion parameters would be a
  ~500 MB int4 blob fetched over the same origin — `connect-src 'self'` permits
  same-origin fetches (the 18.4 MiB compiler toolchain is fetched that way), so
  the blocker was never the CSP. It is the 400 MB memory budget this page is
  measured against after one hour, and the fact that nothing in the size search
  above suggests a larger model would answer a single additional brief better.
- **`docs/NON_GOALS.md` no longer declares this a non-goal.** It did, on the
  strength of a CSP argument that was wrong; see the CHANGELOG entry for
  2026-11-01.
