# Client version gating — release runbook & expand→contract discipline

The backend serves **every installed app version at once**. After a store release, 1.4 and
1.5 users hit the same API for days/weeks (store propagation is slow and uneven). The version
gate makes the backend the source of truth for "who is too old to run," and the
expand→contract discipline keeps the API dual-compatible during the overlap.

Implemented (souply-api + souply-app + souply-web):
- **Server gate:** `ClientVersionPolicy` table (per-platform floors, runtime-flippable) +
  `GET /api/app/version-check` + `versionGate` middleware (426 hard / soft header). Fail-open.
- **App:** launch `version-check` + per-request 426 catcher → `UpdateGateModal` (hard = blocking
  store gate, soft = dismissible). Cold-start OTA applies behind the splash
  (`updates.fallbackToCacheTimeout`); warm OTA via `useAppUpdates`. `runtimeVersion: appVersion`
  gates OTA/native ABI compatibility.
- **Web:** build-id in the bundle + `/version.json` + `versionWatcher` reload toast +
  `vite:preloadError` chunk-recovery. (Web reload is cheap → soft nudge, not a hard block.)
- **Telemetry:** `ClientVersionSighting` daily rollup; `GET /api/admin/client-versions`.
- **Contract tooling:** `src/utils/versionedRoute.ts` `v1Shim`.

## The core mental model

**backend leads → app/web follows → gate trails → cleanup last.**
1. Ship the ADDITIVE backend change **first** (old + new clients both work).
2. Release the app/web.
3. Only **after** 100% rollout, raise the gate floor (if needed).
4. Only **after** old versions drain (telemetry), delete deprecated code (contract).

**Two gate levels:**
- **soft** (`recommendedVersion`) — dismissible "update available." Non-breaking improvements.
- **hard** (`minVersion`) — full-screen block → store. **Security fixes + breaking API changes ONLY.**

## Per-release runbook

1. **Backend first.** Deploy the additive backend change. Keep it dual-compatible (see
   expand→contract below). Apply any new SQL (add to the production deploy checklist).
2. **Bump `app.json` version** (this is the gate key AND the OTA `runtimeVersion`). Build both
   platforms (EAS), submit to the stores.
3. **Staged/phased rollout → 100%.** iOS review lag means Android can be live while iOS is in
   review — track each platform independently.
4. **Set floors (per platform, AFTER that platform is 100% live + a small propagation grace):**
   - Soft nudge (anytime a platform is live): `UPDATE ClientVersionPolicy SET recommendedVersion='1.5.0' WHERE platform='android';`
   - Hard block (security / breaking only): `UPDATE ClientVersionPolicy SET minVersion='1.5.0' WHERE platform='android';`
   - Effect within the 60s policy cache. **Rollback = set the floor back to NULL** (instant).
5. **Web:** deploy souply-web; running tabs get the reload toast within ~5 min or on focus.
6. **Watch telemetry.** `GET /api/admin/client-versions` → when the old version's `requests` is
   ~0 across the window, the overlap is over.
7. **Contract (weeks later).** Delete the deprecated `/v1` shim / old code paths (checklist below).

### The #1 operational mistake
**Never raise a hard floor mid-rollout.** If you set `minVersion` while the store is still at,
say, 20% phased rollout, you brick the 80% the store hasn't offered the update to yet. Wait for
100% + grace. This is why hard floors are the LAST step and rollback is a one-line UPDATE.

## Expand→contract (parallel change)

Make the API safe for old + new clients simultaneously:

- **Level 1 — additive (≈90% of changes, no versioning).** Add fields to responses; old clients
  ignore them. Add optional request params with safe defaults. Never remove/rename/retype an
  existing field an old client reads. This alone avoids almost all hard gates.
- **Level 2 — versioned routes (genuinely breaking only).** Run `/v1` + `/v2` in the SAME
  process / SAME DB. `/v2` is the real handler; `/v1` is a reshape shim (`v1Shim`, translating
  old request in / new response out). NEVER stand up a second API instance for client compat —
  that's blue/green / rewrite territory, not version compatibility.

## Contract checklist (deleting a `/v1` shim)

- [ ] Telemetry (`/api/admin/client-versions`) shows the pre-`/v2` app version at ~0 requests
      across the full lookback window, for **every** platform.
- [ ] A hard floor at/above the `/v2`-introducing version has been live long enough that any
      straggler is force-updated (or accept the tail and 426 them).
- [ ] Remove the `/v1` route mount + its `v1Shim` adapters.
- [ ] Remove any DB columns / code that existed only to serve the old shape.
- [ ] Deploy; watch for a 4xx/5xx bump on the removed paths (should be ~0).
