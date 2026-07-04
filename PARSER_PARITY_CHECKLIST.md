# CROSS-CHAIN PARSER RE-TEST CHECKLIST (Maxima / Lidl / Norfa / Rimi vs IKI)

Sources: `shared/parsers/{maximaParser,lidlParser,norfaParser,rimiParser}.ts` audited against `shared/parsers/ikiParser.ts`. Capability IDs (A1…F6) refer to the IKI inventory.

Legend: ✅ present/equivalent · ⚠️ partial · ❌ gap (missing but applicable) · — genuinely N/A (layout/architecture)

> **STATUS 2026-07-03 — the "generic transfers" batch (§2) is IMPLEMENTED on dev** (app 711 / api 976 tests green):
> receiptNo/date-time bail hardening (Maxima+Rimi stems + synthetic ids; Lidl+Norfa independent tolerant scans),
> isWeighable + weighed price-poisoning guard (all four + service threading), Norfa savings fix (+ truth files),
> discount plausibility clamps (all four), doubled-scan gate tokens (all chains), PLUS overlap-based receiptNo
> dedup (any distinctive id witnesses a duplicate; IKI segment-corroboration witness). Items marked
> [KNOWN GAP] for these capabilities are now [protected] — re-judge during testing. Deferred: tilt/de-skew +
> per-corner bands (measure severity with the tilted-photo items first), F5 skip bands, F4-app field bands.

## 1. GAP MATRIX

| Capability | MAX | LIDL | NOR | RIMI | Note |
|---|:-:|:-:|:-:|:-:|---|
| A3/A11 Tilt/curve de-skew of rows | ❌ | ❌ | ❌ | ❌ | All four use raw-Y matching; tilted photos swap names/prices across products |
| A4 Pitch-aware row-merge threshold | ❌ | ❌ | ❌ | ❌ | All use fixed ~30 px constants (resolution-blind) |
| A10 iOS fragment merge/dedup | ✅ | ✅ | ✅ | ✅ | Lidl's quality-scored dedup is best-in-codebase; Norfa/Rimi run merger unconditionally |
| A9 Fused-line splitting | ⚠️ | ✅ | ⚠️ | ✅ | MAX: stacked-products fusion loses a product; NOR: single tail split only |
| A7/B7 Discount minus handling | ❌ | ⚠️ | ⚠️ | ✅ | MAX: stranded minus MINTS a fake product; NOR: foreign-discount mis-attribution bug (`1427-1433`) |
| C1/A8 Deposits (garbles, refunds) | ✅ | ✅ | ⚠️ | ⚠️ | NOR: refund wording unhandled; RIMI: `Uzstatas` (ž→z/2) mints phantom item |
| B1 Weighed detection glyph tolerance | ✅ | ⚠️ | ⚠️ | ⚠️ | LIDL: kg-garble kills unit line; NOR: strict anchor digits; RIMI: no EUR→FUR class |
| B2/B5 Calc recovery (ppu↔total, qty) | ⚠️ | ⚠️ | ❌ | ⚠️ | Dropped anchor/total ⇒ product silently vanishes into neighbour's name (L/N worst) |
| B3 Weighed price-poisoning guard | ❌ | ❌ | ❌ | ❌ | Unreadable weight line ⇒ fraction-of-kg total persisted as unit reference price |
| isWeighable emitted to server | ❌ | ❌ | ❌ | ❌ | No chain sets it (IKI queue path drops it too); resolver's weighable gate inert |
| B6 Twin recovery | — | — | ❌ | ⚠️ | NOR prints N identical rows AND dedups names ⇒ lost twin leaves zero trace |
| B8 paid≥0 / d≤price discount clamp | ❌ | ❌ | ❌ | ❌ | Misread savings ⇒ negative promo price shipped, all four |
| C2 Bag/coupon skips | ✅ | ✅ | ⚠️ | ✅ | NOR: `mai[sš]` matches anywhere — "Maišytos salotos" skipped as a bag |
| C3 Receipt-level bundle discount | — | ⚠️ | ⚠️ | — | LIDL: aggregated Lidl-Plus block may fold into LAST item's promo; NOR: NUOLAIDA KVITUI ignored |
| C5/E1 Header-junk strip on product 1 | ⚠️ | ❌ | ❌ | ❌ | Garbled header boundary ⇒ junk prefixes first product's name (IKI r206 class) |
| C6 Doubled-scan gate effective | ❌ | ❌ | ❌ | ✅ | App gate regex is IKI/Rimi slash-shaped; INERT for M/L/N; interactive path only |
| C7 Footer-start markers | ✅ | ✅ | ✅ | ✅ | All independently solid |
| D1 Total multi-form + itemSum fallback | ⚠️ | ⚠️ | ❌ | ⚠️ | None has the plausibility fallback; NOR also has the `??` neighbour bug + convention drift |
| D2 Date/time garble tolerance | ⚠️ | ❌ | ❌ | ✅ | LIDL/NOR: ONE strict single-line regex; Lidl garble ⇒ whole-receipt RETAKE bail |
| D3 ReceiptNo garbles + fallback id | ❌ | ✅ | ✅ | ❌ | M/R: one garbled "Kvito" hard-bails the ENTIRE scan; Lidl's voting is better than IKI |
| D4 Savings | ✅ | ⚠️ | ❌ | ✅ | NOR **BROKEN**: reads loyalty accrual base (63,07 € on a 78 € receipt) as savings |
| D5 PII mask bands (app-level) | ✅ | ✅ | ✅ | ✅ | Chain-generic `cardMaskDetection.ts`; verify labels on-device |
| E2 Address extraction | ✅ | ⚠️ | ✅ | ✅ | LIDL: HQ "Viršuliškių skg." may win over store address |
| E3 Chain-detect fallback | ✅ | ✅ | ⚠️ | ✅ | NOR prints NO VAT code — zero secondary fingerprint |
| F6 Band geometry emitted at all | ✅ | ✅ | ✅ | ✅ | All flat rects — overlay never bandless |
| F1 Skew-aware (per-corner) bands | ❌ | ❌ | ❌ | ❌ | Only IKI thermal emits corners; renderer falls back flat safely |
| F5 Skip bands (grey) in overlay | ⚠️ | ❌ | ❌ | ❌ | Bags/deposits render as unexplained holes |
| F4-app Interactive flow keeps field bands | ❌ | ❌ | ❌ | ❌ | Only `applyIkiResult` passes lineRegions; rehydration compensates later |
| Regression tests exist | ❌ | ⚠️ | ❌ | ❌ | MAX: 0 jest (e-receipt truths only); LIDL: 2 files; NOR: 0 (harness blind to savings/total); RIMI: 0 |

