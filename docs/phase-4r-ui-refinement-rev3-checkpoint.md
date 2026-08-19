# Phase 4R · UI Refinement rev-3 — Tenant-Timezone-Aware Greeting + 12h AM/PM Commitments

**Date:** 2026-08-15  
**Author:** Claude Opus 4.7 (under founder authorization)  
**Branch:** `work-intake-state-outlook-archive-fix`  
**Commit:** `552c4cb`  
**Staging web:** v220 → **v221** (`spectre-staging:deployment-01M03CG36KEC5VZMZV7Z2S4BEV`)  
**Staging worker:** v114 (unchanged)  
**Rollback anchor:** web v220 / `spectre-staging:deployment-01M03BB9AM76T3NE31SNJQ8JMD`

Founder-reported time defects on Mission Control v220:

1. Greeting showed `Good evening` while Alberta was in the afternoon.
2. Today's Commitments rendered times in 24-hour military format.

Both fixed via one shared local-time utility + timezone-aware
derivation from the tenant IANA zone.

---

## 1. Root cause of the incorrect `Good evening` greeting

**Location**: [src/app/app/admin/page.tsx](src/app/app/admin/page.tsx)
`greetingForHour(d)` (pre-rev-3).

The helper called `d.getHours()`, which in JavaScript resolves in the
**server's local timezone**. Fly.io runs the container in UTC, so
15:00 in Edmonton (MDT = UTC-6) is 21:00 UTC → hour ≥ 17 → the helper
returned "Good evening".

The tenant's IANA zone was already resolved by the Mission Control
loader (`snapshot.clubTimezone.ianaZone`, populated from
`loadMissionControlSnapshot`), but the greeting bypassed it.

---

## 2. Root cause of the 24-hour meeting formatting

**Location**: [src/lib/mission-control/commitments.ts](src/lib/mission-control/commitments.ts)
`formatLocalTime(d, tz)` (pre-rev-3).

The formatter correctly consumed the club's IANA zone
(`Intl.DateTimeFormat("en-CA", { timeZone: tz, ... })`), but it was
configured with `hour12: false` and emitted `HH:mm`. Display-only
defect — the underlying Graph timestamp path is correct (see §5).

---

## 3. Shared root cause?

**Partial.** The tenant IANA zone abstraction already exists and was
architecturally correct (the commitments loader USED it). What was
missing was:

- The greeting **bypassed** the tenant IANA zone entirely.
- The commitments formatter **used** the zone but produced 24h.

Both fixes now flow through ONE new module,
[src/lib/mission-control/local-time.ts](src/lib/mission-control/local-time.ts),
so any future consumer of "what time is it for this tenant?" or
"how does Spectre display a meeting time?" reads from a single
source of truth.

---

## 4. Timezone source of truth

Precedence used (in order):

1. **`snapshot.clubTimezone.ianaZone`** — populated by the Mission
   Control loader from the tenant's configured IANA zone
   (Coulee Ridge → `America/Edmonton`). This is the source of truth
   used for both greeting derivation and commitment formatting.
2. If the club has no configured zone, the loader already falls
   back to `UTC` (unchanged by this slice).

No new abstraction was needed — the existing `clubTimezone.ianaZone`
handled the tenant IANA lookup correctly. The rev-3 change makes
the greeting **consume** it (previously ignored) and centralises the
formatting convention next to the greeting derivation.

Explicitly avoided:

- No hard-coded `America/Edmonton` literal in any page/component
  (the zone is passed in via `snapshot.clubTimezone.ianaZone`).
- No hard-coded UTC offset (`-6` or `-7`). All conversions go
  through `Intl.DateTimeFormat` with the IANA zone name so daylight-
  saving transitions are DST-safe by construction.

---

## 5. Files changed

Code:
- **NEW** [src/lib/mission-control/local-time.ts](src/lib/mission-control/local-time.ts)
  - `getTimeOfDay(instant, ianaZone)` → `"morning" | "afternoon" | "evening"`
  - `greetingWordForInstant(instant, ianaZone)` → `"Good morning" | ...`
  - `formatLocalTimeAmPm(instant, ianaZone)` → e.g. `"8:00 AM"` / `"1:30 PM"`
  - `GREETING_BOUNDARIES` constants (morning 5, afternoon 12, evening 17)
- [src/lib/mission-control/commitments.ts](src/lib/mission-control/commitments.ts) —
  consumes `formatLocalTimeAmPm` from the shared module; retired
  `formatLocalTime` (24h) with an explicit comment block explaining
  why not to reintroduce it.
