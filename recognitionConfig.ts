/**
 * ============================================================================
 * RECOGNITION PIPELINE — SINGLE SOURCE OF TRUTH FOR EVERY TUNABLE THRESHOLD
 * ============================================================================
 *
 * One file for the whole image → words → parse → match → resolve → price →
 * confidence → display chain. Lives in the cross-boundary `souply-shared`
 * package so BOTH sides read the same numbers:
 *   - souply-api imports it directly:  `../../../shared/recognitionConfig.js`
 *     (same pattern as productMatcher.ts importing shared/parsers/rimiParser).
 *   - souply-app gets it via `npm run sync-shared` (shared/ → souply-app/shared/),
 *     so app code + the parsers import `<...>/shared/recognitionConfig`.
 *
 * RULES FOR EDITING:
 *   - Only NUMERIC tunables live here. Regexes / patterns stay in their module
 *     (they are not "thresholds") — they are noted in comments where relevant.
 *   - Each leaf carries its origin `@ref file:line` + a one-line purpose so a
 *     future tuner knows what it does and where it used to be inlined.
 *   - These are TUNABLE DEFAULTS, not laws. The confidence caps/weights are
 *     first-pass estimates to be calibrated against real receipts once the
 *     band/veto metrics land — change them HERE, never re-inline a literal.
 *   - `matchThresholds.ts` (swipe-voting + basket substitution) is a DIFFERENT
 *     subsystem and intentionally stays separate; do not fold it in here.
 * ============================================================================
 */
