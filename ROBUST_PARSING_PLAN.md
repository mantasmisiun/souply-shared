# Robust Parsing Plan — free-only, no paid services

*2026-07-04. Everything in this plan runs on the phone or on our own server. Zero per-receipt cost.
Paid LLM/VLM fallbacks are explicitly OUT of scope (revisit only if paid solutions ever become acceptable).*

**STATUS (end of 2026-07-04):**
- Phase 1 ✅ row solver (total = kg × €/kg; recovers/overrules; receipt-269 recoveries live)
- Phase 2 ✅ receipt reconciliation (Σ + adjustments vs printed total; footer.reconciled;
  single-unknown solve with candidate gate) **+ the sutaupėte second equation** (compound
  solve, commit only when both equations corroborate — receipt-269 fully recovered)
- Phase 3 ✅ keyword lexicon (inlined in ikiParser; fold → banded fuzzy substring →
  budgets + reject guards). Consumers migrated: savings line, trader wall, isTDiscount,
  all four KORTELE sites (legacy regexes short-circuit first; lexicon adds coverage).
- Phase 4 ✅ confusion miner (`npm run ocr:confusions` in souply-api): swipe-confirmed +
  alias pairs → aligned edit ops → ranked report + diff vs the hand-coded maps →
  snapshot JSON. Human reviews before any map update (deliberate gate). Add to the
  nightly job list when corpus grows.
- Phase 5 ⏳ device/build-bound (see below).

---

## The problem in one paragraph

Every OCR misread today needs its own hand-written fix: `4y` needed a glyph map, `,86` needed a
headless-total lane, `ER/` needed a looser EUR pattern, `KOR(ELĖS` needed two regex changes. Each fix
is correct, but the stream of new garbles never ends — thermal print + phone cameras guarantee it.
The root cause is structural: **the parser reads every token in isolation and only uses the receipt's
own math to *reject* bad results afterwards, never to *repair* them.**

## The idea in one paragraph

A receipt proves itself. IKI prints the same information many times over:

```
qty × €/kg = line total          (every weighed line)
price − discount = paid          (every discounted line)
Σ paid = SUMA = Mokėti = bank    (the total prints 2–4 times)
sutaupėte = Σ discounts          (the savings line re-states all discounts)
```

So instead of forcing every token to parse perfectly, let uncertain tokens carry **several candidate
readings** ("`4y`" → maybe 49, maybe 44; "`86`" → maybe 0.86, maybe 86) and let a small solver pick
the combination that **makes the math work**. A garble that leaves enough context fixes itself — no
new code per glyph. What can't be reconciled gets **flagged honestly** and flows into the existing
swipe/needsHuman pipeline instead of being silently wrong.

This isn't speculative: the best published receipt-extraction result (EMNLP 2023, "Lazy-k") uses
exactly these receipt equations as hard constraints and lifted accuracy from 81→95 and 45→82 F1.
Notably, *digit-level* repair via receipt math is an open niche — nobody sells this off the shelf.
Our receipts print more redundancy than the ones in that paper, which makes it work *better* for us.

---

## Phase 1 — Row solver for weighed lines  *(the big one)*

**What:** in the columnar engine, numeric tokens on a weight row stop being "parses or dies".
Each token yields a small candidate set:
- readable number → itself (locked)
- glyph-garbled ("`0, 7?`", "`3, 4y`") → all plausible digit substitutions
- headless / bare ("`,86`", "`86`") → the decimal interpretations
- missing → unknown (solve for it)

Then per row, try the combinations (a handful — this is a loop, not AI) against
`qty × €/kg = total` and `total − discount = paid`. Exactly one combination fitting → take it.
Multiple or none → keep today's behavior + flag.