---

## 2. GENERIC TRANSFERS WORTH DOING **BEFORE** TESTING

These otherwise waste a whole testing round (scans bail before revealing anything else, or tests actively corrupt dev pricing data):

1. **Key-field bail hardening** — Maxima+Rimi: receiptNo stem-garble classes (`[KA][vouy]ito`) + synthetic date-time-total fallback id; Lidl+Norfa: scan date and time INDEPENDENTLY with separator/space garble classes. Today one garbled character in one footer row = `ensureKeyReceiptFields` retake-bail on the whole receipt (receipt-process.tsx:2291-2327) — every such test scan dies at the gate and tests nothing downstream.
2. **isWeighable + poisoning guard (all four + IKI queue path)** — set `isWeighable: unit==='kg'` in each parser's product, map it through `receiptProcessingService` (also fix `processIki` rawProds dropping it, :592-601); add IKI's "show it, never write price" rule (kg detected + ppu unrecoverable ⇒ price=0/ppu=null). Without this, every blurred-weighed test scan WRITES a fraction-of-kg total into dev reference pricing.
3. **Norfa savings fix (D4)** — savings = Σ per-item `-N,NN EUR` + |NUOLAIDA KVITUI|; stop reading NUOLAIDA PREKIŲ SUMAI (accrual base); fix the truth files in the same pass. Every Norfa loyalty receipt currently shows absurd "sutaupyta" — footer testing is meaningless until fixed.
4. **Discount plausibility clamps (all four)** — paid≥0 / d≤price guard before promoPrice ships. 1-3 lines per chain.
5. **Doubled-scan gate tokens** — extend the app gate (receipt-process.tsx:2569) with per-chain duplicate tokens: Maxima `Kvito Nr. \d+` / `Dokumento numeris`, Lidl `Kvitas \d+/\d+` (NOT `#00NNNNN` — legitimately prints twice), Norfa `# Kvito numeris (\d+) #`.

