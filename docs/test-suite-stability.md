# Test Suite Stability

How Spectre's automated validation is structured, why the
"full source-contract suite" used to hang for 10–15 minutes, and what
to run for each kind of change.

---

## Root cause of the SQLite WAL-lock symptom

The symptom — *"vitest workers contending for `prisma/test.db` and
the source-contract suite hanging at ~9 minutes with a `beforeEach`
hook timeout"* — has two compounding causes. Only the first is
infrastructure; the second is policy.

### 1. Slow `resetDb()` × per-test `beforeEach` × Windows SQLite

[`tests/util/db.ts`](../tests/util/db.ts) `resetDb()` executes ~200
`deleteMany()` calls in sequence to wipe every table FK-safe. The
package's heavy DB-using test files call it from `beforeEach`:

```ts
// tests/monthly-reporting-package.test.ts:20
beforeEach(async () => { await resetDb(); await seedRbac(); });
```

The monthly reporting source-contract suite carries **168 tests**.
Of those, the majority are **pure source-contract** — they read
`page.tsx` as a string and assert regex patterns against it. They do
not need the DB. But the file-level `beforeEach` runs `resetDb()`
unconditionally, so each of the 168 tests pays a ~200-delete tax.

On Windows / SQLite WAL mode each `deleteMany` is ~5–10 ms even
against an empty table (WAL append + index touch). That is:

> 168 tests × 200 deletes × ~7 ms ≈ **3–5 minutes of pure cleanup
> overhead**, before any test work is done.

The 9-minute total wall-clock matches: ~4 min of cleanup overhead +
~5 min of legitimate test work + variability.

### 2. Stray workers from killed runs hold the WAL lock open

When the Vitest run is interrupted (founder cancels, harness times
out, child run errors mid-flight), worker processes can outlive the
parent. On Windows SQLite + WAL mode, the still-alive worker holds an
open handle to `test.db-wal` / `test.db-shm`. A *new* `vitest run`
session then either:

- waits indefinitely for the lock, or
- bombs the `beforeEach` hook 20 s into the next test ("hook timeout")
  because the schema reset can't proceed.

This is the "WAL-lock contention" symptom. It is real but it is a
*consequence* of cleanup #1 being slow enough that runs get
interrupted often.

### 3. Why the targeted Playwright + typecheck always succeed

Playwright doesn't touch `prisma/test.db` at all — it hits the live
dev server on port 3000 which uses `prisma/dev.db`. Typecheck doesn't
touch any DB. Those two are completely independent of the SQLite
WAL-lock pathology.

---

## Current scripts (pre-fix)

| Script | What it does | DB? | Bounded? |
|---|---|---|---|
| `npm test` | `vitest run` — every test file | yes | no (10–12 min worst case) |
| `npm run test:targeted` | `vitest run --changed` — only changed files | yes | depends on changes |
| `npm run test:e2e` | `playwright test` (serial, 1 worker) | no (live dev db) | yes (~5 min) |
| `npm run typecheck` | `tsc --noEmit` | no | yes (~5 s) |
| `npm run scan:placeholders` | TODO/scaffold scanner | no | yes (~3 s) |
| `npm run nav:audit` | navigation audit | no | yes (~5 s) |
| `npm run dev:health` | live-route health probe | yes (dev db) | yes (~2 s) |
| `npm run quality` | typecheck + scan + ui-audit + test + build + smoke | yes | **no — hangs on test** |
| `npm run quality:changed` | typecheck + scan + targeted | depends | depends |

The Vitest config already sets `fileParallelism: false` and the
Playwright config already pins `workers: 1`. Serial execution is
already enforced — the problem is the duration of the serial run, not
parallelism.

---

## New scripts (post-fix)

| Script | Purpose | DB? | Bounded? | Typical runtime |
|---|---|---|---|---|
| **`npm run test:cleanup`** | kill stray Vitest workers, remove stale WAL/SHM lock files | n/a | ~3 s | ~3 s |
| **`npm run test:unit:fast`** | Vitest, pure source-contract files only (no DB cost) | no | yes | ~5–10 s |
| **`npm run test:db:serial`** | Vitest, every DB-using test file, one worker, `--bail=1` | yes | yes (15-min wall-clock cap via shell timeout) | 8–10 min |
| **`npm run test:e2e:serial`** | Playwright (alias of existing `test:e2e`, kept for naming symmetry) | no | yes | ~3–5 min |
| **`npm run quality:stable`** | the full chain: cleanup → typecheck → unit:fast → db:serial → build → nav:audit → e2e:serial | yes | yes (chained `&&`, fails fast on first error) | 15–20 min worst case |