**What it would have fixed with zero code changes:** the `3, 4y` oil price, the `,86` and bare `86`
paprika totals, the `0, 7?` agurkai total, and — impossible today — the single-decimal `3, 4` → 3.49
(the row's discount arithmetic pins it).

**Effort:** ~1–2 weeks. **Risk:** low — behind a flag, verified by the fleet reparse + the full
fixture suite before switching on. The equations can't "invent" values; ambiguity always falls back
to today's behavior.

## Phase 2 — Receipt-level reconciliation

**What:** after rows are assembled, check `Σ paid` against every printed copy of the total
(SUMA, Mokėti, VAT table, bank row) and `Σ discounts` against `sutaupėte`. Use the result three ways:
1. a mismatch of exactly one row's ambiguity → resolve that row (second solving pass);
2. a mismatch we can't explain → flag the receipt + the suspect rows (feeds needsHuman);
3. everything checks out → mark the receipt *reconciled* — these prices can be trusted more
   (feeds itemConfidence / reference pricing as a confirmer).

**Effort:** ~1 week on top of Phase 1 (the checks partially exist as validators — this inverts them).

## Phase 3 — One keyword lexicon (kills the label whack-a-mole)

**What:** all the label words we match with scattered skeleton regexes — NUOLAIDA, KORTELĖS,
RINKINYS, KUPONAS, Prekiautojo, SUMA, Mokėti, Data, Laikas, EUR, kg… — move into **one** matcher:
fold diacritics → map known confusion glyphs → edit-distance against the keyword list, with a
per-keyword tolerance budget and the existing false-positive guards (KORIANDRAS, JOGURTAS…)
encoded once, centrally.

**Why:** `KOR(ELĖS` needed the same fix in two different files this week. With a lexicon, a new
garble is either already within the edit budget (no change at all) or a one-line data entry.

**Effort:** ~1 week, incremental — migrate one keyword at a time, fixture suite green after each.

## Phase 4 — Confusion table from our own data (data instead of code)

**What:** we already store every OCR read alongside its verified truth (swipe confirmations, fleet
baselines, alias vocabulary). A small offline script mines these pairs and produces the digit/letter
confusion table (`y→9`, `?→3`, `O→0`, …) with real frequencies. Phases 1 and 3 *consume* this table.

**Why:** today the table is hand-written from single incidents. Mined, it grows automatically with
every scan and swipe — the system literally learns from use, at zero cost.

**Effort:** a few days; re-run as a nightly/weekly job alongside the existing seeder.

## Phase 5 — A free second opinion on the pixels

**What:** two engines misread *differently*. Where they agree, the token is locked; where they
disagree, the token enters Phase 1's candidate set with both readings. All free, all on-device:
- **iOS:** the Apple Vision module we already built (dormant, `setOcrEngine('vision')`).
- **Android:** evaluate **PP-OCRv5 mobile** (open-source, ~70M params, CPU-only variant, explicit
  Lithuanian support) as the second engine next to ML Kit.
- Also feeds the existing re-OCR roadmap (crop + upscale the suspect band and read it again —
  a "third opinion" targeted at exactly the flagged rows).

**Effort:** iOS side is mostly wiring (module exists); Android needs a real evaluation first
(model size / speed / quality on our receipts). Do last — Phases 1–2 make every engine better,
this just feeds them richer input.

**Concrete next actions (device/build-bound — need Mantas):**
1. iOS: flip `setOcrEngine('vision')` on a dev build, scan the SAME physical receipts from
   the fixture set, and run the phone-side batch test → compare raw.txt quality vs ML Kit.
2. If Vision reads better/differently: add the ensemble hook — run both engines, mark
   disagreeing tokens, feed them as candidates into the Phase-1/2 solvers.
3. Android/PP-OCRv5: needs a native module (paddle-lite binding) — prototype as a separate
   spike before committing; evaluate on the batch-test receipts first.

---

## Explicitly OUT (for now)

- **Paid extraction APIs and paid LLM/VLM calls** — off the table entirely.
- If that ever changes, two research-verified warnings to remember: vision LLMs *tamper with
  numbers to make receipt math balance* (a balanced total is not proof of a correct read — the
  math must stay OUR solver's job), and free-form "LLM cleanup" of OCR text makes it *worse*.

## What does NOT change

Per-chain parsers, band geometry, masking, the swipe/vocabulary/price-verification pipeline — all
stay. The solver slots *inside* the existing engine (rows in, rows out), and everything ships behind
the same gate as always: fixture suites + fleet reparse diff must be clean before the flag flips.

## Order & why

| Phase | Effort | What it ends |
|---|---|---|
| 1. Row solver | 1–2 wk | per-glyph price/total fixes (the biggest recurring class) |
| 2. Receipt reconciliation | 1 wk | silent wrong prices; adds "reconciled" trust signal |
| 3. Keyword lexicon | 1 wk | per-garble label regex fixes (second biggest class) |
| 4. Mined confusion table | days | hand-maintaining glyph maps |
| 5. Second OCR engine | wiring + eval | garbles that reach the parser at all |

Phases 1+2 alone convert "new garble → bug report → code change" into
"new garble → solved by math, or honestly flagged for a swipe".