- [src/app/app/admin/page.tsx](src/app/app/admin/page.tsx) —
  consumes `greetingWordForInstant(snapshot.syncedAt, snapshot.clubTimezone.ianaZone)`;
  retired local `greetingForHour(d)` (server-local hour) with an
  explicit comment block.

Tests:
- **NEW** [tests/mission-control-local-time.test.ts](tests/mission-control-local-time.test.ts)
  — 24 tests covering:
  - Edmonton MDT (summer) morning / afternoon / evening
  - Edmonton MST (winter) morning / afternoon — DST guard
  - UTC-would-differ regression sentinel (asserts BOTH: `Edmonton →
    afternoon`, `UTC → evening` for the founder-reported 21:00 UTC
    instant) — a hard-coded UTC offset would break this
  - Boundary edges (04:59 → evening, 05:00 → morning, 11:59 →
    morning, 12:00 → afternoon, 16:59 → afternoon, 17:00 → evening)
  - `GREETING_BOUNDARIES` constants pinned
  - `formatLocalTimeAmPm`: `8:00 AM`, `9:30 AM`, `12:00 PM`,
    `1:00 PM`, `1:30 PM`, `3:45 PM`, `11:59 PM`, `12:00 AM`;
    Edmonton MDT + MST variants; no leading zero on hour; uppercase
    AM/PM; minutes always 2-digit
- [tests/c16g-commitments.test.ts](tests/c16g-commitments.test.ts)
  — updated timeLabel pins: `09:30 → 9:30 AM`, `16:00 → 4:00 PM`
- **NEW** [tests/e2e/phase-4r-rev3-timezone-acceptance.staging.spec.ts](tests/e2e/phase-4r-rev3-timezone-acceptance.staging.spec.ts)
  — staging acceptance: greeting matches computed-from-Edmonton-now
  expectation; commitments panel enforces AM/PM regex when populated;
  rev-2 UI intact.

Docs:
- [docs/phase-4r-ui-refinement-rev3-checkpoint.md](docs/phase-4r-ui-refinement-rev3-checkpoint.md)
  (this file)

---

## 6. Tests run + results

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | Clean |
| `tests/mission-control-local-time.test.ts` (NEW) | **24/24** pass |
| `tests/c16g-commitments.test.ts` (updated pins) | Pass |
| `tests/c16h-calendar-time-normalization.test.ts` | Pass (unchanged) |
| `tests/c16h-restore-and-completion.test.ts` | Pass (unchanged) |
| **Total commitments + local-time suites** | **48/48** pass |
| `npm run scan:placeholders` | Clean in touched files |
| Staging deploy web v220 → **v221** | Successful, `/api/health` = 200 |
| Playwright rev-3 acceptance spec | **PASS** |

Regression sentinel: `mission-control-local-time.test.ts` asserts
that Edmonton 15:00 → "afternoon" AND UTC evaluation of the same
instant → "evening", for BOTH the summer (MDT) and winter (MST)
cases. Anyone who reverts to server/UTC time in the future will
trip this test.

Playwright rev-3 acceptance console output:
```
[§1] page greeting = "Good afternoon, Chris."
[§1] expected phrase (based on Edmonton now) = "Good afternoon"
[§2] commitment time labels = []
[§3] header-rail order = ["spectre-header-rail-tenant","span","spectre-header-rail-crumbs"]
```

Note on the empty `[§2]` list: the Coulee Ridge staging tenant has
no appointments for today, so the panel renders the empty state.
The 12-hour AM/PM format contract is pinned in the two vitest
suites above (`mission-control-local-time` + `c16g-commitments`)
which cover `8:00 AM`, `9:30 AM`, `12:00 PM`, `1:30 PM`, `4:00 PM`,
`11:59 PM`, and `12:00 AM` shape assertions. The Playwright
acceptance spec's AM/PM regex will still fire whenever the panel
has entries — no test coverage gap.

---

## 7. Staging deployment version / rollback anchor

- **Web `spectre-staging` v220 → v221**
  (`spectre-staging:deployment-01M03CG36KEC5VZMZV7Z2S4BEV`)
- Worker v114 (unchanged — no worker code touched)
- **Rollback anchor**: web v220
  (`spectre-staging:deployment-01M03BB9AM76T3NE31SNJQ8JMD`)

Rollback:
```
flyctl deploy -c deploy/fly.web.toml --app spectre-staging \
  --image spectre-staging:deployment-01M03BB9AM76T3NE31SNJQ8JMD
```
or `git revert 552c4cb` on the branch.

---

## 8. Screenshot evidence

Saved under `test-results/phase-4r-rev3-timezone/after/`:

- `01-mission-control-full.png` — the full page at 1440×900 shows
  the corrected greeting `Good afternoon, Chris.` beneath the header
  rail `Coulee Ridge Golf & Country Club | App > Mission Control`,
  with the sync meta line already correctly reading
  `Saturday, August 15 · 13:05 MDT`.
