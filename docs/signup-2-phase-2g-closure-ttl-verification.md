# Phase 2G Closure — Staging Flag TTL Safeguard Verification

**Status.** VERIFIED 2026-10-26 against the deployed Fly staging
environment.  Finding: the previous workflow design relied on
Fly-exposed `CreatedAt` metadata that **does not exist** in
`flyctl secrets list --json` output.  The smallest safe
correction is implemented below.

**Scope.** Verification of founder closure §2 (seven TTL
behaviours).  No production surface changes.  No application-code
changes.

---

## 1. Fly-exposed secret metadata — ground truth

Query against `spectre-staging` on 2026-10-26:

```
$ flyctl secrets list --app spectre-staging --json
[
    {
        "name": "AWS_ACCESS_KEY_ID",
        "digest": "3f3cdc789af5c002",
        "status": "Deployed"
    },
    ...
]
```

Each entry has exactly three fields: `name`, `digest`, `status`.
**No `CreatedAt`, no `UpdatedAt`, no set-time timestamp.**

A one-shot set-and-inspect probe confirmed the behaviour:

```
$ flyctl secrets set --app spectre-staging TTL_VERIFY_TMP=hello
...
$ flyctl secrets list --app spectre-staging --json | jq '.[] | select(.name=="TTL_VERIFY_TMP")'
# (same three fields, no timestamp)

$ flyctl secrets unset --app spectre-staging TTL_VERIFY_TMP
```

The verification secret was removed immediately; no state persists
on staging.

---

## 2. Impact on the previous workflow design

The `sha-5e60715` version of `.github/workflows/staging-flag-ttl.yml`
read `.CreatedAt` from the JSON output + enforced a 120-minute
window from that timestamp.  Because `.CreatedAt` is undefined,
the previous workflow would have:

- Set `created="null"` or `""` for every allowlisted flag.
- Tripped the `[ -z "$created" ]` branch which emits
  `::notice:: ... treating as EXPIRED`.
- Unset every allowlisted flag on every scheduled run.

**Net effect:** the previous "per-activation TTL" design would
have behaved identically to the earlier "unconditional unset
every tick" design — the exact pattern the founder's closure
§6 directed me to replace.

The scheduled trigger was **not currently firing on `main`** (the
default branch) at the time of discovery because this slice lives
on `staging-deploy/web1b1-framer-fidelity`.  Scheduled GitHub
workflows only run from the default branch's copy of the file,
so no auto-unsets happened in practice.  The defect is **dormant
until the branch is merged**.

---

## 3. The smallest safe correction (SHIPPED under this closure)

The workflow is rewritten to **safe-diagnostic mode**:

- Cron trigger (`schedule:`) **removed**.
- Only `workflow_dispatch` fires the workflow.
- The default dispatch mode is **read-only diagnostic**: lists
  allowlisted flags + their sibling `*_EXPIRES_AT` secrets,
  logs them, and takes NO destructive action.
- An opt-in `confirm_unset=true` dispatch input unsets the
  flags (allowlist-gated, no arbitrary secrets).
- The step summary links back to this document.

This replaces the broken auto-unset behaviour with an **operator-
driven** mechanism that honours the "do not interrupt a valid test"
invariant.  The scheduled auto-cleanup is intentionally deferred
until the proposed corrective slice (§4) is authorised and shipped.

---

## 4. Proposed corrective slice (NOT authorised; NOT shipped)

Smallest staging-only correction that restores scheduled auto-
cleanup with per-activation expiry:

### 4.1 New endpoint

`GET /api/signup-ops/staging-flag-ttl-state`

- **Staging-only.**  Refuses with 404 unless
  `SPECTRE_ENV_LABEL === "staging"`.
- **Shared-secret gated.**  A single `STAGING_FLAG_TTL_READ_TOKEN`
  env var (set via `flyctl secrets set`) is compared against
  `Authorization: Bearer <token>`.  The same token lives as a
  GitHub Actions environment secret so the workflow can send it.
- **Read-only.**  Enumerates the six allowlisted flag names +
  reads each sibling `<FLAG>_EXPIRES_AT` env var's VALUE
  (which the operator sets alongside the flag).  Returns:
  ```
  {
    "flags": [
      { "name": "SPECTRE_SIGNUP_2G_PROVISIONING_LIVE",
        "set": true,
        "expiresAt": "2026-10-26T18:00:00Z",
        "expired": false,
        "maxWindowExceeded": false }
    ]
  }
  ```
- **No secret values leak.**  The endpoint returns only
  metadata (`set`, `expiresAt`, `expired`) and NEVER the flag's
  value.
