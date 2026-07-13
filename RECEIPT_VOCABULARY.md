# Receipt-name Vocabulary (Issue H)

Learn how each chain **prints** a product on its receipts, so future receipts match the
same garbled OCR string by a *confirmed alias* instead of re-deriving it with fuzzy name
math every time. This is the durable fix for the OCR-name ≠ catalog-name problem (e.g. a
Rimi receipt prints `IKI SMULKINTA KIAUL IENA R` for the catalog SKU
`Smulkinta kiauliena riebumas ne did./kaip 20% dujose, IKI`).

Companion to [RECOGNITION_PIPELINE.md](./RECOGNITION_PIPELINE.md) (the matcher) and
[SWIPE_QUEUE_REDESIGN.md](./SWIPE_QUEUE_REDESIGN.md) (the voting cards).

---

## 1. The flywheel

```
user swipes a Card-B / pending-alias card
        │
        ▼
recordAliasVote  ──►  StoreProductReceiptAlias (+ …Vote)   ── learn (chain-scoped)
        │                       │
        │                 state machine (K-user consensus, balanced veto)
        ▼                       ▼
   canonical / similarity / rejected
        │
        ▼
findBestProductMatches  ──►  better matches, fewer orphans  ──►  fewer carded lines
                                                              ──►  more confident receipts
```

The loop is **self-reinforcing**: confirmed aliases make matching better, which means
fewer lines need swiping, which concentrates human attention on genuinely-new prints.

---

## 2. Data model — `sql/receipt_name_vocabulary.sql`

**`StoreProductReceiptAlias`** — one row per `(chainId, storeProductId, normalizedAlias)`.
- `normalizedAlias` — the OCR string run through `normalizeProductName` (the SAME
  normalization the matcher applies to a query, so alias↔query compare apples-to-apples).
- `rawSample` — an example of the original (un-normalized) printed text (for the card UI).
- `occurrences` — how many receipts printed it (surfacing priority).
- `identicalUsers` / `similarUsers` / `differentUsers` — **denormalized** distinct-user
  tallies (so the matcher reads canonical aliases without a join).
- `status` — `pending | canonical | similarity | rejected` (state machine §4).
- `adminVerdict` — `confirmed | rejected | NULL` — a manual override (forces status).
- `sampleReceiptId`, `firstSeenAt`, `lastSeenAt`.

**`StoreProductReceiptAliasVote`** — one row per `(aliasId, userId)` (latest vote wins).
Drives the distinct-user tallies (the K-user auto-promote) and the **no-repeat-combo**
rule (a user never re-sees an alias they've voted on).

> **CHAIN-SCOPED.** An IKI receipt's OCR may only ever teach an IKI-chain SP — the line's
> linked SP is always same-chain, and the cross-chain candidate fetcher intentionally
> does NOT attach aliases. Receipt prints are chain-specific.

---

## 3. Capture — `services/receiptLineVoteService.ts :: castReceiptLineVote`

A Card-B swipe (`POST /receipts/:id/lines/:idx/vote`, body `{ vote, userId }`) records the
verdict as an alias vote **before** applying the line effect:

| vote | line effect | alias vote recorded? |
|---|---|---|
| `identical` | confirm + price-verify (S1) | yes — **only when the matcher STRUGGLED** (`matchConfidence < autoApplyThreshold`), to skip redundant aliases the catalog name already matches |
| `similar`  | **DEMOTE** (a same-category *substitute* is a different product) | always — records a `similarity` alias (the L2 link) |
| `different`| demote (runner-up / orphan / OCR) | always — records a `different` vote (dissent + blacklist) |

`userId` flows: `SwipeQueue` Card-B vote body → `receiptController.submitReceiptLineVote`
→ `castReceiptLineVote(…, userId)`. Capture is **fail-open** — a learning miss must never
fail the vote.

---

## 4. State machine — `models/storeProductAliasModel.ts :: applyAliasVote`

Recomputed on every vote from the distinct-user tallies. `K = vocab.canonicalDistinctUsers` (=2):

```
adminVerdict==='rejected'                         → rejected
adminVerdict==='confirmed'                         → canonical
differentUsers > 0 && differentUsers >= identical  → rejected     (BALANCED VETO)
identicalUsers >= K                                → canonical
similarUsers > 0                                   → similarity
else                                               → pending
```

**Balanced veto** (a deliberate choice): a `different` vote rejects only when dissenters
*tie or exceed* the identical confirmers — so a single bad/edge vote can't overturn an
alias two users already confirmed, but a lone or contested alias is still vetoed.

`recordAliasVote` (by chain+SP+name, from a receipt line) and `recordAliasVoteById` (by
alias id, from a pending-alias card) both funnel through `applyAliasVote`.

---

## 5. Matching signals — `utils/productMatcher.ts :: findBestProductMatches`

`getStoreProductsByChainWithProductData(chainId)` attaches three alias lists per candidate
(via `fetchAliasesByChainGrouped`); the matcher uses each:

- **`canonical` → extra match target.** `scoreNameConfidence` is run against the catalog
  name AND every canonical alias; the best wins. A learned alias matches a garbled OCR
  line directly even when the catalog name can't.
- **`rejected` → suppression (no-repeat).** If the query EXACTLY matches a candidate's
  rejected alias, that candidate is skipped — never re-suggest a known-wrong match.
- **`similarity` → L2 hard-scope + L3 boost.** A first pass checks if the query exactly
  matches any candidate's similarity alias; if so, `scopeL2` = that SP's `categoryL2Name`
  and `boostL3` = its leaf `categoryName`. Then matching is **restricted to that L2
  family** and candidates in the boosted **L3** leaf get `+vocab.categoryScopeBoost`.
  *Why store the SP link, not a category column:* the SP carries the leaf L3, and L2 is
  L3's parent — we derive BOTH at match time, always current. L3 is only a *boost* (never
  a filter), so a substitute that's a sibling L3 costs at most a missed boost, never a
  wrong/missing match (L2 still contains it).

