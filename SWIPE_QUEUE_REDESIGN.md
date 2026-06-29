# Swipe-queue redesign — spec & phased build

Status: **approved 2026-06-28**, building. Turns the swipe queue into (a) a way to fix
your *own* receipt's matches and (b) a way to help identify products globally — your
receipt always first, community work opt-in, same card + 3 swipes throughout.

## Confirmed behaviour

**Card B (receipt resolution):** one side = the line's matched product, other side = the
line's OWN OCR text + a band-crop of the receipt. Swipes (unchanged gestures):
- **identical** → confirm the line + mark price-verified.
- **similar** → keep the match, leave price unverified, flag wrong-variant/size.
- **different** (`skirtingi`) → demote: re-point to a same-chain runner-up ≥ auto-apply
  (0.85), else mint a **quarantined orphan** that keeps its price but is excluded from
  comparison until it gains peers. (A garbled / price≤0 line still creates **no** SP.)

**Mandatory post-scan flow:** at most **3** cards, always filled when related material
exists: up to **2** Card-B (most needs-human items) + **1** cross-store card (the **most
expensive** qualifying item, ties → ambiguity). Top up to 3 with cross-store → related
orphan → related-global. **One shot per item** — a reject/fast-swipe is never re-asked;
the system finishes it silently. Everything not carded is auto-resolved (system actions).

**Voluntary "Help identify products":** batches of **10 = 5** receipt-resolution + **5**
receipt-**related** global cards. Related = **same category AND a name-similarity floor**
(finite, never asks about unbought types). Receipt items exhausted → global-but-related.

**Suspicion surface:** itemConfidence band **S2 + S3**, ranked by **needs-human =
ambiguity × price-impact**; the few best become cards, the rest auto-resolve.

**System actions (no card):** auto-drop confidently-wrong, auto-repick an unambiguous
better same-chain match (Round-2 already does this), keep "probably right" with price
unverified, defer the rest to the admin queue. Each writes a "resolved" marker.

**Orphans:** a rejected item with no match → its own orphan (price kept, comparison-
excluded until merged). If the OCR item is **clearly** an existing orphan (high bar: name
+ form + plausible price) → **combine** instead of duplicating, serve it vs its best
categorized match: identical saves it (gains category), different leaves a standalone
orphan that builds its own price history. Orphan cards always pair orphan vs a
**categorized** product (never two uncategorised), reusing others' prior votes as a head
start. Orphans are voluntary-only EXCEPT they may enter the mandatory 3 when (a) there are
no other cards, or (b) a high-certainty OCR=orphan combine card exists.

## The 7 confirmed decisions
1. **Ask-once memory:** a separate durable per-line record (survives re-scans).
2. **Clean receipt:** always 3 cards, topped up from the related pool (fewer only if none).
3. **Relatedness:** same category AND name-similarity floor.
4. **Fast reject:** asked-but-unresolved — keep the system's best match, don't re-ask.
5. **Rejected price:** becomes a quarantined orphan (keep price, out of comparison).
6. **Orphans:** voluntary by default; mandatory only on (a) no other cards or (b) certain combine.
7. **Cross-store pick:** most expensive (ties → ambiguity).

## Phased build (each phase ships green)
- **Phase 0 — data foundation (no UI):** `needs-human` score per line (ambiguity ×
  price-impact, down-weighting clean new-product lines) computed in the save-time
  confidence loop; the durable per-line **resolution ledger** (table + model) for
  ask-once. Read-only groundwork.
- **Phase 1 — mandatory typed/capped sequence (server):** an ordered, capped sequence
  (≤3) replacing the client-only cap; Card-B sourcing (top needs-human S2/S3) + 1
  cross-store (most-expensive); ledger-driven one-shot suppression; mark asked on serve/vote.
- **Phase 2 — Card B rendering + line-vote route:** `cardKind` + `ocr` block on the card
  (both the server card shape and the app's duplicated copy); an OCR card-side renderer
  (plain remote crop image from a non-admin wrapper of the existing crop endpoint);
  `POST /receipt-line-vote` (identical→confirm+verify, similar→keep+flag, different→demote).
- **Phase 3 — relatedness scope + voluntary 5+5:** `getReceiptRelatednessScope` (categories
  + line names + chains) gating a re-scoped global fetch; reshape the voluntary cap to 5+5;
  related-tagging server-side; orphan rescue folded in as receipt-related.
- **Phase 4 — system-action driver + admin feed + tuning:** formalize the no-card
  auto-resolution path (each writes the resolved marker); feed needs-human into the admin
  queues; tune ambiguity/price/relatedness floors on real receipts.

## Key constraints (from the investigation)
- Card shape is **hand-duplicated** in `swipeQueueController.ts` and `app/swipe/queue.tsx` —
  edit both or they silently disagree.
- The existing `votedPairKeys` re-serve guard is SP-pair-scoped and **cannot** suppress a
  Card B (no second SP) — the per-line ledger is mandatory.
- Card B must route through `demoteReceiptLineDirect` (line-based), NOT the pair-based
  `demoteRejectedReceiptLine` (it skips self-pairs).
- The crop endpoint 422s on PDF receipts → Card B for PDF lines degrades to system actions.
- needs-human / ledger only populate on new saves — older receipts need graceful absence.
