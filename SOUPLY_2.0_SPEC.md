# Souply 2.0 — Unified Shopping Journey (spec + drill decisions)

Source: user spec ("souply 2.0 specs.txt", 2026-07-16) + screen-by-screen drill decisions.
Stage names are INTERNAL ONLY — never user-visible.

## Tabs
`Naršyti / Apsipirkimai / Šablonai / Profilis`.
- Šablonai = current templates top-tab, promoted to its own tab, unchanged behavior.
- Lists + Receipts move to **Profilis** as buttons above Voting history (management/history views only).
- Profilis additionally gains: notification **bell** (next to settings) and the monthly **"Mano planavimo balas"** card (below "Sutaupyta šį mėnesį", with Δ vs previous month).

## Core object: Apsipirkimas (trip)
Aggregate root. Stages 1–5 are **derived from per-store slot states**, never stored directly.

| Stage | Meaning | Card CTA |
|---|---|---|
| 1 | basket forming (current Juodraštis) | "Rasti parduotuvę" |
| 2 | store search done, plan not chosen→list (current Vykdomas) | "Sukurti sąrašą" |
| 3 | list(s) created, shopping | "Surinkti prekes" |
| 4 | store(s) confirmed, receipt(s) missing | "Įkelti kvitą" |
| 5 | all receipt slots filled/skipped | "Statistika" |

### Foundation schema decisions (build-compatible now, even if UI comes later)
- `Apsipirkimas` aggregate + **`TripMember`** (userId, role owner/member, joinedAt). Membership is OPEN
  (any user via invite), decoupled from household.
