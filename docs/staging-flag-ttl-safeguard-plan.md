# Staging Flag TTL Safeguard — Design (DRAFT; implementation unauthorised)

**Status.** PLANNING ONLY, pending founder authorisation.  No code
change yet.  This document captures a narrowly-scoped safety
improvement authorised by founder §1 of the Phase 2F closure
("introduce a defined maximum activation window and automatic
cleanup safeguards so test flags cannot remain enabled
indefinitely after a failed or stalled test").

---

## 1. Problem

Several SIGNUP-2 phases (2B, 2D, 2F, future 2G) ship with
feature flags that are OFF in the deployed container by default.
Staging acceptance temporarily flips a flag ON, runs a Playwright
spec, then flips the flag OFF.  Today the OFF step is only
reliable when:

- the Playwright run completes (pass or fail), AND
- the operator remembers to call `flyctl secrets unset`.

If the Playwright run is killed mid-flight, the operator's
machine loses connectivity, or the operator forgets, a test-only
flag could remain ON on staging indefinitely.  Scenario F of
Phase 2F already demonstrates that mock evidence cannot
authorise a production tenant even with the flag ON, so the
practical risk is low — but **flag drift on staging is a
pattern we should foreclose, not rely on operator vigilance to
avoid.**

## 2. Scope

The safeguard applies to **a small, named allowlist** of
staging test-only flags.  It MUST NOT touch:

- Any production flag (staging-only).
- Any secret that is not on the allowlist (DB URLs, Stripe keys,
  etc.).
- Any flag on `spectre` (prod) or `spectre-prod-worker`.

Initial allowlist (expand only with founder approval):

- `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE`
- `SPECTRE_SIGNUP_2D_OPERATOR_RELEASE_LIVE`
- `SPECTRE_SIGNUP_2F_ACTIVATION_LIVE`
- `SPECTRE_SIGNUP_2F_ALLOW_TESTONLY_SWEEP`

Maximum window: **120 minutes** (2 hours).  Any allowlisted flag
whose last-set time is older than 120 minutes is automatically
unset.

## 3. Mechanism

### Option A (recommended): scheduled GitHub Action

A new workflow file `.github/workflows/staging-flag-ttl.yml`:

- Trigger: cron `*/15 * * * *` (every 15 minutes).
- Steps:
  1. Install `flyctl` using the standard DRH-1 pattern + the
     repo's `FLY_API_TOKEN`.
  2. Run `flyctl secrets list --app spectre-staging --json`.
  3. For each allowlisted name that appears in the output and
     whose `digest`'s `createdAt` is older than 120 minutes,
     call `flyctl secrets unset --app spectre-staging <name>`
     + record the action in the workflow's step summary.
  4. If nothing was removed, exit success with the summary
     "no action — allowlisted flags are either unset or
     within the 120-min window."
  5. If any flag was removed, create a Fly machine health
     probe (`curl https://staging.spectreautomation.com/api/health`)
     + log the outcome.

The workflow also runs on `workflow_dispatch` (manual
run-this-now) for operator convenience.

### Option B (fallback): fly-worker scheduled job

If a GitHub Action is undesired, the same logic could live in a
Fly worker tick called by the existing worker's cron scheduler.
Downside: adds responsibility to the worker image + requires a
Fly API token stored in the worker's env.

**Recommendation:** Option A — the GitHub Action is cheaper, has
no incremental staging-side surface, and runs independent of
the staging container's own uptime.

## 4. Operator contract

- Playwright specs flip the flag ON at the start of their
  controlled window + call `flyctl secrets unset` on the way
  out.
- The TTL safeguard is a **net**, not the primary mechanism.
  Operators MUST still unset the flag immediately after their
  run.
- The 120-min window is a backstop against failure, not a
  license to leave the flag on longer than the test needs it.

## 5. Change surface

- 1 new workflow file (`.github/workflows/staging-flag-ttl.yml`).
- 1 doc file (this one, elevated to accepted status after the
  mechanism lands).
- 0 service-code changes.
- 0 schema changes.
- 0 secret adds.
- 0 production impact.

## 6. Rollback

If the TTL mechanism misbehaves, disable it by setting the
workflow file's `on.schedule` list to `[]` and merging; the
cron stops firing.  The already-unset flags stay unset; no
rollback is needed on the Fly side.

## 7. Open founder decisions

| # | Decision | Default | Blocks implementation? |
|---|---|---|---|
| 1 | Authorise building the workflow? | — (needed to start) | Yes |
| 2 | Max window (minutes) | 120 | No — can tune after a few windows |
| 3 | Cron interval (minutes) | 15 | No |
| 4 | Allowlisted flag names | the four above | No — adds via PR |
| 5 | Dry-run first week? | Yes (recommended) — write "would unset" to a step summary without actually calling unset | No |

## 8. What this document is + is not

**IS:** a design + authorisation request for a small-scoped
staging operational hygiene mechanism.

**IS NOT:** authorisation to build it, code to merge, or a
change to any live product path.