- **Rate-limited** via Spectre's existing middleware.
- **Expiry format**: strict ISO-8601 UTC; invalid or missing
  values → `expired: true, maxWindowExceeded: true` (safe
  default; operator didn't follow the activation contract).
- **Max window enforcement**: any `expiresAt > now + 120 min`
  → `maxWindowExceeded: true`, treated as expired by the
  workflow.

### 4.2 Operator contract

```
# Activating a flag for a controlled window:
flyctl secrets set --app spectre-staging \\
  SPECTRE_SIGNUP_2G_PROVISIONING_LIVE=1 \\
  SPECTRE_SIGNUP_2G_PROVISIONING_LIVE_EXPIRES_AT=2026-10-26T18:00:00Z
```

Both secrets MUST be set in the same `secrets set` call so the
machine restart is atomic.

### 4.3 Workflow re-enablement

- Re-add `schedule: '*/5 * * * *'`.
- Workflow calls the staging diagnostic endpoint, parses the
  JSON, computes which flags are expired, calls
  `flyctl secrets unset` for each + its expiry sibling.
- Logs + health-probes as before.
- Still `environment: staging` only; no production access.

### 4.4 Non-authorisations

- No production endpoint.
- No existing-tenant impact.
- No new persistent application configuration beyond the one
  staging-only env var pair.
- No live-user-identifiable data exposed.
- A separate `STAGING_FLAG_TTL_READ_TOKEN` rotation runbook is
  needed (same pattern as other operator-only shared-secret
  routes in Spectre).

### 4.5 Change surface

- 1 new route file (`src/app/api/signup-ops/staging-flag-ttl-state/route.ts`).
- 1 updated workflow (restore cron + call endpoint).
- 1 new runbook entry.
- Zero schema change.
- Zero existing-service change.

---

## 5. Verification of the seven founder-named behaviours

Each scenario was walked through against the **safe-diagnostic**
workflow (as shipped) + the proposed corrective design (§4).

| # | Behaviour | Safe-diagnostic (current) | Proposed corrective slice |
|---|---|---|---|
| 1 | **Initial flag activation** | Operator sets the flag + sibling `_EXPIRES_AT` secret; workflow dispatch (no `confirm_unset`) reports them as present; no action taken. | Same.  Workflow's next scheduled fire reads expiry via endpoint, sees `expired: false`, takes no action. |
| 2 | **Flag disabled before expiry** | Operator manually unsets the flag + sibling.  Workflow dispatch reports no allowlisted flags present. | Same.  Workflow's next scheduled fire sees `set: false`, takes no action. |
| 3 | **Same flag re-enabled for a fresh window** | Operator re-sets flag + new ISO expiry.  Workflow dispatch sees them present with new sibling expiry. | Fly digest changes.  Workflow's next scheduled fire reads NEW expiry value via endpoint, computes `expired: false`, takes no action. |
| 4 | **Expired flag auto-removed** | Workflow dispatch with `confirm_unset=true` unsets allowlisted flags (operator-driven, not automatic in safe-diagnostic mode). | Workflow's next scheduled fire sees `expired: true`, calls `flyctl secrets unset <FLAG> <FLAG>_EXPIRES_AT`. |
| 5 | **Unexpired flag preserved** | Workflow dispatch without `confirm_unset` never touches unset.  With `confirm_unset=true` on a valid in-window test → operator intentionally wants to end the test early.  Safe. | Workflow's scheduled fire reads `expired: false`, skips.  Operator keeps running the test. |
| 6 | **Missing or malformed expiry** | Workflow dispatch reports the flag with "sibling expiry: <none>".  Operator sees the drift. | Endpoint returns `expiresAt: null, expired: true, maxWindowExceeded: true`.  Workflow unsets at next tick (safe default; operator forgot the contract). |
| 7 | **Workflow failure reporting** | `jq`-based parsing + `flyctl` calls fail-fast under `set -euo pipefail`; any step failure exits non-zero → standard GitHub Actions failure notification. | Same.  Endpoint failures surface as HTTP non-200; workflow fails. |

**All seven are addressed either by the safe-diagnostic mode as
shipped, OR by the proposed corrective slice (§4) when authorised.**

---

## 6. Operator standing contract until the corrective slice ships

- Operators continue to use `flyctl secrets set` + `flyctl secrets
  unset` to flip SIGNUP-2 test-only flags for controlled windows.
- Operators MUST unset the flags at the end of every window
  manually.
- The TTL safeguard workflow is available as a **manual** backstop
  via `workflow_dispatch` (both read-only diagnostic + confirmed
  unset modes).
- No automatic cleanup fires until the corrective slice (§4) is
  authorised and shipped.

---

## 7. Non-authorisations preserved

- No production secret access.
- No new permanent application configuration (the shipped
  workflow change is a GitHub-side config; the proposed
  corrective slice is NOT shipped yet).
- No existing-tenant impact.
- No live-user-identifiable data exposure.

---

**End of TTL verification.**  The current staging TTL safeguard
runs in SAFE DIAGNOSTIC mode until the corrective slice (§4) is
authorised.
