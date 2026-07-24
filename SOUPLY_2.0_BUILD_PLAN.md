# souply 2.0 Migration Blueprint

## 1. REUSE MAP (existing asset → 2.0 role)

### Navigation & shell
| Asset | Location | 2.0 role |
|---|---|---|
| Browse tab | `souply-app/app/(tabs)/browse/index.tsx` | Naršyti verbatim. Keeps Android double-back-to-exit handler (lines 27-40) — must remain on the anchor tab. |
| Menu screen | `souply-app/app/(tabs)/menu/index.tsx` | Profilis. Bell goes in CollapsingHeader `right` prop (lines 537-542, note rAF headerRight workaround at 213-223); Lists/Receipts buttons into quick-links (lines 730-771); planning-score card next to stats carousel. |
| Templates branch | `app/(tabs)/basket/index.tsx` view==='templates' (~lines 450-625) + `utils/basketTemplatesApi.ts` + `/template/[id]`, `/template-add/*`, `/t/[slug]` | Lift into new `app/(tabs)/templates/` = Šablonai. Retarget the 2 receipts-CTA navigations (lines 487, 501). `/t/[slug]` never moves (universal-link contract). |
| Tab bar infra | `app/(tabs)/_layout.tsx` (JS Tabs 94-167, NativeTabs 169-204, boundary fallback 18-30), `components/FloatingPillTabBar.tsx` | 5→4 tabs mechanical; FloatingPillTabBar adapts automatically. Replace the 3-call 10s `fetchCounts` poller (lines 49-86) with one trip-count endpoint. |
| Glass header system | `constants/navHeader.tsx`, `CollapsingHeader`, `ScreenHeading` | New tab folders copy the 8-line `_layout.tsx` pattern from `app/(tabs)/basket/_layout.tsx`. |
| Receipt scan/queue engine | `app/receipt-process.tsx`, `receipt-picker.tsx`, `state/scanSession.ts`, `receiptQueueStore.ts`, `receiptDraft.ts`, `useReceiptQueueRunner` | Stage-5 mini-cycle engine wholesale; `listMap`/`pdfUri`/`uris` params already do per-store attach. Re-point its 13 `'/(tabs)/receipts'` navigations (lines 817, 1125, 1247, 1325-1339, 2841-2934). |
| Per-store grouping + awaiting-receipt logic | `app/(tabs)/shoppingList/index.tsx` (buildChainListMap line 96, upload/link entries 498-544, 1006) + `utils/awaitingReceipts.ts` | Logic donor for trip per-store mini-cycle cards; the screen itself dissolves into Apsipirkimai. |

