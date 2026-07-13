# Recognition pipeline — reference & tuning guide

The image → words → parse → match → resolve → price → **confidence** → display
chain that turns a receipt photo into matched store products. This is the place
to understand it and the place to tune it.

> **One knob, one place.** Every numeric threshold lives in
> [`shared/recognitionConfig.ts`](./recognitionConfig.ts) (the `RECOGNITION`
> object). Never re-inline a literal — change it there. The file is in the
> cross-boundary `souply-shared` package: **souply-api** imports it directly
> (`../../../shared/recognitionConfig.js`); **souply-app** gets it via
> `npm run sync-shared`. (`matchThresholds.ts` — swipe-voting + basket
> substitution — is a *separate* subsystem and is intentionally not in here.)

## The 8 stages

1. **Image → words** (`souply-app/utils/mlkitOcr.ts`, `receiptOcrPipeline.ts`) —
   rotate/crop/tile, run MLKit (Android) or Apple Vision (iOS). Neither exposes
   per-word confidence, so reliability is *inferred* (frameScale, slope, alnum
   ratio). Degraded Android receipts get destain/contrast variant passes fused
   by max-alnumCount. `RECOGNITION.ocr.*`
2. **Words → parse** (`shared/parsers/*.ts`) — per-chain extraction of
   `{name, amount, unit, isWeighable, price, pricePerUnit, promoPrice}` with OCR
   tolerance (diacritic fold, €/kg division-recovery, the price=0 poison guard).
   `RECOGNITION.parse.*`
3. **Round-1 match** (`souply-api/src/utils/productMatcher.ts`) — name fuzzy
   score (token ∨ char lanes) gated by anchor-token + weighable form; amount/unit
   bonus/penalty; a **distinguishing-noun penalty** docks the *token* lane when a
   significant query noun has no counterpart (apples↔potatoes share only the brand
   words `Fasuoti/IKI/ŪKIS`) — char lane untouched so OCR split-word variants still
   rescue. The **weighable gate** drops cross-form matches only when the *packaged*
   side has a concrete fixed pack size (180 g) — pre-packed-BY-WEIGHT produce
   (`Fasuoti obuoliai`, flagged `isWeighable=0` but sold per kg, no fixed size) is
   weight-compatible and allowed. Returns top-3 `altMatches`. `RECOGNITION.match.*`
   (incl. `nounSimFloor`, `nounDisagreementPenalty/Cap`)
4. **Endpoint + client** (`storeProductController.ts`, `receipt-process.tsx`) —
   same-chain then cross-chain fallback; client auto-applies the SP at
   `match.autoApplyThreshold` (0.85). Cross-chain has its own
   `match.minConfidenceCrossChain` knob (0.55 — deliberately ABOVE same-chain's 0.4
   since 2026-06-27; a weak cross-chain name hit is far likelier wrong).
5. **Round-2 price** (`priceRound2Matcher.ts`) — as-of-receipt-date chain price;
   **confirm** (priceVerified), **disambiguate** pack-size only when name-tied
   (`price.nameTieDelta`), or **reject/re-pick** when the regular price is extreme
   (`price.rejectLow/High`). Fail-open. `RECOGNITION.price.*`
6. **Resolve** (`receiptLineResolver.ts`) — NO-MINT: reuse a same-chain SP (reject >30%
   amount or weighable-form mismatch), or accept a cross-chain match by REUSING a
   same-chain SP of that Product (price/amount gates) — otherwise the line stays
   UNMATCHED (`matchedSpId` NULL, ReceiptItem observation only). The resolver never
   creates StoreProducts or Products (the pre-P3 dedup-create/bootstrap-mint is gone). **Weighable self-heal:** a STRONG (`resolve.weighableSelfHealMin­Confidence`)
   by-weight line ↔ no-fixed-pack packaged SP flips that SP to weighable
   (`markStoreProductWeighable`, idempotent, packaged→weighable only) and reuses it
   instead of duplicating — one real receipt corrects a mislabeled `fasuoti` SP. `allowCreate=false` (price≤0 garbled line) restricts the resolver to REUSE-only —
   no match ⇒ source `skipped_unpriced`; with a usable price, no match ⇒ `unmatched`.
   `RECOGNITION.resolve.*`
7. **Price persistence** (`receiptSaveService.ts`) — clearance skip, implausibility
   skip, dup no-op. `RECOGNITION.price.*`
8. **Display** (Items tab) — driven by the unified **itemConfidence** band.

## The unified per-item confidence score (`RECOGNITION.confidence`, `display`)

One `itemConfidence` ∈ [0,1] per line, computed server-side in `priceRound2Matcher`
(where every signal exists), persisted with its full **breakdown**. Rule:
**vetoes cap regardless of a strong name** (the slyvos / saffran lesson).

```
base   = nameConf × (baseOcrFloor + (1−baseOcrFloor) × ocrReliability)
score  = clamp01(base + Σ confirmers)        // priceVerified, viaPromo, amountUnit, gap, parseValid, reuse
score  = min(score, lowest veto cap)         // priceImplausible, crossChainUnverified, bootstrappedUnverified, …
override: user-confirmed → 1 ; repick → recompute on the sibling ; created-SP → cap at createdSpMaxBand (S2)
```