DEFER but SIZE during testing: tilt/de-skew + per-corner bands (A3/A11/F1, all four) — big change; use the tilted-photo test items below to measure how bad it actually is per chain first.

---

## 3. MAXIMA

Parser: `shared/parsers/maximaParser.ts` · line-based, price-line anchors, helper rows below · NO jest tests (e-receipt truths in `shared/receipts/maxima/` only — thermal classes uncovered)

### What to test
- [ ] 1. Straight, well-lit receipt: weighed item (bananas) + multipack `X N vnt.` — prices per-unit, qty right **[protected — B1/B5]**
- [ ] 2. Tilted capture ~5-10°: every name with its own price; Items-tab crops don't cut neighbours **[KNOWN GAP — A3/F1: expect cross-band leakage + flat-band bleed; record severity]**
- [ ] 3. AČIŪ discounts: promo correct, label never a product name **[protected — B7/C4]**; watch for NEGATIVE promo price **[KNOWN GAP — B8]**
- [ ] 4. Weighed item with blurred/covered unit-qty row **[KNOWN GAP — B3: expect price=line-total, unit=vnt poisoning]**
- [ ] 5. PET bottle + can (both deposit genders): absorbed, no phantom "PET (depozitinis)" item **[protected — C1/A8]**
- [ ] 6. TAISYMAS correction receipt: voided line skipped **[protected — C1]**
- [ ] 7. Bag purchase: skipped; note what overlay shows over the bag row **[protected C2 / ⚠️ F5]**
- [ ] 8. Blur "Kvito Nr.": expect HARD BAIL of whole scan; check "Dokumento numeris" rescues **[KNOWN GAP — D3, top gap]**
- [ ] 9. Blur totals block: saves with null total — check savings/compare rows **[KNOWN GAP — D1]**
- [ ] 10. Same receipt doubled in frame: NO bail expected **[KNOWN GAP — C6 inert; inspect saved mess]**
- [ ] 11. Cover MAXIMA logo, PVM line visible: VAT fallback routes correctly **[protected — E3]**
- [ ] 12. AČIŪ card + cashier line masked **[protected — D5]**
- [ ] 13. iOS pass of 1-3: fragment merger, phantom band on price-dropped row **[protected — A10/F2]**
- [ ] 14. Camera-flow receipt vs queue-flow: header/footer field bands asymmetry **[KNOWN GAP — F4-app]**
- [ ] 15. Long wrapping first-product name: no header junk in name **[⚠️ C5/E1]**
- [ ] 16. Pack-size variant (ZEWA rolls): expect size-blind match **[KNOWN GAP — parsedAmount never set + cleanProductName strips size]**

### Gaps → fix sketches (priority order)
1. **D3 receiptNo** — stem-garble regex + synthetic date-time-total fallback id (unblocks the hard bail).
2. **A3/A11/F1 tilt** — median-slope de-skew before the same-row overlap test (:903); emit per-corner bands (renderer already falls back flat).
3. **A7/A9 fusion** — capture the sign in `PRICE_RE` so a stranded minus can't anchor; re-run `splitMergedLines` on the `left` half (:381-383) for stacked-product fusions.
4. **B3 + isWeighable** — poisoning guard + `isWeighable: unit==='kg'` on `MaximaProduct`.
5. **C6** — Maxima dup-token in the app gate.
6. **D1** — space-as-decimal, Grynieji−Grąža, itemSum plausibility fallback.
7. **Pack-size defect** — assign `parsedAmount/parsedUnit` from the size token BEFORE `cleanProductName` strips it (:661-666).
8. **F4-app** — pass `lineRegions` through `applyMaximaResult` setHeader/setFooter.
9. **D2** — dot/doubled-hyphen date + `15: 02` time tolerance. 10. **B8** clamp; preName runaway cap; header garble tier.