All three are **no-ops until votes accumulate** (no aliases → unchanged behaviour), which
is why the `receipts:matchaudit` harness stays at baseline after the change.

---

## 6. Pending-card surfacing (H3 — server done, client TODO)

Lets a *second* user confirm a pending alias so it reaches `canonical` faster than waiting
for two independent identical captures.

- **Server (DONE):** `fetchPendingAliasCards(userId, chainId|null, limit)` returns pending
  aliases the user hasn't voted on, SP + `rawSample`, most-seen first.
  `GET /api/users/:userId/alias-cards?chainId=&limit=` → `{ cards }`.
  `POST /api/users/:userId/alias-votes { aliasId, vote }` → `recordAliasVoteById` → `{ ok, status }`.
- **Client (DONE — verify on device):** `SwipeQueue.tsx` `PendingAliasCard`/`isAliasCard`
  + `AliasOcrSide` (OCR text vs SP), fetched in `loadQueue` (`GET /alias-cards?limit=3`,
  appended to the voluntary queue) and voted via `sendVote` (`POST /alias-votes`). Reuses
  the Card-B gesture/labels/question header. tsc-clean; the swipe-card rendering + vote
  flow still want a device pass.

---

## 7. Tunables — `shared/recognitionConfig.ts`

```ts
match.autoApplyThreshold   = 0.85   // the capture "struggled" gate
vocab.canonicalDistinctUsers = 2    // K — distinct identical voters → canonical
vocab.categoryScopeBoost   = 0.07   // L3-leaf nudge under an L2 similarity-scope
```

---

## 8. File map

| Concern | File |
|---|---|
| Schema | `souply-api/sql/receipt_name_vocabulary.sql` |
| Model (capture, state machine, fetches, pending cards) | `souply-api/src/models/storeProductAliasModel.ts` |
| Capture hook | `souply-api/src/services/receiptLineVoteService.ts` |
| userId threading | `souply-api/src/controllers/receiptController.ts` (`submitReceiptLineVote`) · `souply-app/components/swipe/SwipeQueue.tsx` (Card-B vote body) |
| Matching signals | `souply-api/src/utils/productMatcher.ts` (`scoreNameConfidence`, scope/suppress/boost) · `souply-api/src/models/storeProductModel.ts` (attach aliases) |
| Pending-card API | `souply-api/src/controllers/storeProductAliasController.ts` · `souply-api/src/routes/swipeQueueRoutes.ts` |
| Vocab-driven queue (slot-1 alias bridge) | `souply-api/src/models/slot1CandidateModel.ts` (`bestCrossChainSimilarity`) · `storeProductAliasModel.fetchCanonicalAliasesForSps` |
| Tunables | `shared/recognitionConfig.ts` (`vocab`) |
| Tests | `souply-api/tests/productMatcher.test.ts` (alias match, rejected, L2-scope) · `tests/receiptLineVoteService.test.ts` (demote-on-similar) |
| Off-DB measurement | `npm run receipts:matchaudit` (`src/scripts/receiptBatch/matchAudit.ts`) |

---

## 9. Status & roadmap

- **H1 — capture + alias matching.** DONE.
- **H2 — consensus (all 3 votes, demote-on-similar, balanced veto).** DONE.
- **H3 part 1 — L2-scope + rejected-suppression.** DONE.
- **H3 part 2 — vocab-driven queue.** DONE (server). `slot1CandidateModel.bestCrossChainSimilarity`
  scores each cross-chain identity pair over both products' catalog names AND their
  canonical receipt-name aliases (`fetchCanonicalAliasesForSps`, targeted) — so a learned
  print bridges identity pairs the catalog names miss. Strictly additive (best-of), no-op
  until aliases exist. Bounded: canonical aliases only, within the existing category-scoped
  candidate set. *Future:* cross-category alias bridging (slot-1 currently requires same
  category) + extend slot-2/OSC seeding the same way.
- **H3 part 3 — pending-card surfacing.** server + client DONE (§6); client swipe UI needs a device verification pass.
- **H4 — admin curation tab.** DROPPED for now; the SP unjoin/split process covers bad
  groupings. `adminVerdict` columns remain for a future tab.
- **Related roadmap — SP-splitting votes:** surface card combos of two SPs grouped under
  ONE Product to check they're really the same (today we only JOIN, never split).

## 10. Deploy

Apply `sql/receipt_name_vocabulary.sql` to **dev → staging → prod** before shipping the
souply-api backend (it's a hard dependency of the model). Validate matcher changes with
`npm run receipts:matchaudit -- --baseline <snapshot> --assert` (the receipt-203 → #60946
canary). Aliases accumulate organically as users swipe; there's no backfill.
