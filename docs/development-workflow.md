# Spectre Development Workflow

Non-negotiable process rules learned from the 2026-08-18 Mission
Control regression. Read before starting a new module.

## The founder-approved baseline is NOT the `main` branch by default

Root cause of the 2026-08-18 regression: `main` had NOT been updated
with `work-intake-state-outlook-archive-fix` (Phase 4R rev-4 → rev-14
+ Phase 20 Member Database) even though staging had been founder-
approved on that branch. When the HR-1 branch was created off `main`,
it silently rewound Mission Control by ~36 commits.

**A new phase must branch from the latest integrated founder-approved
baseline, not from whatever commit happens to be called `main`.**

## Before creating a new feature branch — mandatory pre-flight

Before `git checkout -b <new-phase>`, verify:

```bash
# 1. What commit does staging run right now?
flyctl status --app spectre-staging | grep Image

# 2. Which commit did that image build from?
# (Look at deploy/fly.web.toml or your build metadata; if unclear,
# ask the human before proceeding.)

# 3. Which commit is the last-known-good founder review?
# — check most recent docs/*checkpoint*.md
# — check the last "founder approved / accepted" commit

# 4. Is the founder-approved SHA an ancestor of main?
git merge-base --is-ancestor <FOUNDER_SHA> main && echo OK || echo BLOCKED

# 5. Are there any long-lived WIP branches with founder-approved
#    work that has not been merged?
git branch -a --sort=-committerdate | head -10
git log <BRANCH>..main --oneline | head   # empty = branch is merged
```

If step 4 reports `BLOCKED` **STOP.**

Do not proceed with the new feature branch until the founder-approved
work is either:
- merged to `main`, or
- explicitly acknowledged and the new branch is created off the
  founder-approved SHA (not `main`).

Silent divergence between `main` and the founder-approved baseline
is a "process invariant violation" — treat it with the same weight
as a schema-migration break.

## Branch hygiene during a phase

- Rebase or merge from the founder-approved baseline **weekly**
  (not "at the end"). Long-running branches accumulate drift.