---

## 4. LIDL

Parser: `shared/parsers/lidlParser.ts` · line-based V2 hard walls, 9 fused-anchor splitters · tests: only `lidlMultibuyUnitPrice` + `lidlReceiptNo`

### What to test
- [ ] 1. Lidl-Plus receipt with discounts: does EACH item show its own promo, or does the LAST item absorb one giant discount? Compare footer vs items **[KNOWN GAP — C3/P5: aggregated block fold; checklist item #1]**
- [ ] 2. Multi-buy where the qty row prints BELOW the price (beer/deposit): **[KNOWN GAP — B5a: expect qty=1, price=LINE TOTAL as unit price — the `Šv.alus 2,90` class]**
- [ ] 3. Weighed produce: clean shot → €/kg OK **[protected — B2 dir-1]**; blurred unit line → nonsense unit price **[KNOWN GAP — B1/B3 poisoning]**
- [ ] 4. Datetime row partially garbled: expect whole-receipt RETAKE bail **[KNOWN GAP — D2, P1 — the most user-visible Lidl gap]**
- [ ] 5. Deposit + deposit RETURN on one receipt: deposits fold in, returns vanish, no phantoms **[protected — C1]**
- [ ] 6. TAISYMAS void: corrected line absent, total right **[protected — C7 excision]**
- [ ] 7. Tilted ~5-10°: band overlay + swipe-card crops bleed **[KNOWN GAP — A3/F1/P8]**
- [ ] 8. Header pill address: STORE or Lidl HQ (Viršuliškių skg.)? **[KNOWN GAP — E2 first-match]**
- [ ] 9. Receipt number present on every scan; cross-check Dokumento numeris **[protected — D3 voting, better than IKI]**
- [ ] 10. Total on a receipt with faint "ė" in Mokėti: band appears but value null? **[KNOWN GAP — D1 diacritic mismatch between value scan :555 and band scan :1753]**
- [ ] 11. Doubled frame: NO bail expected **[KNOWN GAP — C6 inert]**
- [ ] 12. iOS dense receipt (20+ items): duplicate-reading dedup quality, no twins/collapses **[protected — A10, strongest in codebase]**
- [ ] 13. Stained/cropped top: first product's name free of PVM/UAB/Kvitas junk **[KNOWN GAP — C5/P6]**
- [ ] 14. Card PAN + Lidl Plus number masked **[protected — D5]**
- [ ] 15. Barcode hygiene: no leading/trailing 6-7-digit barcodes in names **[protected — A9]**

### Gaps → fix sketches (priority order)
1. **P1 D2** — independent date + time scans with `[:.\-]`/space garble classes (transfer IKI D2).
2. **P2 lost anchor** — lenient-anchor rescue pass; the regexes ALREADY EXIST dead in the file (`PRICE_LIKE_RE` :131, `UNIT_LENIENT_RE` :182 etc.) — wire or delete.
3. **P3 B5** — actually EXTRACT postAnchor unit lines (:1945-1960 reads only discounts) and split UNIT_HEAD/TAIL halves (:1925 checks only UNIT_LINE_RE).
4. **P4 B3** — poisoning guard (needs a kg signal that survives unit-line loss, e.g. kg-in-name).
5. **P5 C3** — if aggregated Lidl-Plus block confirmed on-device: footer.comboDiscount-style field instead of last-band fold.
6. **P6 C5** — header-junk strip for the both-header-rows-garbled fallback.
7. **P7 D1** — stripDiacritics in the Mokėti VALUE scan + Tarpinė/itemSum fallbacks.
8. **P8** tilt de-skew + corners. 9. **P9** gate token `Kvitas \d+/\d+`. 10. **P10** promo≥0 clamp, same-line Nuolaida value, negative fused-tail splitter; fix stale "no Lidl catalog" header comment.

---

## 5. NORFA

Parser: `shared/parsers/norfaParser.ts` · anchor = `N,NN M1|M5`, weighables inline `0,316x3,85 1,22 M1` · NO jest tests; batch harness blind to savings AND two zero-total truths

### What to test
- [ ] 1. Weighed item inline form: kg, qty, ppu correct; also one with qty/ppu on the line ABOVE (partial-buy path) **[protected — B1]**
- [ ] 2. Integer multi-buy `2x2,15 4,30 M1`: qty=2, vnt **[protected — B5]**
- [ ] 3. **TWINS**: buy 2+ identical items (and weigh two bags of same produce) — count items vs receipt **[KNOWN GAP — B6: a garbled twin is silently DELETED by name dedup, zero trace]**
- [ ] 4. Discounted item `Nuolaida 33%` + `-0,78 EUR`: promo on the RIGHT product; product ABOVE didn't lose/steal it **[KNOWN GAP — A7 mis-attribution bug at :1427-1433]**
- [ ] 5. Bags skipped; then a "Maišytos salotos"-type product NOT skipped **[KNOWN GAP — C2 `mai[sš]` anywhere-match trap]**
- [ ] 6. Bottle deposit `*Užstatas … PET`: skipped, previous price unaffected; if a taromat REFUND prints, capture exact wording (unhandled) **[⚠️ C1]**
- [ ] 7. Footer: WHICH number is total — KVITO SUMA or SUMA? **[KNOWN GAP — D1 convention drift + `??` neighbour bug]**; savings vs printed NUOLAIDA KVITUI + item discounts **[KNOWN GAP — D4 BROKEN: expect accrual base ~80% of total shown as "sutaupyta"]**; date+time populated **[KNOWN GAP — D2 strict]**
- [ ] 8. Overlay: flat capture bands hug rows **[protected — F6]**; tilted/curled → drift **[KNOWN GAP — A3/A11]**; bags/deposits = holes **[KNOWN GAP — F5]**; field bands appear after save+reopen (rehydration) **[⚠️ F4-app]**
- [ ] 9. Doubled frame: NO bail **[KNOWN GAP — C6 inert]**
- [ ] 10. iOS pass of 1-2: label/value splits, anchor glue **[protected — A10 equivalent]**
- [ ] 11. Stained header: chain still detected via mid-body "NORFA PE maišelis" rows — but a bagless stained receipt has NO fallback (no VAT code printed) **[⚠️ E3]**
- [ ] 12. Long receipt (25-30 items, dense identical rows): item count EXACT; watch one band absorbing a run **[KNOWN GAP — no MAX_BLOCK cap]**
- [ ] 13. After saving a kg item: server got a weighable signal + ppu matches printed €/kg **[KNOWN GAP — isWeighable/B3]**

### Gaps → fix sketches (priority order)
1. **D4 savings** — per-item discounts + NUOLAIDA KVITUI; drop NUOLAIDA PREKIŲ SUMAI; fix `.truth.json` files + make compareToTruth score savings.
2. **D1 total** — mergeRowFragments on the footer slice too; fix `lines[i-1] ?? lines[i+1]` (next line unreachable); add Mokėti/cash forms + itemSum plausibility; pick ONE total convention.
3. **B1 anchor + B6 twins** — digit-glyph classes on the leading `\d+` and `M[15]` (l/I→1); twin-adoption pass; items-vs-total sanity check.
4. **B2/B3** — qty×ppu↔total reconcile before ppu ships as chain reference price (:558-564).
5. **A3/A4** — de-skew + pitch-relative merge threshold (the prior audit's named Norfa win).
6. **C6** — dup `# Kvito numeris (\d+) #` gate token.
7. **C5** header strip for product 1 + **B7/B8** minus-dropped fold and clamps.
8. **D2** date/time tolerance; **C8** diacritic fold; **F5** skip bands; **E3** `N0RF` garble class; fix C2 bag regex to name-START anchored.

---

## 6. RIMI

Parser: `shared/parsers/rimiParser.ts` · line-based hard-walled bands, `X,YY A|B` anchors · **ZERO tests** — snapshot receipt-55/56 shapes before touching anything

### What to test
- [ ] 1. Weighed produce (bananas + €/kg cheese): unit=kg, qty, ppu **[protected — B1]**; then check server resolution didn't orphan them **[KNOWN GAP #1 — isWeighable never emitted, resolver gate inert]**; blurred weight row → line total stored as unit price? **[KNOWN GAP — B3]**
- [ ] 2. Discounted item: Nuol./Galut. on THAT product, incl. when the discount row is the LAST line before SUTEIKTOS NUOLAIDOS **[protected — A7/B7]**; misread savings → negative promo **[KNOWN GAP — B8]**
- [ ] 3. Multi-buy: 2× same item ONE beep **[protected — B5]** AND 2× same item SEPARATE beeps **[verify — B6: garbled anchor ⇒ doubled name, one price]**
- [ ] 4. Deposit can/bottle: no phantom "Užstatas" product **[protected — C1]**; if OCR yields "Uzstatas/U2statas" → phantom €0,10-0,30 item **[KNOWN GAP — ž-garble]**
- [ ] 5. Bag: skipped; grey band missing in overlay **[KNOWN GAP — F5]**
- [ ] 6. Footer: total matches printed Mokėti on card AND cash (rounding row) receipts **[protected D1 forms / KNOWN GAP — no itemSum net if "Mokėti" itself garbles]**; blur the Kvito line → expect FULL-RECEIPT bail **[KNOWN GAP — D3, #2]**
- [ ] 7. Loyalty receipt: PAN masked, PIRKĖJAS block not in product 1 **[protected — C4]**; then a NO-CARD receipt → header junk on product 1? **[KNOWN GAP — C5 firstPrice−2 fallback]**
- [ ] 8. Tilted ~5-10°: names/discounts stay with their products; overlay rects **[KNOWN GAP — A3/F1, lower incidence on Rimi but ugly]**
- [ ] 9. Stained/dark header: VAT fallback detects chain **[protected — E3]**
- [ ] 10. Doubled frame: doubled_scan bail FIRES **[protected — C6, the only non-IKI chain where it works; interactive path only]**

### Gaps → fix sketches (priority order)
1. **isWeighable** — one field: `isWeighable: unit==='kg'` on RimiProduct + map through service (fix `processIki` dropping it in the same pass, receiptProcessingService.ts:592-601).
2. **D3 receiptNo** — `[KA][vouy]ito` stem classes + synthetic date-time-total fallback id (kills the whole-scan bail).
3. **B3** — `weighedNoPpu` analogue: all three weight regexes fail + kg hint ⇒ price=0/ppu=null.
4. **D1** — itemSum plausibility fallback + Grynieji−Grąža last resort (users already read the server-estimate fallback as a parser bug, per the file's own comment :259-263).
5. **C1** — widen DEPOSIT_PATTERN to `/[uūü][žz2]stat/i`.
6. **C5** — header-junk strip backstop for the no-PIRKĖJAS fallback.
7. **A3/A4** — de-skew + pitch-relative thresholds (walls are raw yCenter).
8. **B1** — EUR→FUR glyph class in WEIGHT_RE/WEIGHT_RATE_ONLY_RE.
9. **B8** clamp. 10. **F5** emit the declared-but-unused 'skipped' RegionKind. 11. Doubled-hyphen dates + display-name diacritic fold. 12. **Tests** — first deliverable before any fix: fixtures for the receipt-55/56 weighed shapes documented in the comments.

---

## 7. CROSS-CHAIN NOTES FOR THE TESTING SESSION

- **Test on dev DB** — items 1/3/4 in several chains deliberately write poisoned weighed prices; do poisoning tests LAST or after transfer #2 is in.
- The doubled-scan gate and `ensureKeyReceiptFields` bails exist ONLY in the interactive camera path — the queue pipeline never runs them; test both paths where marked.
- Field bands (header/footer) in the interactive flow are IKI-only today; other chains recover them via rehydration on reopen — "missing right after scan, present after reopen" is the F4-app gap, not a new bug.
- Reverse transfers worth stealing later (not blockers): Lidl's duplicate-reading dedup + receiptNo voting, Rimi's reconcile-and-bounded-self-heal + extractPackSize, Maxima's phantom "price-dropped" bands, Norfa's dedupRepeatedText + cross-line digit merge.