`npm run quality:stable` runs each phase with start/end timestamps to
stdout. If a phase exceeds its bounded time, the underlying tool exits
with a non-zero code (Vitest has internal `testTimeout` + `hookTimeout`
of 20 s already), and the chain breaks. **It will not retry on its own.**

---

## Test categorization

Files that **do not import `@/lib/prisma`, `resetDb`, `seedRbac`, or
`prisma.`** at all — these are pure source-contract or pure-fn unit
tests and form `test:unit:fast`:

- `tests/finance.test.ts`
- `tests/floor-plan-editor-drag.test.ts`
- `tests/floor-plan-geometry.test.ts`
- `tests/greeting.test.ts`
- `tests/logout-redirect.test.ts`
- `tests/menu-density.test.ts`
- `tests/menu-description-typography.test.ts`
- `tests/navigation.test.ts`
- `tests/seatpos-layout.test.ts`
- `tests/seatpos-menu-tile-density.test.ts`
- `tests/lib/attention-engine.test.ts`

Every other test file (60 files) uses the DB and runs in
`test:db:serial`. Among those, the slowest is
`tests/monthly-reporting-package.test.ts` (168 tests, ~10 min)
because of the per-test `resetDb()` cost noted above. A future
refactor that lifts most of its assertions to a file-level `beforeAll`
(or splits the source-contract assertions into a separate `*.contract.test.ts`
file that lives under `test:unit:fast`) would shave 4–5 minutes —
explicitly **out of scope for this stability pass**.

---

## Which tests run serially / in parallel

| Pool | Pool option | Workers | Why |
|---|---|---|---|
| `test:unit:fast` | (default Vitest pool) | 1 (file parallelism off project-wide) | trivial; ~10 s either way |
| `test:db:serial` | `--pool=forks --maxWorkers=1 --minWorkers=1 --sequence.concurrent=false` | 1 fork | one process owns the SQLite handle; no WAL-lock contention possible by construction |
| `test:e2e:serial` | Playwright `workers: 1` (already configured) | 1 | DB-mutating UI flows must be deterministic |

`fileParallelism: false` in [`vitest.config.ts`](../vitest.config.ts)
already enforced file-level serialization globally. The new commands
add **explicit worker pinning** so a future Vitest config change can't
accidentally re-enable concurrency on the DB suite.

---

## Recommended workflows by change size

### Small UI / visual change (e.g., a className tweak)

```bash
npm run typecheck                          # ~5 s
npx playwright test tests/e2e/<spec>.spec.ts   # targeted, ~10–30 s
```

Skip the full source-contract suite. Visual changes don't exercise
DB or service code; the targeted Playwright spec + screenshot is
sufficient evidence.

### Medium feature change (new component, new field)

```bash
npm run typecheck
npm run test:unit:fast                    # ~10 s — all pure-fn + source-contract files
npm run test:targeted                     # ~varies — vitest --changed
npm run build                             # ~30 s
```

### Full confidence (PR-ready, release-ready)

```bash
npm run quality:stable
```

Bounded at ~15–20 min. Phases announce themselves; if any phase fails,
the chain stops at the failing phase with the exact command and exit
code. No retry loops.

### When `quality:stable` reports a SQLite lock

```bash
npm run test:cleanup                      # ~3 s
npm run quality:stable                    # retry, ONCE
```

If the second run still locks, **stop and investigate**. Do not loop.
The actionable error message will name the holding process.

---

## Future improvement (not implemented in this pass)

The biggest single win is to split per-file source-contract tests
out of the DB-using suites. `tests/monthly-reporting-package.test.ts`
in particular has ~150 tests that only read the source string and
~18 tests that bootstrap a club. Moving those 150 to a
`tests/monthly-reporting-package.contract.test.ts` file with no
`beforeEach resetDb()` would drop the DB suite by ~4–5 minutes and
make iteration on reporting UI changes much faster.

That refactor is documented here for visibility but is **out of scope
for the stability pass**. The current `quality:stable` is the
bounded, reliable, founder-runnable command requested by the prompt;
the refactor is a separate optimisation.