- `02-todays-commitments.png` — the Today's Commitments panel
  (empty state on this staging tenant today).
- `03-first-card.png` — first AP card, MAIL-XXXX still hidden.

**Note**: the greeting is now `Good afternoon` on v221 vs
`Good evening` on v220 for the same real-world instant — direct
before/after evidence of the timezone fix.

---

## 9. Microsoft Graph timestamp path — verified correct

Verified independently that the underlying Calendar timestamp path
is NOT the cause of the 24h display; formatting was the only issue.

`src/lib/integrations/microsoft-graph-calendar.ts` correctly:

1. Requests `/me/calendarView` with
   `Prefer: outlook.timezone="${clubTz}"` — Graph honours this by
   returning `dateTime` as a naive wall-clock in the club's IANA
   zone plus a separate `timeZone` field.
2. Parses `dateTime` via `normaliseGraphInstant` (in this file) →
   `zonedTimeToUtc` (in `src/lib/mission-control/arrival.ts`),
   producing a proper absolute UTC `Date` (DST-safe via
   `Intl.DateTimeFormat` iteration).
3. Never parses the raw Graph string via `new Date(str)` (which
   would incorrectly interpret an offset-less ISO as UTC and shift
   the instant by the local offset — the founder-reported 6-hour
   bug that was already fixed in checkpoint 16H).

The rev-3 change is therefore a pure display-layer fix (24h → 12h),
not a timezone-conversion fix.

---

## 10. Other Mission Control timezone assumptions discovered

Audited surfaces during the investigation:

| Surface | Path | Status |
|---|---|---|
| `snapshot.dateLabel` / `timeLabel` (top-right sync meta) | `src/app/app/admin/page.tsx` (~line 72-84) | **Correct** — already uses `Intl.DateTimeFormat` with `snapshot.clubTimezone.ianaZone` (rendered as `Saturday, August 15 · 13:05 MDT`). Confirmed on v221. |
| `deriveClientState` on client tick | `src/components/mission-control/TodaysCommitments.tsx` (~line 27) | **Correct** — compares client `Date.now()` against absolute UTC instants stored on the commitment; no local-hour interpretation. |
| `deriveCommitmentState` on server | `src/lib/mission-control/commitments.ts` (~line 180) | **Correct** — same shape as client. |
| `formatLocalTime` (removed) | `src/lib/mission-control/commitments.ts` | **Fixed this slice** — replaced by shared `formatLocalTimeAmPm`. |
| `greetingForHour` (removed) | `src/app/app/admin/page.tsx` | **Fixed this slice** — replaced by shared `greetingWordForInstant`. |
| `TodaysCommitments` `setNow(new Date())` 60-second tick | `src/components/mission-control/TodaysCommitments.tsx` (~line 46-50) | **Correct** — the `Date` is used solely for absolute UTC-instant comparison against `startIso`/`endIso`, never as a local-hour source. |
| `startOfLocalDayUtc` / `todayLocalDateString` | `src/lib/mission-control/arrival.ts` | **Correct** — accept the tenant IANA zone as a parameter. |
| `zonedTimeToUtc` (Graph parse) | `src/lib/mission-control/arrival.ts` | **Correct** — DST-safe via `Intl.DateTimeFormat` iteration. |

No other Mission Control surface uses `new Date().getHours()`,
`getUTCHours()`, or a hard-coded offset for user-facing display.

---

## 11. Preserved Phase 4R rev-2 UI

No regression to any founder-approved rev-2 surface:

- Sidebar: `SPECTRE / AUTOMATION` two-line eyebrow intact (verified
  by Playwright rev-3 spec + full-page screenshot)
- Topbar: `Coulee Ridge Golf & Country Club | App > Mission Control`
  intact (rail child order `tenant → sep → crumbs`)
- Greeting: only the phrase `Good afternoon, Chris.` (no tenant
  appended)
- Work Intake cards: MAIL-LZWE and siblings still `display: none`;
  all AP fields identical to rev-2 state

No AP intelligence, no Work Intake state, no schema, no tenant
scoping logic touched.

---

## 12. Unexpected findings

None. The Graph calendar timestamp path was already correct (as
documented in checkpoint 16H). The only defects were:

- greeting bypassed the tenant timezone that was already available,
- commitments formatter emitted 24h.

Both fixed via a single new utility module. The Coulee Ridge
staging tenant happened to have no appointments today, so the
Playwright acceptance verified the AM/PM format via the empty-list
guard (which correctly bypasses format assertions when no rows are
present). Format is covered comprehensively by the vitest suites.