**Display bands** (decisions locked 2026-06-27): `S1 ≥ 0.85` show SP canonical
info · `0.65 ≤ S2 < 0.85` show OCR + SP preview, "patikrinti" badge ·
`S3 < 0.65` raw OCR only. **Gating is DISPLAY-ONLY** for now — the existing
name≥0.85 auto-apply that *links* the SP is unchanged. All caps/weights are
**tunable defaults to calibrate** against real receipts once metrics land.

## Regression tracking (IKI-style, applied to matching)

- **OCR→parse** stays locked by the inline `W()/L()` word-box fixtures
  (`souply-app/__tests__/ikiReceipt*.test.ts`).
- **End-to-end matching**: `souply-api/tests/e2eMatchingPipeline.test.ts` runs the
  *real* matcher → Round-2 (`getAsOfDatePricesForCandidates` mocked) →
  `computeItemConfidence` over a typed `Fixture[]` and asserts the `itemConfidence`
  **breakdown** + verdict (so a tuning change shows *which signal moved*, not just a
  flipped boolean). The resolver's `source` is a fixture **input** (the resolver is
  DB-heavy and locked in `receiptLineResolver.test.ts`); set `DUMP=1` to print each
  fixture's real matcher/score output when adding a case. Locked: slyvos↔plums cross-chain
  weak (S2 review, not S1), POMIDORAI gap-guard, NAMINIS pack-size, priceImplausible
  veto, price=0 skipped, saffran anchor-gate (no match), ZEWA size-scaling, +
  rejectHigh boundary (2.4× plausible / 2.6× implausible). Band cutoffs (0.85/0.65)
  asserted inclusive via `confidenceBand`. Parse-stage cases (salmon FUR €/kg, IKI
  price=0 poison) stay locked in the souply-app `ikiReceipt*.test.ts` word-box fixtures;
  resolver-only cases (cross-chain bootstrap reject, clearance skip) in their unit tests.

## Build progress

- [x] Central config `recognitionConfig.ts` + `confidenceBand()` helper
- [x] Server consumers migrated (matcher, resolver, Round-2, save, slot1, productModel,
      controller cross-chain) — pure relocation
- [x] App auto-apply gate migrated via synced config (5× dedup killed)
- [x] `itemConfidence` score module (`souply-api/src/services/itemConfidence.ts`) —
      base × ocr + confirmers, lowest-veto cap, created-SP→S2 override; 11 unit tests
- [x] Wired into `receiptSaveService`: captures resolve source, computes + persists
      `line.itemConfidence` {score, band, base, nameConf, ocrReliability, confirmers,
      vetoes, override}, and prints `→ S2 0.74 veto:…` in the dev MATCH SUMMARY. 708 green.
- [x] **`e2eMatchingPipeline` harness** — real matcher→Round2→`computeItemConfidence`,
      asserts the breakdown; 9 named cases + rejectHigh boundary pair + band-cutoff edges. 721 green.
- [x] **Items-tab display** — `ProductLine.itemConfidence` plumbed through `loadExistingReceipt`
      (server persists it on `parsedData`; `updateReceiptDetails` JSON-stringifies, no slim strips it).
      `components/ConfidenceBadge.tsx` renders a `__DEV__`-only band readout ("S2 · 0.74 · v:reason",
      always on in dev) + an S2 "Patikrinti" review chip. The band-driven SP↔OCR name/image switch
      (`showSpInfo`/`showReviewBadge`) is gated by `CONFIDENCE_BAND_DISPLAY` in `constants/flags.ts`
      (DEFAULT FALSE — display is bit-identical to the old `matchConfirmed` state until the thresholds
      are calibrated; flip on to dogfood). The `ItemConfidence` type is hoisted into
      `recognitionConfig.ts` so server + app share one shape.
- [x] **Swipe demotion** — a 'different' vote on a line's primary identity (live
      `/users/:id/swipe-vote` takes `receiptId`; `castDirectSpPairVote` →
      `demoteRejectedReceiptLine`) re-points the line to a SAME-CHAIN runner-up
      altMatch (≥ auto-apply) or clears it to OCR + a `userRejected` veto (cap 0.35
      → S3). The Items tab re-syncs demoted primary fields on focus (by line index).
      Direct "wrong product" rejection from the Items-tab menu → `POST
      /receipts/:id/lines/:idx/reject-match` → `demoteReceiptLineDirect`. (cross-chain
      runner-up still falls to OCR — re-resolution in the vote path is the last gap.)
- [ ] (follow-ups) cross-chain runner-up re-resolution in the vote path · move the
      rejected line's stale Price row ·
      richer OCR-reliability (degradation 0-1 from OCR metadata, not just name
      alnum) · amount/unit + parse-validity confirmers + cross-chain/clearance vetoes
      (need matcher lane provenance + per-line crossChain) · band/veto metrics · user-confirmed override
- [ ] (deferred cleanup) deep char-lane internals + parse-stage thresholds into config