- **Receipts 1:N per trip** keyed by store slot; extra receipts allowed as "papildomas"
  (count into spend stats, don't fight slots or the dup-catcher).
- **`uploaderUserId` on every trip-receipt link** (future bill-splitting payer field; splitting itself OUT of scope).
- **Stats computed per (trip, member)** — shared trips credit every member.

### Lifecycle
- Auto-archive on inactivity: stages 1–2 after **48 h**, stages 3–4 after **7 days**. Archived trips:
  no notification-dot contribution, never an auto-add target, shown in a collapsed "Archyvas" section,
  tap = explicit resume (unarchive).
- Notification dot on the tab = count of non-archived trips in stages 1–4.
- Calendar (Apsipirkimai tab filters): dot per trip anchored to **best-known shopping date**
  (receiptDate → list-completion date → creation date; migrates as the trip progresses). Stage ≥3 dots
  colored by store chain; stages 1–2 = souply pink. Shops filter (multi-select) covers stage ≥3 trips only.

## Sharing model
- **Household: exactly ONE per user (v1).** "Sukurti šeimos sąrašą" card at top of Apsipirkimai with QR.
  QR = universal link (same infra as template slugs): app installed → join household; else web landing →
  store (Play closed-testing signup for now). Joining another household prompts leaving the current one.
- **Shared basket = persistent household singleton** — never completes; trips PULL items from it
  (check off → drop into the trip basket). No "new vs existing" decision exists for shared.
- **Personal basket = trip-scoped draft with 48 h expiry**: next add after expiry silently starts a fresh
  draft (toast "Pradėtas naujas krepšelis"; old one archived, recoverable).
- **Add-to-basket UX (act-then-correct, no upfront modal):** one tap adds to the smart default —
  sticky last-used destination (session-scoped, few-hour decay, fallback personal). Toast
  "Įdėta į bendrą krepšelį · Keisti" moves the item inline. Amount-picker modal carries a small
  Personal ⇄ Shared chip (zero extra taps on the default path).
- **Shared trips**: invite any user by handle / email / QR (TripMember). All members see the list live
  (existing 3 s polling), all accrue stats, ANY member may upload the receipt (dup-catcher enforces single).
  Claimed/joined trips score planning **neutral-by-default, positive on good match** — participation never hurts.

## The ONE map (Find-My pattern)
Single map surface hosts: store results, receipt store-resolution, home/work/other point-picking.
- Floating glass bar (iOS liquid glass; Android similar w/ more transparency) + 3-detent sheet:
  closed pill / ~50% / full — full expands edge-to-edge (floating bar morphs to sheet).
- Bar items are per-stage: 1: Krepšelis, Parduotuvės, Parinktys · 3: +Sąrašas · 4: +Kvitas · 5: +Statistika.
- **Zero-decision search**: tapping "Parduotuvės" runs the search immediately with defaults
  (current GPS location + 1 store). Compact **1|2|3 selector at the top of the map** re-splits live.
  Store count REMOVED from Parinktys; replaced by **"Pridėti narį"** (handle/email/QR).
- **Stacked sheets (Find-My):** Parduotuvės list ranks **PLANS** (combos; single-store mode = 1-store plans).
  Tap a store (pill or row) → **Store sheet** (name/address/distance, Maršrutas button,
  "Pirkimo planai su šia parduotuve" ranked rows incl. "Vien tik čia"). Tap a plan → **Plan sheet**
  (store chips, per-store split + subtotals, big "Sukurti sąrašą"). Max depth 3, X top-right pops one level,
  collapsed states show one-line summaries. Plan = the unifying object (no single/multi special-casing).
- **Pick modes** (home/work point, receipt store-resolution): sheet collapses, Cancel top, bar morphs to a
  single Patvirtinti action; confirm returns to the previous mode. Ad-hoc (no-trip) resolution reuses the
  same map component as a standalone full-screen (today's StoreResolutionOverlay behavior).
- Stage 3 map: only list-related stores; pills show check progress (e.g. 2/10).

## Stage 3 — list
Current ShoppingListDetail re-housed in the sheet (chips per store, check-offs, search+add).
Basket becomes read-only from stage 3. **Per-store mini-cycles**: each store slot has its own
shop → confirm → receipt-slot loop; confirming ONE store immediately opens ITS receipt upload while the
other store stays shoppable. Parinktys gains: share list QR.

## Stage 4 — receipt
Kvitas bar item: per-store slots (multi-store trips). Upload/photo → current recognize → mandatory swipes →
results (legacy Items list) + two buttons: **Pilnas kvitas** (photo view w/ bands + legend) and
**Padėk atpažinti** (voluntary SwipeQueue).
- **Soft chain gate**: wrong-chain receipt prompts "Susieti su šiuo apsipirkimu?" — accept → slot filled,
  marked *kita parduotuvė*, planning-score penalty; decline → becomes ad-hoc receipt.
- **Ad-hoc receipts** (Profilis upload, no trip): create a **list-less trip born at stage 5**, marked
  "neplanuotas", never contributes to the dot; mild fixed planning-score negative (drives toward
  "impulsive shopper" only with sustained ad-hoc-only behavior — a single upload barely moves it).

## Stage 5 — stats
Bar: Sąrašas (flat planned items) / Kvitas / Statistika.
- Two big cards: **Sutaupyta / Galėjai sutaupyti** → tap opens the store-comparison diagram (existing
  receipt summary component).
- **Planavimo balas** (per trip): coverage (matched list items ÷ list items) + discipline
  (matched receipt spend ÷ total receipt spend — € weighted so a €15 impulse hurts more than a snack) +
  precision (amount/weight accuracy on matched pairs) − penalties (wrong store, ad-hoc).
  Tap → matching interface: list↔receipt pairs, manual connect/unconnect ONLY within the
  **plausible-candidate set** (same category family OR name-sim floor — the swipe-queue relatedness scope);
  amounts not editable; score updates live. Manual links earn slightly less credit than auto links.
- Below: the Profilis carousel scoped to this trip — skip per-chain breakdown when 1 store; category donut
  for this receipt; **monthly bar graph with THIS receipt's contribution segment highlighted**
  (position within the month's bar by chronology: first=bottom / middle / last=top; opening an old trip
  auto-selects its month).
- Monthly planning score = aggregation of trip scores + ad-hoc negatives → the Profilis card.

## Ranking signal: receipt_buy
New `ProductInteraction` type **`receipt_buy`, weight 5** (> list_check 3). Fired in receiptSaveService
per resolved line (S1/S2 links only), once per line (NOT per qty), initial save only (idempotent — never on
reparse/autosave). Stage-5 manual link on a previously-unresolved line also fires it. Optional backfill
script over existing ReceiptItem rows. Everything downstream (decay, personal/global blend, discounts)
inherits automatically.

## Push notifications
- `expo-notifications` + Expo push service (free). New native module → ships with 2.0 binaries.
- `PushToken` (userId, token, platform) + **`Notification` inbox table** (userId, type, payload, readAt) —
  inbox is the source of truth, push is the doorbell (works without push permission; bell badge via polling).
- v1 types: trip invite, household invite → tap opens accept/decline confirmation modal.
  Future types (price alerts…) = new `type` values, no schema change.
- Email invites to non-users: email carries the join link; pending on sender's side until claimed.

## Savings metrics (decided 2026-07-16)
NEVER use store-printed savings (inflated-base-price marketing). Both cards derive from OUR cross-store
calculation, using the comparison service's existing store selection (closest store PER CHAIN, hard
distance cap, 5 km cluster fallback):
- **Sutaupyta (signed!)** = median comparable-store total − paid. Negative renders honestly as
  **Permokėta** in red — the anti-"Sutaupėte" credibility move. Median (not mean) resists outlier stores;
  never compare against the most-expensive store (that's the shops' own trick).
- **Galėjai sutaupyti** = paid − cheapest alternative, named ("Lidl būtų kainavęs 3,10 € mažiau");
  0 → positive state "Pasirinkai pigiausią parduotuvę ✓".
- Tap on the card → bar diagram: this basket priced at each per-chain closest store + a MEDIAN line +
  "Jūs (…)" marker. Multi-store trips: **UNION basket** of all uploaded receipts priced per store as if
  bought in one place — the split-worth-it story is the marker sitting below every bar.
- Guardrails: common-item subset comparisons ("trūksta N" badge on partial bars; median over
  adequately-covered stores only); **frozen per recompute using as-of-receipt-date prices**.
- Monthly Profilis card = Σ persisted per-trip deltas, no recomputation.

## Receipt slots & partial trips (decided 2026-07-16)
- Planned slots (one per plan store) + **"+ Pridėti kvitą"** up to 3 total (off-plan store → soft chain
  gate, "papildomas"). Every planned slot has **"Nepirkau čia"** (skip).
- **Stats recompute on every receipt-set change** (attach/skip/unskip) from the union of uploaded
  receipts — partial trips show real stats immediately. Stage 5 = every slot filled OR skipped;
  the 7-day auto-archive is the implicit skip. Un-archive + attach later → same recompute.
- Planning score honesty: planned-but-unbought counts against coverage; extra-store receipts take the
  unplanned-store dampener.

## Backfill & invites policy (decided 2026-07-16)
- Existing list-less receipts (≈90) backfill as **one ad-hoc trip per receipt** (list-less, stage 5,
  "neplanuotas") — historic ones EXCLUDED from planning score (nobody starts 2.0 pre-punished).
- Anon users CAN claim QR/link invites (membership rides the anon→account merge); **addressed invites
  (handle/email) target registered users only**; invite sheet nudges anon senders to sign in
  ("kad draugai galėtų tave rasti").

## Out of scope (foundation only)
Bill splitting (payer field only), multiple households, manual combo composition, real-time sync beyond polling.
