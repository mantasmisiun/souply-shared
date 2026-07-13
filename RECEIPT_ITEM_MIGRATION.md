# ReceiptItem migration — receipt lines become first-class rows, not catalog entities

## Why
A receipt line is an **observation** ("this store, this day, this OCR text, this price"),
NOT a catalog entity. Today the pipeline conflates the two: to record a line it mints a
`StoreProduct` (+ `Product` + `Price`) even when nothing in the catalog matches — polluting
the catalog with orphan rows, leaking categories, and forcing every per-line edit to rewrite
the entire `Receipt.parsedData` JSON blob under a `FOR UPDATE` lock.

`ReceiptItem` makes the line a first-class relational row. The receipt becomes what it really
is: **a tool to identify an existing product and update its price** — it never creates a
`StoreProduct`/`Product`. A `Price` is written only when a line matches an existing catalog SP.

## Locked decisions (owner, 2026-07)
1. **No catalog creation from receipts (pure).** A receipt line NEVER mints a `StoreProduct`
   or `Product`. It either matches an EXISTING same-chain SP (→ write a `Price`) or stays
   unmatched (`matchedSpId = NULL`, no `Price`). Cross-chain "bootstrap" and same-chain
   "cluster" mints are removed. Consequence (accepted): chains with no scraped catalog
   (e.g. Norfa) accumulate no priceable products from receipts until a future promotion path
   (see Future work) creates SPs from recurring unmatched OCR via votes.
2. **`Price.receiptItemId`.** Every receipt-derived `Price` links to the `ReceiptItem` it came
   from (`FK ON DELETE CASCADE`), not just the receipt — so a price is trivially removable and
   re-assignable when a line's match changes. `receiptId` is kept, denormalised, so existing
   `Price` indexes/queries keep working unchanged.
3. **Backfill all existing receipts** into `ReceiptItem` (one-time script) so readers use rows
   uniformly and old receipts keep working.
4. **Hard cutover.** Once readers move to `ReceiptItem`, the save path stops writing `products[]`
   to the blob (blob keeps `header` + `footer` only). No lingering dual-write. → parity MUST be
   proven by tests before the flip, since there is no blob fallback.
5. **Existing uncategorised orphans:** left untouched by the core migration (they are
   `priceVerified=0` + category-gated, invisible to comparison). A separate gated retirement
   script (dev→staging→prod, final phase) deletes the UNENGAGED ones (no swipe vote, no
   canonical/similarity alias, only unverified receipt prices) + their Products/Prices, and
   re-points their lines to `matchedSpId=NULL`. Engaged/rescued orphans are KEPT. Nothing is
   lost — the OCR observation survives in the backfilled `ReceiptItem`.

Contained-blast rule: **regular-user features must not break; admin may lag** and is migrated
last (or left temporarily broken).

## Schema
### `ReceiptItem` (new)
Hybrid: hot/queryable + individually-mutated fields are COLUMNS (so each swipe is a single-column
`UPDATE`, not a blob rewrite); the heavy whole-read fields are JSON; `extra` is a catch-all that
makes reconstruction lossless.

```
ReceiptItem
  id            INT UNSIGNED PK
  receiptId     INT NOT NULL   FK→Receipt(id) ON DELETE CASCADE
  lineIdx       INT NOT NULL                       -- position in the original products[]
  UNIQUE (receiptId, lineIdx)

  -- immutable OCR / parse
  name          VARCHAR(512)   -- OCR text
  price         DECIMAL(10,2) NULL
  promoPrice    DECIMAL(10,2) NULL
  quantity      DECIMAL(10,3) NULL -- item count
  unit          VARCHAR(20) NULL   -- display unit (vnt/kg)
  amount        DECIMAL(10,3) NULL -- pack size
  sizeUnit      VARCHAR(20) NULL   -- pack unit (g/ml)
  isWeighable   TINYINT(1) NOT NULL DEFAULT 0
  pricePerUnit  DECIMAL(10,4) NULL
  brandName     VARCHAR(255) NULL

  -- match binding (mutated by resolver + swipes)
  matchedSpId   INT NULL         FK→StoreProduct(id) ON DELETE SET NULL   -- was line.storeProductId
  matchSource   VARCHAR(24) NULL -- reused|bootstrapped|created|skipped_unpriced|null
  matchedName   VARCHAR(512) NULL
  storeProductImageUrl VARCHAR(1024) NULL
  matchConfidence DECIMAL(4,3) NULL
  matchConfirmed TINYINT(1) NOT NULL DEFAULT 0
  priceVerified  TINYINT(1) NOT NULL DEFAULT 0
  variantUncertain TINYINT(1) NOT NULL DEFAULT 0
  priceImplausible TINYINT(1) NOT NULL DEFAULT 0

  -- confidence + category (display / queue priority)
  band          VARCHAR(8) NULL   -- itemConfidence.band (S1/S2/S3), denormalised for queries
  needsHuman    DECIMAL(8,2) NULL
  categoryId    INT NULL
  categoryName  VARCHAR(255) NULL
  categoryL2Name VARCHAR(255) NULL

  -- cold JSON (read whole, not per-field)
  itemConfidence JSON NULL      -- {band, score, vetoes[]}
  altMatches    JSON NULL       -- candidate SPs for swipe voting
  region        JSON NULL       -- crop geometry (yTop/yBottom/xLeft/xRight + skew corners)
  rawLines      JSON NULL       -- OCR line fragments
  extra         JSON NULL       -- catch-all: any line key not mapped above (lossless round-trip)

  createdAt/updatedAt TIMESTAMP
  KEY idx_ri_receipt (receiptId, lineIdx)
  KEY idx_ri_sp (matchedSpId)
```

