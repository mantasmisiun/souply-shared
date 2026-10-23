# Trip flow — ONE screen per stage (simplified rework)

Status: REWORK SHIPPED (2026-07-19). Supersedes the six-tab map dock — a trip
is a journey, not a workspace: one stage, one screen, one primary action.
Basic views first; visual polish comes per-screen on user review.

## Architecture (locked)
- The Shopping card (and the `/trip/[id]` redirector — kept for old links and
  post-create navigation) resolve a trip to its stage's ONE screen via
  `utils/tripStageRoute.ts`:
  1 forming      → `/basket/[basketId]`          (edit items, "Find stores")
  2 compared     → `/basket/results/[basketId]`  (the working comparison map)
  3 shopping     → `/shopping-list/[listId]?tripId=` (closest unfinished store)
  4 need receipt → `/trip/receipts/[tripId]`
  5 done         → `/trip/stats/[tripId]`
- Earlier stages are unreachable history by construction (the data-pruning
  rule enforced by navigation, not UI state).

## Back-edges (one step, with a cost)
- Map → basket: cart chip on the map (item edits drop the trip to forming).
- Shopping → stores: NOT built yet (would delete the list; needs confirm).
- Receipts → list: not built (read-only peek later if wanted).

## Screens
- **Map** (`StoreResultsSurface`, standalone route): price pills, 1·2·3
  toggle, options card → create list. Floating options button = location &
  route settings, Saver mode toggle (AsyncStorage 'saverMode', engine later),
  trip invite QR. Lists are created nearest→furthest so the list tabs follow
  the map's presentation order (last tab = furthest store).
- **Shopping list**: existing screen; `?tripId=` builds the store tabs from
  trip slots (nearest→furthest), single-store trips still use the trip
  completion flow; completing everything replaces to `/trip/receipts/[id]`.
- **Receipts** (`app/trip/receipts/[id]`): empty → one Upload; else View
  receipt + Upload buttons and all parsed items below (chain logo per item
  card when multi-receipt). View picker rows carry "wrong receipt" (detach) —
  server-gated to trips younger than 7 days (HTTP 423 after).
  API: GET /api/trips/:id/receipts, DELETE /api/trips/:id/receipts/:receiptId.
- **Stats** (`app/trip/stats/[id]`): basic spent/saved + category breakdown;
  locked hint while any mandatory swipe queue is open. Real design later.

## Removed
- The six-tab dock surface, its per-tab sheet pages and the embedded-map
  branch on /trip/[id]. `StoreResultsSurface` keeps its `embedded` props
  (unused today, kept for reuse). DockTabsRow stays exported.