- Any commit that touches shared shell files (`AdminShell.tsx`,
  `sidebar-nav-data.ts`, `admin/layout.tsx`, `globals.css`,
  Mission Control page, EmailIntakeCard, mailbox/*, AP intelligence)
  requires the diff-author to state in the commit message **why the
  shared surface had to change** to accomplish the module's own
  goal. If the answer is "it didn't", the change belongs in a
  different commit that is separately reviewed.

## Closing out a phase

- Landing a phase means merging or rebasing the WIP branch onto
  `main`. **A "closeout checkpoint" that leaves the branch behind
  is not closed.**
- The person who deploys to staging is responsible for confirming
  the staging release matches an ancestor of `main`. If it doesn't,
  the mismatch must be surfaced to the founder before the next
  phase begins.

## Test invariants that must exist

`tests/mission-control-integration-sentinel.test.ts` pins the
combined Mission Control + HR contract. This file is INTENDED to
fail loudly when a shared regression sneaks in. If you touch shell
/ Work Intake / mailbox / AP projection and the sentinel fires,
that is the alarm — do not update the sentinel to make it pass
unless the founder has explicitly authorised the underlying
behaviour change.

## Data protection during branch reconciliation

- **Never** `prisma db push --accept-data-loss` against staging or
  production. Local disposable SQLite only.
- Combined migrations from two branches must be reviewed for
  non-destructive ordering before deploying to any shared
  environment.
- A three-way merge that removes a column is a schema regression
  regardless of what the app code does. Additive-nullable is the
  bar for the reconciliation step; destructive migrations happen
  in a separate reviewed slice, never inside the reconciliation.

## Closeout gate — mandatory before declaring a phase CLOSED

Before declaring a founder-approved phase CLOSED, Claude MUST prove:

```bash
npm run check:founder-baseline -- <founder-approved-sha>
```

exits `0` (i.e. `founder-approved SHA ∈ main`).

If the script exits `1`, the phase is **NOT closed**, regardless of
what the checkpoint prose says. Reconcile `main` first — either
fast-forward, merge, or explicitly acknowledge (with founder
authorization) that the work is intentionally staying off `main`.

The 2026-08-18 Mission Control regression happened because we
treated a phase as closed while the founder-approved work was
stranded on `work-intake-state-outlook-archive-fix`. The next
module (HR) branched off `main`, silently rewound Mission Control
by ~36 commits, and the regression surfaced in founder review
weeks later. This closeout gate is the mechanical bar that makes
that class of failure impossible to repeat.

## Canonical test gates

The validation ladder — pick the smallest gate the change requires:

```bash
npm run gate:hr:touched         # Gate 1: only tests covering the touched files
npm run gate:hr:domain          # Gate 2: HR security + admin + cross-cutting + integration sentinel
npm run gate:hr:full            # Gate 3: full HR regression
npm run gate:mission-control    # MC: shell + Work Intake + AP + mailbox + Member
npm run gate:all                # typecheck + MC + full HR
```

Measured runtimes on 12-CPU dev box (2026-08-20 benchmark):

| Gate | Files | Tests | Wall time |
|---|---|---|---|
| `gate:mission-control` | 21 | 216 | 2 min 34 s |
| `gate:hr:touched` (narrow slice, no schema) | 10 | 180 | 4 min 34 s |
| `gate:hr:domain` | 46 | 555 | 8 min 52 s |
| `gate:hr:full` | 64 | 625 | 10 min 25 s |

Baseline before the 2026-08-20 optimization: `gate:hr:full` was ~45
minutes single-thread (pool: threads, fileParallelism: false, shared
`prisma/test.db`). The 4.3× speedup came from per-worker SQLite
isolation, not from cutting tests — every test that ran before still
runs.

The `gate:hr:touched` measurement above was against a mixed slice
(HR-2B.4: schema + services + UI). When the slice includes a schema
or migration change, the wrapper escalates to the full HR gate
(preserves founder-mandated broad-blast invariant). For a narrow UI-
only change, expect ~2-3 min.

Fail count on any gate MUST be `0`. "Passes solo" is not a
passing gate — the batch itself must be green. If a test flakes
under batch execution, fix the isolation (per-worker DB, own
seed, deterministic setup) — do NOT normalize retries.

### Which gate for what

| Situation | Gate |
|---|---|
| Focused HR implementation, incremental feedback loop | `gate:hr:touched` |
| Substantial HR slice, pre-staging deploy | `gate:hr:domain` + `gate:mission-control` |
| Schema / security / authentication / canonical-service change | `gate:hr:full` |
| Pre-merge to `main` | `gate:all` |
| Pre-production deploy | `gate:all` |
| Periodic confidence sweep | `gate:hr:full` |

### Test-harness isolation model

All gate configs use `pool: "forks"` + `fileParallelism: true` +
`isolate: false`. Every vitest worker is a separate Node process
identified by `VITEST_POOL_ID`; `tests/setup.ts` computes a per-worker
SQLite path `prisma/test-workers/w<POOL_ID>.db` copied from the
schema template `prisma/test-template.db` built by `tests/global-setup.ts`.

This eliminates the cross-file SQLite lock contention that forced
serial execution in earlier revisions of this repo. `resetDb()` in
`tests/util/db.ts` still runs per test file, but it operates on the
worker's private DB — no cross-worker interaction.

`isolate: false` reuses the fork's module registry (and Prisma
client) across test files within a fork, avoiding a ~5-10 s
cold-start per file. Because each fork keeps its own worker DB and
tables are wiped between tests, the shared cache is safe.

Never turn `fileParallelism: false` back on in these configs. If a
new test flakes under parallelism, the correct fix is either:
- Add its outputs to `resetDb()` teardown (so data is properly
  isolated between test files within a fork), OR
- Move the flake-prone file into its own fork via `test.concurrent`
  discipline — never a global serialization switch.

### Touched-area mapping

`scripts/resolve-touched-tests.ts` reads `git diff --name-only
<base>...HEAD` (default base `main`) and maps changed source files
to vitest globs. The mapping is intent-based — new files under a
covered surface pick up their globs automatically via prefix rules.
Schema changes trigger the FULL HR set (broad blast radius). Test
files map to themselves. If a source file has no rule match, the
resolver prints the integration sentinel only so nothing is
silently skipped — but if you see that fallback for an intended
change, add a rule.

The `npm run gate:hr:touched` wrapper (`scripts/gate-hr-touched.mjs`)
runs the resolver + passes the result to `vitest run --config
vitest.gate-hr-full.config.ts <globs>`.

### Staging deploy policy

For normal HR incremental slices:
1. `gate:hr:touched` green.
2. Domain/security gate green when touched surface is broad.
3. `typecheck` clean.
4. Prisma validate if schema changed.

`gate:hr:full` remains mandatory before merge to `main` and before
production deploy. A 45-minute full sweep is NOT required before
every staging iteration.

## When staging fell behind main (this happens)

If staging is running an image older than `main` because someone
skipped a deploy, do NOT branch off `main` for the next feature
until staging catches up. Deploy the pending changes first (or roll
staging back if that's what the situation warrants). This exists
because "branch off main, then deploy after work is done" creates
merge conflicts against a moving staging state.