export const RECOGNITION = {
  // ── OCR + image preprocessing (souply-app/utils/mlkitOcr.ts, receiptOcrPipeline.ts,
  //    imagePreprocess.ts). Platform-split values are { ios, android }. ──────────
  ocr: {
    /** Vertical strip height to stay under MLKit's ~4096px downsample cap. @ref mlkitOcr.ts:92 */
    tileHeightPx: { ios: 1500, android: 3000 },
    /** Overlap between tiles so boundary text/prices are not split. @ref mlkitOcr.ts:93 */
    tileOverlapPx: { ios: 150, android: 300 },
    /** Image height above which vertical tiling triggers. @ref mlkitOcr.ts:94 */
    tilingThresholdPx: { ios: 1800, android: 3500 },
    /** iOS downscale target for wide receipts → less row fragmentation. @ref mlkitOcr.ts:103 */
    iosMaxWidthPx: 1500,
    /** JPEG quality for iOS resized images + tile crops (coords lossless). @ref mlkitOcr.ts:104 */
    iosTileJpegQuality: 0.92,
    /** Android upscale floor to meet MLKit glyph-size minimum. @ref mlkitOcr.ts:113 */
    androidMinOcrWidthPx: 1280,
    /** Upscale cap for small Android captures. @ref mlkitOcr.ts:114 */
    androidMaxUpscale: 2,
    /** Y-distance for deduping text across tile overlap zones. @ref mlkitOcr.ts:121 */
    tileDedupeYTolPx: 20,
    /** Width target for the degraded-receipt recovery upscale pass. @ref mlkitOcr.ts:210 */
    fusionUpscaleTargetPx: 2600,
    /** Clamp range for the inferred power-of-2 frameScale factor. @ref mlkitOcr.ts:491 */
    frameScaleClamp: { min: 1, max: 8 },
    /** Reject extreme per-line tilt as noise (~8.5°). @ref mlkitOcr.ts:544,548 */
    slopeClampRad: { min: -0.15, max: 0.15 },
    /** Min word-pair spread (px) to measure a line slope. @ref mlkitOcr.ts:525 */
    slopeMinDxPx: 8,
    /** Median-smooth window (neighbours) for per-line slope. @ref mlkitOcr.ts:552 */
    slopeSmoothWindow: 3,
    /** Variant-fusion: cluster lines within this × median line height. @ref mlkitOcr.ts:158 */
    fusionYTolRatio: 0.5,
    /** Variant-fusion: horizontal overlap gate (× min width). @ref mlkitOcr.ts:173 */
    fusionXOverlapRatio: 0.5,
    /** Floor for a line box height (px) — guards degenerate boxes. @ref mlkitOcr.ts:560 */
    lineHeightFloorPx: 4,
    /** Merge adjacent lines into one physical row (× frameScale). @ref receiptOcrPipeline.ts:209 */
    rowMergeThresholdPx: 30,
    /** Robust horizontal crop percentiles (full-span Y). @ref receiptOcrPipeline.ts:130 */
    cropPercentiles: { lowX: 5, highX: 95 },
    /** Outward crop padding (× width / × height). @ref receiptOcrPipeline.ts:134 */
    cropPadding: { x: 0.05, y: 0.02 },
    /** Skip degenerate tiny crops (px). @ref receiptOcrPipeline.ts:144 */
    cropMinSizePx: 24,
    /** Skip a crop covering nearly the whole image (× each axis). @ref receiptOcrPipeline.ts:147 */
    cropFullFrameSkipRatio: 0.96,
    /** Final crop re-encode quality. @ref receiptOcrPipeline.ts:154 */
    cropJpegQuality: 0.95,
    /** Skip cropping on sparse OCR (line count). @ref receiptOcrPipeline.ts:112 */
    cropMinLines: 4,
    /** Inter-page stride in the concatenated coordinate space (px). @ref receiptOcrPipeline.ts:202 */
    pageYGapPx: 50,
    /** Linear contrast boost for the faded-thermal variant pass. @ref imagePreprocess.ts:49 */
    contrastStretch: 1.35,
  },

  // ── Per-chain parsers (souply-app/shared/parsers/*.ts) ──────────────────────
  parse: {
    /** unit×qty − discount = total reconciliation tolerance (EUR). @ref ikiParser.ts:340 */
    priceValidationToleranceEur: 0.02,
    /** Reject slightly-negative discounts as OCR noise. @ref ikiParser.ts:338 */
    minDiscountThreshold: -0.005,
    /** Min fraction of product lines with per-word boxes to use the column engine. @ref ikiParser.ts:742 */
    wordsDataSparsityThreshold: 0.6,
    /** yTop diff (px) for same-row fragment clustering. @ref rimiParser.ts:459 */
    rowClusterYThresholdPx: 30,
    /** Center distance < minHeight × this for same-row. @ref rimiParser.ts:460 */
    rowClusterCenterRatio: 0.4,
    /** x-overlap/minWidth above this flags a duplicate read. @ref rimiParser.ts:587 */
    duplicateXOverlapRatio: 0.5,
    /** Char similarity above this confirms a duplicate row. @ref rimiParser.ts:587 */
    duplicateTextSimilarity: 0.7,
    /** Min letters for a name vs an OCR crumb. @ref ikiParser.ts:578 */
    nameMinLetterCount: 2,
    /** Strong-name anchor letter count for recovery. @ref ikiParser.ts:875 */
    nameStrongLetterCount: 4,
    /** Maxima same-row overlap (× min height). @ref maximaParser.ts:903 */
    sameRowYOverlapRatio: 0.5,
    /** kg quantity decimal places (0,XXX kg). @ref ikiParser.ts:498 */
    thermalWeightDecimals: 3,
  },

  // ── Round-1 name matcher (souply-api/src/utils/productMatcher.ts, nameMatchGate.ts) ──
  match: {
    /** Floor to surface a SAME-chain match. @ref productMatcher.ts:204 */
    minConfidence: 0.4,
    /**
     * Floor to surface a CROSS-chain (fallback) match. A separate, HIGHER knob
     * than same-chain because cross-chain matches another chain's catalog, where a
     * weak name hit (the shared "Raudonosios" in slyvos vs paprikos, the brand-word
     * apples→potatoes) is far likelier wrong. Raised 0.4→0.55 (2026-06-27) to drop
     * the weakest cross-chain coincidences; slyvos-grade (~0.65-0.69) still surfaces
     * and is handled by the swipe demotion + the `crossChainUnverified` display veto.
     * @ref storeProductController.ts (cross-chain findBestProductMatches call)
     */
    minConfidenceCrossChain: 0.55,
    /** Max altMatches returned per line. @ref productMatcher.ts:205 */
    topN: 3,
    /** Client auto-applies storeProductId at/above this Round-1 confidence. @ref receipt-process.tsx auto-apply */
    autoApplyThreshold: 0.85,
    /** Per-token Levenshtein floor to count a token as matched. @ref productMatcher.ts:147 */
    tokenMatchThreshold: 0.75,
    /** charScore must reach this to contribute (substring false-positive guard). @ref productMatcher.ts:248 */
    charScoreFloor: 0.6,
    /** Discount applied to the char lane so clean token matches win. @ref productMatcher.ts:248 */
    charScoreDiscount: 0.95,
    /** Early-bail when length ratio < this. @ref productMatcher.ts:99 */
    charSimLengthFloor: 0.4,
    /** Bypass the anchor-token gate when near-identical (OCR split-word rescue). @ref productMatcher.ts:234 */
    anchorCharSimRescue: 0.85,
    /** Min token length to carry product identity for the anchor gate. @ref nameMatchGate.ts:30 */
    significantMinLen: 4,
    /** Tokens ≤ this many chars excluded from token Levenshtein. @ref productMatcher.ts:75 */
    shortTokenThreshold: 3,
    /** Query long-token coverage for the shared-prefix guard (≥3 long tokens). @ref productMatcher.ts:175 */
    coverageHigh: 0.67,
    /** Query long-token coverage otherwise. @ref productMatcher.ts:175 */
    coverageLow: 0.5,
    /** Min coverage of candidate long tokens by the query. @ref productMatcher.ts:193 */
    candidateCoverageGuard: 0.4,
    /**
     * OCR space-heal: ML Kit splits a word across a space ("KIAULIENA" → "KIAUL
     * IENA"), poisoning the token lane. When a query token doesn't match a candidate
     * token alone, glue it with the next query token and accept the glued word when
     * it matches a candidate token at/above this. Adjacent-pair only, single-token-
     * failed only — can't fabricate coverage. @ref productMatcher.ts healQueryTokens
     */
    glueRescueThreshold: 0.85,
    /**
     * Anchored abbreviation bonus: a SHORT query token (receipt "R" for "riebumas",
     * Lidl "sur." for "surimi", "ag." for "agurkų") that PREFIXES a candidate long
     * token adds `abbrevBonus` (capped at `abbrevBonusCap`) — but ONLY when the two
     * names already share a significant token (sharedSignificantToken), so an
     * abbreviation can never originate a match. @ref productMatcher.ts
     */
    abbrevBonus: 0.05,
    abbrevBonusCap: 0.1,
    /**
     * Token-set SUBSET lane: when the receipt name is a clean (order-independent)
     * subset of a longer catalog name — every query long token covered — score it
     * `subsetFullWeight` (auto-apply grade, within the catalog tiebreak margin of a
     * 1.0 orphan). Partial coverage scales down; below `subsetMinCoverage` it
     * contributes nothing. Gated behind a shared significant token. Fixes the
     * whole-string char-lane failure on long catalog supersets without touching the
     * char lane. @ref productMatcher.ts subsetCoverage
     */
    subsetFullWeight: 0.92,
    subsetMinCoverage: 0.6,
    /**
     * Distinguishing-noun disagreement penalty. Generic brand/packaging words
     * ("Fasuoti", "IKI", "ŪKIS") are shared across very different products, so a
     * candidate can clear coverage on those alone while the DISTINGUISHING noun
     * disagrees ("obuoliai"/apples vs "bulvės"/potatoes). For each significant
     * (long) query token whose best per-token similarity to ANY long candidate
     * token is below `nounSimFloor`, subtract `nounDisagreementPenalty` from the
     * TOKEN score (capped at `nounDisagreementCap`). Applied to the token lane
     * only — the whole-string char-rescue lane is left intact for OCR split-word
     * variants. @ref productMatcher.ts distinguishingPenalty
     */
    nounSimFloor: 0.55,
    nounDisagreementPenalty: 0.15,
    nounDisagreementCap: 0.3,
    /**
     * Catalog-first tiebreak: when a real scraped catalog SKU and a receipt-minted
     * orphan score within this margin, prefer the catalog one (a garbled orphan can
     * otherwise out-rank the clean catalog because its OCR name hugs the query).
     * @ref productMatcher.ts findBestProductMatches sort
     */
    catalogPreferenceMargin: 0.1,
    /** Amounts match if |diff| < this. @ref productMatcher.ts:270 */
    amountTolerance: 0.01,
    /** Bonus when amount AND unit both match. @ref productMatcher.ts:273 */
    amountBonus: 0.15,
    /** Same-unit different-pack penalty = min(cap, base + scale × relErr). @ref productMatcher.ts:283 */
    sizePenaltyBase: 0.2,
    sizePenaltyScale: 0.3,
    sizePenaltyCap: 0.45,
    /** Penalty when the unit FAMILY differs (g vs l). @ref productMatcher.ts:287 */
    unitFamilyPenalty: 0.2,
    /** Cross-chain swipe ANCHORS need ≥ this Round-1 name confidence. @ref slot1CandidateModel.ts:7 */
    slot1AnchorMinScore: 0.85,
    /** Min cross-chain name similarity to pair for a swipe. @ref slot1CandidateModel.ts:13 */
    slot1CrossChainMinScore: 0.6,
    /** Candidates per (chain,category) group fed to JS scoring. @ref slot1CandidateModel.ts:15 */
    maxCandidatesPerGroup: 25,
  },

  // ── Receipt-name vocabulary (Issue H — storeProductAliasModel.ts) ──
  vocab: {
    /** Distinct 'identical' voters needed to auto-promote a learned alias to
     *  CANONICAL (used in global name matching). Admin can confirm earlier / reject.
     *  @ref storeProductAliasModel.ts recordAliasVote */
    canonicalDistinctUsers: 2,
    /** Confidence nudge for a candidate in the L3 leaf a 'similarity' alias scoped to
     *  (the orphan re-matching: L2 hard-scope + this L3 boost). @ref productMatcher.ts */
    categoryScopeBoost: 0.07,
  },

  // ── Resolver (souply-api/src/services/receiptLineResolver.ts, productModel.ts) ──
  resolve: {
    /** Cross-chain bootstrap price floor (−40%, loose: cheaper chains). @ref receiptLineResolver.ts:26 */
    crossChainPriceLowerRatio: 0.6,
    /** Cross-chain bootstrap price ceiling (+20%, tight). @ref receiptLineResolver.ts:27 */
    crossChainPriceUpperRatio: 1.2,
    /** Reject same-chain SP reuse if amount differs > this fraction. @ref receiptLineResolver.ts:235 */
    sameChainAmountMismatch: 0.3,
    /** Float epsilon for bootstrap amount equality. @ref receiptLineResolver.ts:188 */
    amountEpsilonAbs: 1e-6,
    /** Name-similarity cutoff for auto baseProductId clustering. @ref productModel.ts:13 */
    autoBaseProductThreshold: 0.8,
    /**
     * Catalog self-heal: when a by-WEIGHT receipt line matches a "packaged"
     * (isWeighable=0) SP that has NO fixed pack size — pre-packed-by-weight produce
     * mislabeled in the catalog — at or above this confidence, FLIP that SP to
     * weighable and reuse it instead of minting a duplicate. A high bar so one
     * strong real-world receipt can correct the flag without risking a genuine
     * package (those are excluded by the no-fixed-pack guard anyway).
     * @ref receiptLineResolver.ts (weighable self-heal)
     */
    weighableSelfHealMinConfidence: 0.85,
  },

  // ── Round-2 price + price persistence (priceRound2Matcher.ts, receiptSaveService.ts) ──
  price: {
    /** Round-2 may override Round-1 only within this name-confidence gap. @ref priceRound2Matcher.ts:76 */
    nameTieDelta: 0.15,
    /** Price-implausibility band (regular-price anchor) — outside ⇒ likely wrong product. @ref priceRound2Matcher.ts:84 */
    rejectLow: 0.4,
    rejectHigh: 2.5,
    /** Price match tolerance for weekly-snapshot drift = max(abs, target×rel). @ref priceRound2Matcher.ts:89 */
    priceCloseAbs: 0.01,
    priceCloseRel: 0.01,
    /** Skip a price write when < this × the rolling baseline average. @ref receiptSaveService.ts:55 */
    clearanceRatio: 0.5,
    /** Rolling window of verified non-fallback prices for the baseline. @ref receiptSaveService.ts:56 */
    baselineWindow: 5,
    /** Cap swipe candidates stored per line. @ref receiptSaveService.ts:21 */
    maxCandidatesPerLine: 5,
  },

  // ── Unified per-item confidence score (NEW — computed in priceRound2Matcher) ──
  // Veto-caps-name model: base(name×ocr) + confirmers, then the LOWEST veto cap
  // wins so a strong-but-wrong name can never reach a confirmed band. All
  // first-pass estimates — calibrate against real receipts once metrics land.
  confidence: {
    /** base = nameConf × (floor + (1−floor) × ocrReliability). OCR quality modulates, never dominates. */
    baseOcrFloor: 0.7,
    /** ocrReliability = clamp01(start + slope×alnumRatio − dedupPenalty − tiledPenalty); ×failFloor if name letter-floor failed. */
    ocrReliability: { start: 0.5, slope: 0.5, dedupPenalty: 0.1, tiledPenalty: 0.05, nameFloorFailMultiplier: 0.5 },
    /** Additive confirmers (each only ADDS, then clamp to [0,1]). */
    confirmers: {
      priceVerified: 0.15, // regular or active-promo match on the as-of date
      viaPromo: 0.05,      // confirmed via promo only (weaker than regular)
      amountUnit: 0.05,    // amount + unit exactly agree
      gapMax: 0.05,        // unambiguous-winner bonus, scaled by min(1, gapToRunnerUp/gapNorm)
      gapNorm: 0.2,
      parseValid: 0.05,    // unit×qty − discount = total held (parse.priceValidationToleranceEur)
      reuse: 0.03,         // clean same-chain SP reuse
    },
    /** Multiplicative veto CAPS (lowest wins; applied after confirmers). */
    vetoCaps: {
      priceImplausible: 0.3,        // regular extreme, no plausible sibling — catalog-poison case
      weighableMismatch: 0.35,      // by-weight ↔ packaged forced (defensive; gate should prevent)
      crossChainUnverified: 0.55,   // cross-chain match without a price confirm
      bootstrappedUnverified: 0.6,  // resolver bootstrapped an SP without a price confirm
      amountUnitPenalty: 0.45,      // size/family penalty fired in Round-1
      skippedUnpriced: 0.25,        // price ≤ 0 garbled line (no SP created)
      clearanceSkip: 0.5,           // price anomaly skipped the write — identity uncertain
      userRejected: 0.35,           // user swiped 'different' on this line's match — a single
                                    //   personal vote is authoritative (1-vote split), so the
                                    //   line can never read as a confirmed match afterwards
    },
    /**
     * A FRESH OCR-only SP (resolver source 'created', no priced evidence) may
     * not exceed this band on name alone — a never-before-seen product can't
     * auto-confirm. (User decision.) Value is a band key, not a number.
     */
    createdSpMaxBand: 'S2' as const,
  },

  // ── Display bands (Items tab). score ≥ S1 ⇒ SP canonical info; S2 ≤ score < S1
  //    ⇒ OCR + SP preview, review badge; score < S2 ⇒ raw OCR only. ────────────
  display: {
    /** Confirmed band: show SP name + image (matches the auto-apply line). */
    bandS1: 0.85,
    /** Review band lower edge: show OCR + SP preview side-by-side, "patikrinti". */
    bandS2: 0.65,
  },

  // ── Swipe queue: receipt-resolution + global identity. See SWIPE_QUEUE_REDESIGN.md.
  //    All knobs here are tunable defaults to calibrate against real receipts. ────────
  queue: {
    // needs-human = ambiguity × price-impact. Ranks which UNCERTAIN (S2/S3) lines are
    // worth a card; the rest auto-resolve. Higher = more worth a human glance.
    needsHuman: {
      /** Band → base ambiguity. S1 lines are confident and never carded. */
      bandWeight: { S3: 0.7, S2: 0.4, S1: 0 } as Record<'S1' | 'S2' | 'S3', number>,
      /** A small gap to the runner-up = a genuine choice → adds up to this (scaled by 1−gap/gapNorm), needs ≥2 candidates. */
      gapBonusMax: 0.3,
      gapNorm: 0.2,
      /** Any confidence veto on the line adds this — the match is independently suspect. */
      vetoBonus: 0.2,
      /** A LONE freshly-created product (nothing to choose between) isn't worth a card — damp its ambiguity. */
      loneCreatedDamp: 0.5,
      /** Line spend (€) that maps to full price-impact. Bigger spend ⇒ more worth asking. */
      priceImpactNormEur: 10,
      /** Floor so even a cheap item keeps some price-impact (price never zeroes a real ambiguity). */
      priceFloor: 0.3,
    },
    /** Bands uncertain enough to be eligible for a card (the suspicion surface). */
    surfaceBands: ['S2', 'S3'] as ReadonlyArray<'S1' | 'S2' | 'S3'>,
    // Mandatory post-scan flow.
    mandatoryMaxCards: 3,
    mandatoryReceiptMax: 2,   // up to 2 Card-B (receipt-resolution) cards
    mandatoryCrossStore: 1,   // 1 cross-store card (most-expensive qualifying line)
    // Voluntary "Help identify products" flow.
    voluntaryBatchSize: 10,
    voluntaryReceiptHalf: 5,  // 5 receipt-resolution + 5 receipt-related global
    /**
     * Relatedness gate (Decision 3) for the voluntary GLOBAL cards: a card is
     * "related to your receipt" only if its product is in a category you bought
     * from AND its name shares at least this token-Jaccard with some receipt line.
     * Keeps the pool finite + never asks about unbought types (no hair dye).
     */
    relatednessNameFloor: 0.2,
  },
  // NB: intentionally NOT `as const` — consumers assign these into plain `number`
  // locals; literal types ('0.6') would reject a later widened assignment. Values
  // stay immutable via the `const` binding; the only literal we keep is the band
  // key on `confidence.createdSpMaxBand`.
};

/** Resolve a numeric confidence score to its display band. */
export function confidenceBand(score: number): 'S1' | 'S2' | 'S3' {
  if (score >= RECOGNITION.display.bandS1) return 'S1';
  if (score >= RECOGNITION.display.bandS2) return 'S2';
  return 'S3';
}

export type RecognitionConfig = typeof RECOGNITION;

/**
 * Unified per-receipt-LINE confidence result. Computed server-side
 * (souply-api `computeItemConfidence`), persisted on each parsed line, and read
 * by the app's Items tab to pick the display band. Lives here so both sides
 * share one shape. `band`: S1 ⇒ show SP info · S2 ⇒ OCR + review · S3 ⇒ OCR only.
 */
export interface ItemConfidence {
  score: number;
  band: 'S1' | 'S2' | 'S3';
  base: number;
  nameConf: number;
  ocrReliability: number;
  confirmers: Record<string, number>;
  vetoes: { reason: string; cap: number }[];
  override: null | 'created_ocr_only' | 'user_confirmed';
}
