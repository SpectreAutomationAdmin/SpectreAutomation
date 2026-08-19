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

Two commands must be green before ANY staging deploy:

```bash
npm run gate:mission-control    # Gate A: shell + Work Intake + AP + mailbox + Member
npm run gate:hr                  # Gate B: full HR suite (batch, not solo)
```

Or run both plus typecheck:

```bash
npm run gate:all
```

Fail count on either gate MUST be `0`. "Passes solo" is not a
passing gate — the batch itself must be green. If a test flakes
under batch execution, fix the isolation (add serialization, own
DB per suite, deterministic setup) — do NOT normalize retries.

## When staging fell behind main (this happens)

If staging is running an image older than `main` because someone
skipped a deploy, do NOT branch off `main` for the next feature
until staging catches up. Deploy the pending changes first (or roll
staging back if that's what the situation warrants). This exists
because "branch off main, then deploy after work is done" creates
merge conflicts against a moving staging state.
