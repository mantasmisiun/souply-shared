# Smart Basket — "Generate basket with AI" + Shopping sheet

Status: SPEC v1 (2026-07-19). Decisions locked with Mantas; research-backed
(Amazon Buy-It-Again KDD'18, TIFU-KNN SIGIR'20, NBR Reality Check TOIS'23,
mission-segmentation arXiv:1909.02996 — see agent reports in session notes).

## 1. Shopping sheet (dock on the Shopping tab)

Same `DockedGlassSheet` pattern as the catalog chooser: pill on the tab bar,
drag to medium/full. Gated to pathname `/basket` (Shopping tab root). Contents:

1. **Date filter** — `DateFilterButton` + dot calendar, MOVED from the screen's
   pinned header (removed there). Picking a date filters the trips list behind;
   sheet collapses on pick.
2. **Family/household card** — moved from the screen body (create-or-invite +
   QR flow, unchanged behavior).
3. **"Generate basket with AI"** — entry to the generator flow below.

## 2. Generator flow (UX)

- **Gate**: `qualifiesForAutoTemplate` (≥3 receipts across ≥2 chains — same
  threshold as account recovery / smart template, deliberately).
  - Not qualified → prompt to upload 3 receipts from 2 different stores that
    represent typical shopping, with live progress ("2/3 receipts · 1/2 stores")
    and a shortcut to the scan flow.
- **Mode picker** (three cards):
  1. Popular items this week
  2. Popular items with discounts
  3. My personal shopping basket for this week
- **Preview → accept** (decision): generation returns a PREVIEW list rendered
  in the sheet — image, name, qty (stepper), remove per row. "Create basket"
  creates the draft basket via existing endpoints, targets the session
  (collecting-items bar), collapses the sheet. No basket is created until
  accept.

## 3. Scoring foundation — build on ProductInteraction (decision)

The existing system IS the substrate:

- `ProductInteraction` (basket_add=2, list_add=1, list_check=3,
  **receipt_buy=5**), 90-day exp decay → `UserProductScore` (per user) and
  nightly `Product.globalScore` (365d window) via the scheduler.
- **BUG FOUND 2026-07-19**: `receipt_buy` events never fired in practice —
  all existing receipts predate the wiring (landed 57a029b, 2026-07-16).
  Fix = **backfill**: one-off script inserts `receipt_buy` interactions from
  `ReceiptItem` rows (matchedSpId NOT NULL, band S1/S2) with
  `createdAt = Receipt.receiptDate` (decay applies honestly), then recalcs
  UserProductScore + globalScore. Live path stays as-is (verify on next
  device upload).

New, layered on top (no schema change for scores):

- **Windowed global popularity** ("this week"): computed from
  `ProductInteraction` over a rolling 14 days with 7-day half-life decay
  (upload-lag tolerant — decision). Live SQL now; if scale demands, the same
  query materializes into the nightly job later.
- **Trip stream** (for slots, combos, amounts): `ReceiptItem` grouped by
  receipt, receipts unioned per calendar day = one TRIP (future-proofs
  multi-store trips — decision).

### Comparability (personal vs global)

Both sides are converted to **per-trip probability**:
- personal(p) = decayed appearances of p across user trips / decayed trip count
  (45d half-life, as in defaultTemplateService);
- global(p) = decayed trips containing p / decayed total trips (14d window,
  7d half-life).
Both ∈ [0,1] with identical semantics ("chance this item is in a trip") —
directly blendable. Blend where needed: Jelinek-Mercer
`λ·personal + (1−λ)·global`, `λ = n_trips/(n_trips + τ)`, τ = 5.

### Slots

`slots = clamp(median(distinct products per trip over last 90d, decayed), 5, 25)`.

## 4. Modes

Common post-processing for all modes:
- **Amounts**: median qty per product from the user's ReceiptItems →
  `roundQuantity` (existing). Never-bought items: global median qty, else 1.
- **Availability**: product must have a recent scraped price or recent purchase
  (AVAILABILITY_WINDOW_DAYS = 45, existing rule).
- **Diversity cap** (decision): pure-global suggestions (user never bought) are
  capped at 2 per L2 category and only from categories the user has bought
  from. Personal items are never capped.

### 4a. Popular items this week
1. Candidates: products with global₁₄(p) > 0 ∪ user's personal pool.
2. Fill order: (i) items where BOTH personal > 0 AND global₁₄ > 0, sorted by
   blended score; (ii) remaining slots by max(personal, global₁₄) — global
   entries subject to the diversity cap.

### 4b. Popular items with discounts
Same as 4a, but the candidate set is first intersected with products carrying
a live discount (`bestDiscountPct > 0` or real-discount, existing productModel
queries). Fill order identical; if slots remain unfilled (few discounts),
leave the basket short rather than padding with non-discounted items.

### 4c. My personal shopping basket
Combo-aware (the toilet-paper+towels vs sponges+soap insight):
1. **Pair graph**: personal within-trip co-occurrence, scored with shrunk lift
   (`n/(n+λ)` support damping, λ=5, min personal co-count 2), interpolated
   toward the GLOBAL pair graph (all users' trips, min co-count 3) with
   `λ_u = c_u/(c_u+τ)`; final backoff to L2-category co-occurrence.
2. **Seed**: highest decayed personal frequency item.
3. **Greedy fill**: repeatedly add argmax_j [ personal(j) × (1 + Σ_{i∈S}
   pair(i,j)) ] — frequency-driven, combo-refined (research: personal
   frequency dominates; co-occurrence refines, never drives alone).
4. Remaining slots (if any): blended personal×global as in 4a.
   v2 (explicitly deferred): global trip-type clustering (mission
   segmentation) once the corpus supports it; the greedy seed approximates it.

## 5. API surface

- `POST /api/smart-basket/preview` `{ mode: 'popular'|'discounts'|'personal' }`
  → `{ qualified, progress?: {receipts, chains}, slots, items: [{productId,
  name, imageUrls, quantity, unit, isWeighable, source: 'personal'|'both'|
  'global', discountPct?}] }`. Locale-aware names (localizedProductNameSql).
- Accept is CLIENT-side: existing basket-create + batch item add (no new
  endpoint, no orphan baskets).
- `scripts/backfillReceiptBuy.ts` — the one-off backfill + recalc (dev,
  staging, prod when promoted).

## 6. Testing

- Pure functions (slot estimation, probability scores, blend, greedy combo,
  diversity cap) side-effect-free in `smartBasketService.ts` — unit-tested
  like defaultTemplateService.
- curl verification of preview endpoint on dev DB (all three modes + gate).
- Device: sheet UX, generate→preview→accept→session-target loop.

## 7. Out of scope (v2+)

- Nightly materialization of windowed popularity (schema ready via the same
  SQL), trip-type clustering, multi-store trip slots union (design already
  day-based), neighbor-based CF (TIFU's kNN term), popularity debiasing (IPW).
