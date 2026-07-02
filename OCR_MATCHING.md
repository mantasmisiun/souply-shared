# OCR-tolerant product-name matching

## Problem
ML Kit on Lithuanian thermal receipts makes **systematic visual misreads**, not random typos:
- **digit↔letter**: `RYŽIAI`→`RYZ14` (`1`←i, `4`←a), `SVIESTAS`→`5VIE5TAS` (`5`←s)
- **homoglyphs**: `0`↔`o`, `1`↔`l`, `8`↔`b`
- **multi-char shape collisions**: `BASMATI`→`BASMALL` (`ll`↔`ti`), `m`↔`rn`, `d`↔`cl`

A plain Levenshtein charges each of these the full cost of a wrong character, so a
correct-but-garbled name scores **below the match floor and never surfaces** — the line ends
up unmatched (and, under the no-mint policy, shown as OCR with no catalog link).

## Design (shipped, dev)
A **confusion-weighted edit distance as a gated rescue lane** in the matcher's whole-string
char lane. Diacritics are already NFD-folded upstream, so `ž→z` costs 0 for free.

- **`src/utils/ocrConfusions.ts`** — `weightedLevenshtein(a, b)`: a generalized weighted edit
  distance where known confusions are cheap (single-char `subCost` ~0.1–0.4; variable-length
  `MULTI` pairs like `ll↔ti` collapse at ~0.3–0.45). Seeded from the Unicode-confusables / OCR
  canon; **"Balanced"** set = digit↔letter + homoglyphs + common multi-char pairs.
- **`productMatcher.ts` `charSimilarity`** — two-tier: compute the PLAIN char similarity first;
  **only if `plainSim ≥ RECOGNITION.match.ocrRescueMinSim` (0.65)** recompute with the weighted
  distance. This is the precision guard.

### Why the rescue gate matters (the false-positive we prevented)
The confusion weighting is only allowed to help strings that are **already a near-miss** — a
garble of the *same* name. Measured on real fixtures:

| pair | plain | weighted | rescued? |
|---|---|---|---|
| `RYZ14 BASMALL` ↔ `ryžiai basmati` (same product) | 0.75 | **0.91** | ✅ ≥0.65 gate |
| apples-OCR `Fasuoti obuol ia1…` ↔ potatoes `Fasuotos bulvės…` (different, shared packaging) | 0.58 | 0.60 | ❌ <0.65 gate → stays plain |

Without the gate, the apples→potatoes pair nudged `0.577→0.604` — just across the `0.6`
`charScoreFloor` → a wrong match. The `0.65` gate (set between the false-positive band ~0.58
and the true-garble band ~0.75) blocks that while keeping the real rescue. The weighting also
stays **behind the existing anchor gate** — it can only *rescue* names that already share a
real token or are near-identical, never *originate* a match from nothing.

## Validation
- Unit: `tests/ocrConfusions.test.ts` (confusion costs, no false collapse).
- Matcher-level: `tests/productMatcher.test.ts` (garbled basmati matches its SP; apples≠potatoes).
- Regression: `tests/e2eMatchingPipeline.test.ts` apples-not-potatoes stays null.
- Corpus: `npm run receipts:matchaudit` → **regressed 0** (zero precision loss). `improved 0` on
  the tiny dev set only because its garbled lines are products NOT in the catalog (nothing to
  rescue *to* — no matcher fixes that); benefit accrues on real data with garbled-but-in-catalog
  products. Re-run matchaudit as the corpus grows and tune the costs there.

## Tuning
Costs live in `ocrConfusions.ts` (`SINGLE`, `MULTI`); the gate in `recognitionConfig.ts`
(`ocrRescueMinSim`). Every change → `receipts:matchaudit` (orphaned% / priceConflict /
improved-vs-regressed) is the objective. Raise costs / raise the gate to be more conservative.

## Future work (not built)
- **Learn the confusion matrix from your own data.** Every confirmed vocabulary alias is a
  `(garbled OCR, correct catalog name)` pair — align them (edit path) and tally the real
  substitutions to build an *empirical* ML-Kit-on-thermal-receipts matrix, superior to the
  generic seed. Do this once enough aliases accumulate.
- **SymSpell blocking** (symmetric-delete + prefix index) if/when the weighted scoring gets
  expensive enough at 13k candidates that a candidate-generation pre-filter is worth it.
- **Char n-gram embeddings** (fastText subword) only if the above plateaus.

Decision context: matcher too garbled to recover → **skip the line (unmatched, shown as OCR),
never a "did-you-mean" card** — a wrong user fix POISONS the vocabulary (a false alias
mis-matches every future scan), so it's negative-EV. The vocab still learns via the existing
confirm-a-suggestion Card-B as this rescue lifts garbled lines into the S2/S3 band.