### `Price` (add one column)
```
ALTER TABLE Price ADD COLUMN receiptItemId INT NULL AFTER receiptId,
  ADD KEY idx_price_receiptitem (receiptItemId),
  ADD CONSTRAINT fk_price_receiptitem FOREIGN KEY (receiptItemId) REFERENCES ReceiptItem(id) ON DELETE CASCADE;
```
`receiptId` stays (denormalised from the item's receipt).

## The lossless mapping (parity by construction)
`receiptItemModel.ts` owns ONE canonical pair used by write, backfill AND read:
- `lineToItem(receiptId, lineIdx, line)` → row: maps known keys to columns; **`extra` = every line
  key NOT in `KNOWN_LINE_KEYS`**. No line data can be silently dropped.
- `itemToLine(row)` → line: rebuilds the original line object (columns under their original names,
  JSON fields, then `...extra`). `matchedSpId`→`storeProductId`.

Round-trip invariant (unit-tested): `itemToLine(lineToItem(r, i, line))` deep-equals `line` for
any real line. This is what makes the hard cutover safe — the reassembled API `products[]` is
identical to what the blob returned.

## Phase plan — ✅ COMPLETE (shipped to dev, 835 tests green)
- **P0 ✅ foundation:** `sql/receipt_item.sql` (`id` signed INT — matches Price FK signedness);
  `receiptItemModel.ts` = the lossless `lineToItem`/`itemToLine` mapping (`extra` catch-all) +
  CRUD (`replaceReceiptItems`/`getReceiptItemLines`/`updateReceiptItem`/`syncReceiptItemMatchState`/
  `getReceiptItemMatchedSpId`); `tests/schema/schema.sql`; 7 parity round-trip tests.
- **P1 ✅ backfill + write:** `src/scripts/backfillReceiptItems.ts` (`npm run receipts:backfillitems`,
  needs `import '../config/env.js'` FIRST); `receiptSaveService` dual-writes rows
  (`matchSource` injected from `resolveSourceByLine`); real-DB round-trip test.
  `replaceReceiptItems` NULLs out `matchedSpId` for deleted SPs (stale-blob-ref FK guard).
- **P2 ✅ read from rows:** `getReceiptById` reassembles `products[]` from rows (blob-fallback,
  type-preserving) → covers detail + comparison; `swipeVoteService`/`receiptResolveQueueService`/
  `receiptRelatednessService` read rows; `getReceiptItemsWithDetails` → rows (P4).
- **P2 Step C ✅ hard cutover:** the 3 mutation sites (`castReceiptLineVote` +
  `demoteReceiptLineDirect` + `demoteRejectedReceiptLine`) read the line from its ReceiptItem row
  `FOR UPDATE` + chainId from the blob header, and confirm/demote as a single-row `UPDATE
  ReceiptItem` — no more whole-blob rewrite. Save writes the blob as `{ header, footer, products: [] }`.
  Real-DB integration tests cover identical + different votes.
- **P2 Step C+ ✅ blob raw-text strip:** the stored blob keeps only STRUCTURED header/footer
  (storeAddress, total, receiptNo…) + `wordsDump` geometry — `stripProductRawText` (util/receiptPII)
  drops `header.rawText`/`footer.rawText` at every save (on the IKI thermal path BOTH held the entire
  receipt: store + every product + totals + card/loyalty PII). Per-product raw text lives per-item in
  `ReceiptItem.rawLines`, so nothing product-related remains in `Receipt.parsedData`. No read-path
  consumes the stored rawText (viewer/reparse use `wordsDump`), so this is invisible downstream.
- **P3 ✅ stop minting:** resolver's 3 mint sites `return unmatched` (`matchedSpId=NULL`, no `Price`),
  `createFreshProductAndSp` deleted; demotion orphan-mint removed (marks rejected Price unverified);
  `adminReceiptSplit` creates its SP directly (curation = a legit create path); `Price.receiptItemId`
  threaded through `createPrice` + the save loop.
- **P4 ✅ cleanup:** `getReceiptItemsWithDetails` → rows (all lines, `Price.receiptItemId` join);
  `src/scripts/retireOrphanStoreProducts.ts` (`npm run receipts:retireorphans` — DRY by default,
  `--commit` to delete unengaged legacy uncategorised orphans, keeps voted/aliased/verified ones).

### Post-cutover hardening (2026-07-02 pipeline audit)
- **statsService.getUserStats ✅ + defaultTemplateService ✅ migrated to ReceiptItem rows**
  (they still read the now-empty blob products[] after the cutover — profile stats and
  default-template purchase signals silently excluded every post-cutover receipt).
- **Autosave PUT is a non-destructive MERGE** (`applyReceiptAutosave`): content fields
  always; match fields only with the client's explicit `manualMatch` marker; the line's
  own Price row updates IN PLACE. The old PUT re-ran the whole save (DELETE+INSERT items,
  Price rows CASCADE-deleted, vote/reject state overwritten from the stale client blob).
- **The ReceiptItem dual-write is FATAL on the initial save** (a failed row write rolls
  the save back — swallowing it could commit the DELETE half and empty the receipt), and
  `lineToItem` clamps VARCHAR widths / NULLs DECIMAL overflows so one garbled OCR value
  can't abort a save.
- **matchaudit + GET /receipts/:id/items** now read ReceiptItem rows (items endpoint keeps
  a blob fallback for un-backfilled receipts — deploy-order safety).
- **Known gap:** the backfill script does NOT stamp `Price.receiptItemId` for legacy
  receipts, so their autosave price edits won't sync to Price until the backfill is
  extended (staging/prod checklist item).

### Remaining admin-lag work (non-blocking, owner said admin may lag)
- `adminReceiptSplitModel` still patches the (now-vestigial) blob `products[]` when splitting a line
  — the new SP/Product/Price ARE created correctly, but the receipt-line split should update the two
  `ReceiptItem` rows instead of the empty blob array. Doesn't crash (`findIndex` on `[]` → -1).
- `updateReceiptParsedDataItem` (legacy `.items` path), and the analytics/dedupe scripts, still read
  the blob — migrate to `getReceiptItemLines` when convenient.
- `receiptDeletionService` already cascades `ReceiptItem` via the FK; the orphan-SP hunt now finds far
  fewer (no new mints).

## Call-site inventory (from pipeline research)
**User-facing (must not break) — migrate:** `receiptSaveService` (write), `receiptHydrationService`
+ `receiptController` + `receiptModel.getReceiptItemsWithDetails` (read), `receiptLineVoteService`
+ `receiptLineDemotionService` (mutation), `swipeVoteService` (reads line SP), `receiptDeletionService`,
`receiptResolveQueueService` (card build, read-only), `receiptRelatednessService` (swipe scoping),
`statsService` (savings), `util/receiptPII` (strip per-line rawLines).
**Safe (blob-based, unaffected):** `receiptComparisonService`, savings (`filter(storeProductId>0)`),
recovery (reads receipt-level `footer.total` only).
**Admin/scripts (may lag):** `adminReceiptSplitModel`, `adminReceipts/Crop/Flag` controllers +
`adminFlagQueueModel`, `failedReceiptLogModel`, batch/audit scripts, `dedupeStoreProducts`.

## Tests
- Parity round-trip (`itemToLine∘lineToItem` = identity) on representative lines incl. edge cases
  (unmatched, orphan, promo, weighable, skew region, extra unknown keys).
- Backfill idempotency + row/line count parity.
- Mutation-site behaviour preserved (identical/similar/different) against rows instead of blob.
- Full existing suite stays green (823+).

## Future work (not in this migration)
- **OrphanAlias corpus + promotion:** recurring unmatched OCR accumulates votes; after K distinct
  users, auto-create a real SP in that chain and retro-link — how unscraped chains (Norfa) build
  catalog without receipt-time minting.
- SP form-variant splitting; admin re-resolution on rows.