### Map & sheet
| Asset | Location | 2.0 role |
|---|---|---|
| GlassStageSheet | `components/GlassStageSheet.tsx` | THE 3-detent sheet: N-snap physics (snaps prop line 54), pan worklet (205-284), `snapTo` (184-190), dock morph (107-158, 293-312) = closed pill / 50% / edge-to-edge. Keep physics untouched; build page stack in body layer only. |
| dockAtLast morph proof | `components/results/ResultsBottomSheet.tsx` (280-309, 4 detents) | Reference implementation of the full morph. |
| Baked-pill system | `components/map/MapPill.tsx` (PillShot 44-156, useBakedPills 164-212, marker 266-413) | Price pills + new progress-pill variant (styles 542-599); bake key carries count (`s-${storeId}` marker key stays stable → in-place image swap, no remount). |
| Store-resolution marker architecture | `components/receipt/StoreResolutionOverlay.tsx` (mount contract 275-287, tiers 300-368, bands 373-394) | Receipt store-resolution pick-mode selection model; its append-only/opacity-only contract becomes the unified map's marker law. |
| Pick-mode chrome | `components/map/MapPickerScaffold.tsx` (glassChrome 179-242, `confirmAlwaysVisible` line 90) | Lift chrome cluster out as an overlay mode over the shared map (don't reuse scaffold wholesale). |
| Results map machinery | `app/basket/results/[id].tsx` + `components/results/StoreResultsMap.tsx` + `MapSkiaSingles`/`MapPillOverlay` | Store-search stage of unified map; `bottomOverlay` + `onHeightChange` already implement sheet-aware framing. Skia Atlas layer = shared iOS-perf base. |
| 1\|2\|3 selector | `app/basket/results/[id].tsx` lines 482-500, 806-830, styles 908-926 | Extract to `components/StoreCountToggle.tsx`, relocate into sheet bar. |
| Bar-as-tabs precedent | `app/basket/[id].tsx` 799-943 + `LocationSettingsPanel` | Proves bar tabs = content-only change (bar prop is arbitrary node; snaps recompute via onContentHeight). |

### Data model & API
| Asset | Location | 2.0 role |
|---|---|---|
| Basket→ShoppingList→Receipt chain | `sql/shopping_list_split_per_store.sql` (UNIQUE(basketId,storeId)), `shoppingListModel.ts` (:35, :104) | ~70% of trip skeleton: ShoppingList row = (trip,store) slot; "awaiting receipt" already derived (completed AND no Receipt). |
| Receipt↔slot link | `sql/receipt_shoppinglist_link.sql`, `shoppingListController.ts:241` | Receipts 1:N per slot works today; uploaderUserId = existing `Receipt.userId`. Link endpoint already enforces member+owner. |
| Membership + QR tokens | `shoppingListMemberModel.ts`, `shoppingListShareTokenModel.ts`, `shoppingListController.ts:300-405`, `sql/shopping_list_sharing.sql` | Clone as TripMember + TripInviteToken — BUT replace single-flight claim with claim ledger (see gaps). |
| Slug share stack | `templateShareService.ts`, `config/urls.ts`, GET `/api/t/:slug` | Model for long-lived `/join/:code` links (env-baked URLs, revoke-keeps-slug). |
| Deep-link plumbing | `app.config.js:34-52,100-110`, `souply-web/public/.well-known/*`, `app/t/[slug].tsx`, `app/+native-intent.tsx`, `PublicTemplateView.tsx:56-68` | Add `/join/*` alongside `/t/*`; preview-then-act screen + 350ms `souply://` hop transplant directly. |
| Store-search engine | `basketCalculationService.ts:22-67`, `basketController.ts:254-319`, app-side `utils/splitBasketScore.ts`/`splitOptions.ts` | Unchanged for map stage. Note split combos are CLIENT-computed — persist chosen combo server-side if planning score needs a baseline. |
| Interaction pipeline | `productInteractionModel.ts` (weights 7-15), `accountMergeService.ts:150-169` | `receipt_buy` = ENUM ALTER + CASE arm + one `logInteraction` call; merge is type-agnostic, no change. |
| Derived-lifecycle precedent | `basketTemplateService.ts` (isAbandoned/isResumable over write-once flags) | Pattern for pure `deriveTripStage()` function over per-slot facts. |
| Stats machinery | `statsService.ts` (L2 CASE 239-253, savings avg 348-366), `receiptSaveService.ts:771` (savedAmount), `DonutChart.tsx`, `BarChart.tsx`, `profileStore.ts` | Extract inner aggregation into receipt-id-scoped helper for per-trip donut; SUM(savedAmount) = trip "Saved"; DonutChart reuses as-is; BarChart needs stacked segment. |
| Match machinery for planning score | `productMatcher.ts` (findBestProductMatches), `ReceiptItem.matchedSpId/altMatches`, `ShoppingListItem.productId/storeProductId`, app `utils/fuzzyMatch.ts` | Auto-link join at Product level + plausible-candidate set + client picker filter — all ingredients exist. |
| Resolution ledger pattern | `sql/receipt_line_resolution.sql`, `receiptLineResolver.ts` | Copy shape for TripLineLink (source auto\|manual); resolution event is the shared hook for receipt_buy + planning score. |
| Email + handles + i18n | `emailService.ts`, `usernameService.ts`, `authRoutes.ts:91`, `i18n/index.ts` | Email/handle invites; free SMTP satisfies free-only rule. |
| Scheduler + version gate | `souply-api/src/index.ts:278`, version-gate infra | Auto-archive job home; 426 gate sequences the status-enum cutover. |

## 2. CONSOLIDATED GAPS by build area

### A. Server data model (foundation)
- **Trip + TripMember tables & Basket migration** — LARGE. `Trip(id, householdId NULL, createdByUserId, name, archivedAt, timestamps)` + `TripMember(tripId, userId, role, UNIQUE)`; ALTER Basket/ShoppingList ADD tripId (keep basketId during transition). Backfill: 1 Trip per Basket (11 dev rows); standalone lists → own trips; **89/93 dev receipts are list-less** — explicit ad-hoc-trip backfill decision required. Authz flips from owner (`basketRoutes.ts:79-162` owns middleware, `shoppingListController.ts:64-70` 403) to trip-membership.
- **Derive stages / retire Basket.status writes** — MEDIUM. Writers: `basketController.ts:231, :134-157`; `shoppingListController.ts:116, :217 (buggy any-list-completes), :222, :288-289`. Readers: `basketModel.ts:30,53,116`, `basketTemplateService.ts:33,43`, `basketTemplateController.ts:673`; app: `basket/index.tsx:72-74,242,275-277,687-690`, `basket/[id].tsx` (~8 sites), `results/[id].tsx:258`, `browse/[categoryId].tsx:189,274-294,321`, `discounts.tsx:455-503`. Keep column, derive server-side, gate client writes behind 426.
- **Household singleton + persistent shared basket** — MEDIUM. Greenfield; must be excluded from the draft-singleton invariant (`basketModel.ts:113` getUserDraftBasketId, `basketController.ts:66-81` idempotent POST, client basketUtils guard) via `Basket.householdId` discriminator, never a status value.
- **receipt_buy interaction** — SMALL. ENUM ALTER ×3 envs + CASE `WHEN 'receipt_buy' THEN 5` in `productInteractionModel.ts:7-15` + logInteraction in the resolved_user path (`receiptRoutes.ts:87-90` area).
- **Auto-archive job** — SMALL. `Trip.archivedAt` + daily job on `index.ts:278` scheduler; ShoppingList lacks updatedAt — add it or derive activity from item writes.
- **accountMergeService coverage** — SMALL per table, MANDATORY: Trip, TripMember, Household(Member), TripLineLink, PushToken, Notification, InviteToken/Claims.

### B. Navigation restructure (app)
- **Apsipirkimai tab (trips list + trip detail)** — LARGE. Rebuild absorbing baskets accordion + shoppingList split-groups + receipt-attach; ad-hoc trips via ShareHandler (`app/_layout.tsx:76-118`) need server-side trip creation at persist time (offline queue).
- **Re-home receipts + shoppingList as pushed routes; sweep 21 `as any` nav call sites** — MEDIUM. receipt-process.tsx (13), results/[id].tsx (673, 689, 752), settings.tsx (61, 108), basket/index.tsx (2), shoppingList/index.tsx:881, ShoppingListDetail.tsx:659, receipts self-refs (2). Grep-driven — typecheck will not catch. Re-base `useSafeBottomTabBarHeight` + tab-focus effects (receipts/index.tsx 65-70, 153-162) for pushed-route life.
- **Šablonai extraction** — SMALL. New `(tabs)/templates/` folder; NativeTabs trigger name = folder name (iOS).
- **Badge recomputation** — SMALL. One trip-count endpoint replacing 3-call poller; pendingSwipe → Profilis bell/badge.

### C. Unified map + sheet shell
- **In-sheet nav stack (stores → store → plan, X-to-pop)** — LARGE. Page-stack layer in GlassStageSheet's BODY: active page's scrollRef/scrollY feeding the pan gesture (207, 193-194, 228; memo on [height] only at 284); animated (not instant) snap transition on push/pop vs the 176-179 settle path; dock progress owned by root detents (124-134); Android hardware-back pops sub-sheet first. Never stack GlassStageSheet instances.
- **One map host with modes** — LARGE. Mode state: 'sheet' (GlassStageSheet) / 'point-pick' / 'store-resolution'; lift MapPickerScaffold chrome as overlay; marker-set swaps obey SRO append-only contract; preserve entry params of `preset/[key]/map` and `basket/results/[id]` (redirect routes).
- **Pick-mode collapse choreography** — MEDIUM. snapTo(0) + bar swap to Cancel/Confirm + single-entry snaps array as drag freeze (line 226); carry `confirmAlwaysVisible`.
- **Progress pill variant** — SMALL. New variant in MapPill styles + PillShot colors; bake key includes count.
- **StoreCountToggle extraction** — SMALL.

### D. Stats & planning score
- **Per-trip donut + Saved endpoint** — SMALL. Receipt-id-scoped extraction of statsService aggregation (195-313); MUST read ReceiptItem, never parsedData.
- **Per-trip could-have-saved** — MEDIUM. Sum per-store comparisons (`receiptComparisonService.ts`); persist the delta (today client-only, `ReceiptComparisonSection.tsx:158-168`); pick ONE savings semantic for the card.
- **Monthly bar contribution segment** — MEDIUM. Server: per-month trip-contribution keyed by month key (not label); client: BarChart stacked two-segment rendering + keep opacity highlight; fix the UTC/local month-key mismatch while there.
- **Planning score (coverage/discipline/precision) + manual link UI** — LARGE. TripLineLink table (copy ReceiptLineResolution shape), scoring service (normalize kg-vs-vnt; exclude price=0 poison-guard items), candidate set from altMatches + findBestProductMatches, picker filtered by fuzzyMatch, per-(trip,member) persistence, monthly Profilis card. SQL GROUP BY, not the load-all-receipts pattern.

### E. Sharing & membership
- **Multi-claim invite tokens** — MEDIUM. InviteToken(scope trip|household) + InviteClaim(UNIQUE(tokenId,userId)) — redesign, not copy, of single-flight claimedAt.
- **Invite preview/confirm** — SMALL. GET `/api/join/:code/preview`; scan.tsx routes to preview instead of instant claim.
- **Handle/email invites** — MEDIUM. POST `/api/trips/:id/invites`, addressed-invite rows, emailService template, 202-always (no handle-existence leak); surface via inbox.
- **`/join/*` surface** — MEDIUM. intentFilters (native rebuild) + AASA (web redeploy) + web route with **store CTAs** (PublicTemplateView has no install fallback) + deploy on both LINK_HOSTs.

### F. Notifications (fully greenfield)
- **expo-notifications client** — MEDIUM. Package + plugin + FCM google-services.json per Android variant (`lt.souply.app`, `.dev`) + APNs key + Android 13 runtime prompt + tap-routing. Native rebuild all variants.
- **PushToken lifecycle** — MEDIUM. Table, register/unregister endpoints, DeviceNotRegistered pruning, merge coverage.
- **Server sender** — SMALL. expo-server-sdk, 100-chunking, ticket→receipt pass (~15min) on existing scheduler.
- **Inbox + bell** — MEDIUM. Notification table, self-scoped list/mark-read, inbox screen, unread badge; push send + inbox insert = one service call.

## 3. TOP 10 RISKS + mitigations

1. **21 untyped `as any` route strings break silently when tab folders move.** Mitigate: do the sweep as one commit; add a `routes.ts` const map for cross-screen navigation; grep `'/(tabs)/` must return zero before deleting folders; runtime-test receipt-process's post-save flow specifically.
2. **Client writes Basket.status while server derives stages** (PATCH /status endpoint + 3 app revert-to-draft screens + STATUS_PRIORITY). Mitigate: server derives and serves a computed `stage`; keep status column as a write-through shim during transition; cut client writes behind the 426 version gate; fix the any-list-completes bug (`shoppingListController.ts:217`) BEFORE any backfill so wrong terminal states aren't baked in.
3. **iOS AIRMap marker churn on map unification** (NSRangeException/annotation-drop class already paid for). Mitigate: mode switches never rebuild marker arrays — append-only, opacity hiding, in-place image swaps; gate mode ENTRY the way SRO gates on mapReady/centered (re-derive the 420ms defer for entry, not mount).
4. **GlassStageSheet pan-worklet regression radius = every sheet in the app.** Mitigate: freeze `GlassStageSheet.tsx` physics (205-284); page stack lives strictly in the body layer with a scroll-ownership adapter; manual QA of basket settings + results sheets on both platforms per change.
5. **Same-physical-receipt collision between trip members** (global `unique_receipt(receiptNoCanonical, storeId, receiptDate)`, `receiptController.ts:285`). Mitigate: same-trip exemption that silently links the existing receipt to the trip, mirroring the existing same-user duplicate-link path.
6. **Household basket vs draft-singleton invariant** (3 enforcement points: `basketModel.ts:113`, `basketController.ts:66-81`, client basketUtils). Mitigate: `householdId NOT NULL ⇒ excluded` predicate added to all three in the same change; test POST /baskets idempotency with a household basket present.
7. **Authz widening owner→member reopens the IDOR class two audits fixed.** Mitigate: central `requireTripMember(role?)` middleware; re-run the authz sweep checklist over every converted route; invite-claim routes keep the documented requireUser-only, token-as-capability pattern (`shoppingListRoutes.ts:19-23`); new inbox/invite endpoints strictly self-scoped.
8. **accountMergeService silently orphans new tables on anon→account sign-in.** Mitigate: merge coverage is part of each migration's definition-of-done (template: ShoppingListMember handling at :221-238); add a merge test per table.
9. **Divergent savings semantics on one trip card** (savedAmount = vs market avg; comparison = vs cheapest alternative; known to diverge). Mitigate: pick one semantic per label at design time, persist the comparison delta server-side, and never surface both without naming their baselines.
10. **Native-config prerequisites block JS work + migration backlog** (expo-notifications plugin, `/join/` intentFilters = new dev-clients on all variants; ProductInteraction ENUM + trip tables join an already-pending prod migration queue; `/join` must be live on both LINK_HOSTs before invites ship). Mitigate: front-load one "native config batch" build early in Phase 1 (Android local, one iOS EAS cloud shell); batch all 2.0 SQL into the existing prod-checklist promotion, dev→staging→prod in order; deploy web `/join` route (both envs, prod at `/opt/souply/souply-web`) before any invite UI ships.

Also worth carrying: ad-hoc share-intent receipts arrive offline-queueable with zero trip context — trip creation must be server-side at persist time; getUserStats O(all receipts) pattern must not be copied (SQL GROUP BY over ReceiptItem); the 89/93 unlinked-receipt backfill decision is irreversible once per-trip stats accumulate.

## 4. PHASE ORDER

**Compatibility strategy:** all work on `dev` per repo (three-branch model). Server changes are additive-first (new tables, new endpoints, status column kept and dual-written) so the shipped app keeps working against the upgraded API. Client cutover ships as one coordinated app release; the 426 version gate (fail-open) retires old clients only when the status-write shim is removed. All SQL batches into the outstanding prod-migration checklist. Native builds: one "native config batch" (expo-notifications plugin + `/join` intentFilters + FCM files) built in Phase 1 so every later phase is OTA-able.

**Phase 0 — Pre-work (small, unblocks everything)**
- Fix `shoppingListController.ts:217/:288` split-completion bug (pre-backfill correctness).
- Decide: ad-hoc backfill rule for the 89 orphan receipts; savings semantic for the trip card; anon users + addressed invites policy.
- Route-string const map + grep sweep tooling.

**Phase 1 — Server foundations + native config batch**
- Trip/TripMember tables, ALTERs, backfill; derived-stage function (basketTemplateService pattern) served alongside status; `requireTripMember` middleware + authz conversion; same-trip receipt-duplicate exemption.
- receipt_buy ENUM + hook; Trip.archivedAt + scheduler job; merge coverage for all new tables.
- Household tables + draft-singleton exclusion.
- Native config batch build (Android local ×variants, one iOS cloud build): expo-notifications plugin, `/join` intentFilters, google-services.json per variant.
- InviteToken/InviteClaim ledger + `/join/:code` preview/claim endpoints; web `/join` route + AASA on both hosts.

**Phase 2 — Navigation restructure (app, ships against Phase-1 API)**
- 5→4 tabs; Šablonai extraction; receipts/shoppingList re-homed as pushed routes; the 21-call-site sweep; badge endpoint; Profilis quick-links. Test NativeTabs on real iOS build.

**Phase 3 — Sheet/map shell**
- StoreCountToggle + progress-pill variant (small wins first); pick-mode chrome extraction; unified map host with modes (redirect old routes); in-sheet page stack last (highest-risk piece, everything else works without it).

**Phase 4 — Apsipirkimai stages**
- Trip list + trip detail with derived stages, per-store mini-cycle cards (awaitingReceipts logic donor), receipt-process re-pointing into trip context, ad-hoc trips from share intent, membership UI (QR sheet + preview/confirm + handle/email invites), auto-archive live.

**Phase 5 — Stats & planning score**
- Per-trip donut + Saved endpoints (SQL GROUP BY over ReceiptItem); persisted could-have-saved; BarChart stacked contribution segment (+ month-key fix); TripLineLink + scoring service + manual-link UI; monthly Profilis card; receipt_buy firing verified end-to-end.

**Phase 6 — Notifications**
- PushToken lifecycle + sender + receipt-polling on scheduler; Notification inbox + Profilis bell; trigger points on trip events (member joined, receipt resolved) riding receiptSaveService post-commit fire-and-forget pattern. JS-only by now (native module shipped in Phase 1), so fully OTA-able.

Rationale for the order: Phase 1 is pure-additive server work the current app ignores; Phase 2 is the only breaking app restructure and is cheapest to stabilize before the map work piles on; Phase 3's page stack is isolated so its risk doesn't block Phase 4; stats (5) needs trips populated with real data from 4; notifications (6) depend only on the Phase-1 native batch and can slide without blocking anything.