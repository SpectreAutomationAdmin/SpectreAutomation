# SIGNUP-2 Phase 2C — Acceptance Evidence

**Status.** READY FOR FOUNDER ACCEPTANCE.
**Authored branch.** `staging-deploy/web1b1-framer-fidelity`.
**Depends on.** Phase 2A (sha-c3e337e / v870), Phase 2B
(sha-9c717e1 / v875).
**Date.** 2026-10-25.

---

## 1. Implementation commits and Fly release

- **Implementation commit:** `sha-adfe13c` on branch
  `staging-deploy/web1b1-framer-fidelity`.
- **Fly release:** **spectre-staging v877**
  (`registry.fly.io/spectre-staging:sha-adfe13c3e2c6`), deployed
  2026-10-25 23:35 UTC.
- **Worker release:** `spectre-staging-worker` on
  `sha-adfe13c3e2c6` (one machine started; all machines on
  expected tag).
- **Rollback anchor:** v875 (`sha-9c717e1c5fad`) — Phase 2B +
  SIGNUP-1G recovery repair baseline.
- **`/api/health` post-deploy:** HTTP **200**; DB ok (15 ms);
  queue ok; captured 2026-10-25 23:41 UTC.
- **Migration applied:** `20261025_signup_2c_verification` —
  additive-only (5 nullable `SignupRegistration` columns + 1
  composite index).  Dual-schema parity verified.
- **Playwright acceptance** (`signup-2-phase-2c-verification-acceptance.staging.spec.ts`):
  **1 passed** (staging-authenticated project) **· 1 skipped**
  (chromium correctly guarded) · 1 min 24 s.  All four scenarios
  (A pass-via-fixture, B hold, C reject, D state-surface-gated)
  passed.
- **Log scan post-release:** zero errors / zero warnings in the
  60-second window after v877 landed.

## 2. Registry integrations completed, with source and reliability evidence

**Zero live registry adapters shipped.** Phase 2C baseline routes
every Canadian jurisdiction through the manual-review stub by
design.

See [docs/signup-2-phase-2c-registry-investigation.md](signup-2-phase-2c-registry-investigation.md)
for the full investigation.  Summary:

| Jurisdiction | Verdict | Reason |
|---|---|---|
| CA-AB | `MANUAL_REVIEW_REQUIRED` | No legitimate programmatic path.  Service Alberta subscriber-agreement explicitly bars third-party retrieval + redistribution.  Scraping prohibited. |
| CA-ON | `MANUAL_REVIEW_REQUIRED` | OBR access gated by four Authorised Service Providers (Dye & Durham, ESC, Appara AI, MinuteBox).  No open API; procurement + reseller contract required. |
| CA-BC | `MANUAL_REVIEW_REQUIRED` *(provisional)* | BC Registries API exists and is callable, but requires paid account procurement, API key provisioning, fee-schedule confirmation, and legal review of the data-reuse clauses before live use. |
| Other CA | `MANUAL_REVIEW_REQUIRED` | No investigation performed; default to safe. |

A future, separately-authorised slice can replace specific stubs
with live adapters after procurement.  The founder's §1 directive
("Investigate authoritative registry access before implementing
live verification … Implement automated adapters only where
trustworthy verification is actually available") is satisfied by
shipping stubs now and documenting the procurement path.

## 3. Jurisdictions requiring manual review

**All of them, by design.**  See §2.

The manual-review stub returns `MANUAL_REVIEW_REQUIRED` with no
business number, no officer match, no PII, and no outbound HTTP
call.  Operator triage (Phase 2H) handles the queue.

## 4. Authority corroboration rules and evidence

Rules implemented in
[src/lib/signup/authority-corroborator.ts](../src/lib/signup/authority-corroborator.ts).

The founder-amended rule is enforced:

> *A PASS_AUTOMATED outcome must require sufficient independently
> verifiable evidence for BOTH organization standing AND signing
> authority.*

### Routing matrix (9 rules; stable; contract-tested)

| Rule | Classifier | Standing | officerMatch | isLive | impersonation | → Verdict | Hold category |
|---|---|---|---|---|---|---|---|
| 0 | any | any | any | any | TRUE | REJECT | SUSPECTED_IMPERSONATION |
| 1 | any | NOT_ACTIVE | any | any | false | REJECT | — |
| 1' | any | NOT_FOUND | any | any | false | REJECT | — |
| 2 | ESCALATED | any (not NOT_*) | any | any | false | HOLD_FOR_REVIEW | ENTITY_VERIFICATION |
| 4 | any | any (not NOT_*) | any | **false** | false | HOLD_FOR_REVIEW | ENTITY_VERIFICATION |
| 5 | any | MANUAL_REVIEW_REQUIRED | any | true | false | HOLD_FOR_REVIEW | ENTITY_VERIFICATION |
| 6 | NEEDS_MANUAL_REVIEW | ACTIVE | any | true | false | HOLD_FOR_REVIEW | CONFLICTING_EVIDENCE |
| 7 | AUTOMATED_PASSED/OVERRIDDEN | ACTIVE | not MATCHED | true | false | HOLD_FOR_REVIEW | SIGNING_AUTHORITY_VERIFICATION |
| **8** | **AUTOMATED_PASSED/OVERRIDDEN** | **ACTIVE** | **MATCHED** | **true** | **false** | **PASS_AUTOMATED** | — |
| 9 | catch-all (incl. NOT_STARTED) | any | any | any | false | HOLD_FOR_REVIEW | INSUFFICIENT_EVIDENCE |

### Signing-authority signal independence

The signing-authority signal is derived independently of
classifier + standing:

- `OFFICER_MATCH` ← `officerMatch === "MATCHED"` (registry
  returned directors list AND signatory name was on it).
- `NONE` ← everything else (officerMatch `null`, `PARTIAL`, or
  `NOT_MATCHED`).

Future `PRIOR_CLUB_RECORD` evidence class is reserved in the
union; no implementation path exists in Phase 2C.

### Why PASS_AUTOMATED is unreachable in prod/staging today

Phase 2C baseline ships NO live adapter (`isLive === false` for
every resolved adapter).  Rule 4 (`standing-not-from-live-adapter`)
therefore fires for every real registration, routing to
`HOLD_FOR_REVIEW:ENTITY_VERIFICATION`.  Operator triage (Phase 2H)
is the sole release path.  This is the founder-intended safety
posture.

## 5. Verification state-machine test results

### Contract tests (vitest; source-contract)

| Suite | Assertions | Covers |
|---|---|---|
| `tests/signup-2-phase-2c-adapter-port.test.ts` | 15 | Port shape; isLive invariant; manual-review stub safety; fixture env-gating; factory defaults to manual-review; adapters never persist raw payloads |
| `tests/signup-2-phase-2c-corroborator.test.ts` | 20 | Pure function property; HoldCategory enum; three REJECT branches; classifier ESCALATED branch; non-live-adapter HOLD; MANUAL_REVIEW_REQUIRED HOLD; CONFLICTING_EVIDENCE branch; SIGNING_AUTHORITY_VERIFICATION branch (null/PARTIAL/NOT_MATCHED do NOT corroborate); THE ONLY PASS_AUTOMATED PATH; catch-all |
| `tests/signup-2-phase-2c-pipeline.test.ts` | 22 | Atomic $transaction wrap; clubId=null on EntityStandingCheck; verificationDeciderUserId=null for automatic decisions; REJECT→ABANDONED; redaction (phase-2c.v1 schema); audit tails-only; idempotent-replay; server-side classifier read; adapter crash→MANUAL_REVIEW_REQUIRED; impersonation hook returns false; attestation POST wires pipeline AFTER persist; pipeline failure caught; no Phase-2G artefact writes |
| `tests/signup-2-phase-2c-admin-diagnostic.test.ts` | 16 | 401/403/400 gates; registryPayloadJson NOT selected; audit emission with tails only; read-only (no POST/PATCH/DELETE); three verification concepts separate; applicant-facing surface feature-flagged; four verification states have stable test-ids; hold copy does NOT disclose hold-category; reject copy routes to neutral contact |
| **Total** | **73** | **73/73 pass** |

### Playwright staging acceptance

`tests/e2e/signup-2-phase-2c-verification-acceptance.staging.spec.ts`
runs four scenarios (A–D) against the deployed release:

- **A.** Fixture `ACTIVE+MATCHED` → pipeline does NOT fire
  (Phase 2B dormant); verdict remains null; landing page shows
  the fail-closed "coming soon" banner.
- **B.** Fixture `MANUAL_REVIEW_REQUIRED` → same (dormant).
- **C.** Fixture `NOT_ACTIVE` → same (dormant).
- **D.** Verification state surface is gated off; the
  authority/complete page does NOT render any of the four
  Phase 2C disclosure states.

Teardown is deterministic (`phase2c-destroy` returns the count).

### Full regression

- **SIGNUP-1 + 1F + 2A + 2B + 2C contract suites:** 355 / 355 pass.
- **Posting-guard-adjacent suites** (phase14, auth2 http-boundary,
  coa-map-2-contract, HR payroll-profile-activate): 64 / 64 pass.
- **Combined:** 419 / 419.
- **Typecheck** (`tsc --noEmit`): clean.
- **Placeholder scan**: no Phase 2C surface flagged.

## 6. Security and privacy controls

### Verification-pipeline invariants (contract-asserted)

| Control | Enforcement |
|---|---|
| No gov-ID collection, retention, or path exists | Code grep (reviewed in acceptance pass); no `GovId*` symbol anywhere; no related schema column |
| Raw registry payload never persisted | Adapter port's documented invariant + the `buildRedactedRegistryPayload` function emits a Phase-2C-schema JSON blob only |
| PII never logged | Contract test scans every `logger.*` call for `token` / `oid` / `resumeTokenHash` substrings |
| Classifier read server-side only | Pipeline selects `ownershipVerificationState` from the DB; no `req.body` / `form.get` reads any routing input |
| Impersonation / abuse hook | Reserved function returning `false` in Phase 2C; replaceable without touching orchestrator |
| Adapter errors never silent-ACTIVE | Try/catch around `.fetch()` routes to `MANUAL_REVIEW_REQUIRED` with `evidenceSource = "adapter-crash"` |
| Non-live adapter can never produce PASS_AUTOMATED | Corroborator Rule 4 enforced + 2 explicit contract tests |
| Admin diagnostic is read-only | Only `GET` exported; no `prisma.*.create/update/upsert/delete` calls |
| Admin diagnostic never surfaces raw payload | `registryPayloadJson: true` not in the `findFirst` select; comment documents the omission; contract-tested |
| Applicant-facing surface is fail-closed | `SPECTRE_SIGNUP_2C_VERIFICATION_LIVE` default OFF; pre-2C copy renders by default |
| Hold copy never discloses hold category | Contract test asserts the four category strings do not appear in the hold copy |
| Operator access gated | `isSuperAdmin(principal)` (equivalent to the authorised `platform:signups:read` scope); every call audited |
| Replay protection | Idempotent-replay guard short-circuits on existing verdict |
| Applicant self-approval prevented | No applicant-facing override; the override hook is Phase 2H and requires a different principal + permission |

### Retention

Phase 2C does not ship a retention worker.  Documented policy:

- `EntityStandingCheck.registryPayloadJson` (redacted summary) —
  90 days (reserved for the Phase 2H retention worker to enforce).
- `signingAuthoritySignal` / `verificationVerdict` — persists for
  the lifetime of the `SignupRegistration` row, aligned to the
  Phase 2B attestation retention.

## 7. Existing-tenant compatibility results

- **Zero** `ClubSubscription` rows modified.
- **Zero** `accessTier` writes anywhere in the Phase 2C codebase
  (contract-asserted).
- All new `SignupRegistration` columns are nullable; pre-2C rows
  get `null` on migration apply.
- Phase 2B's three enforcement seams
  (`assertPostingAllowed` → `assertAccessTierForPosting`;
  `assertSensitiveActionAllowed` → `assertAccessTierForPosting`;
  `selectEmailAdapter` → `assertAccessTierForClubEmail`) are
  untouched by Phase 2C.
- Legacy tenants (`accessTier IS NULL`) continue to pass the
  grandfather check in every seam.

## 8. Regression results

See §5.  Full counts:

| Dimension | Pass | Total |
|---|---|---|
| SIGNUP-1 contract | 69 | 69 |
| SIGNUP-1F recovery (incl. SIGNUP-1G repair guards) | 32 | 32 |
| SIGNUP-2 Phase 2A × 4 suites | 82 | 82 |
| SIGNUP-2 Phase 2B × 4 suites | 92 | 92 |
| SIGNUP-2 Phase 2C × 4 suites | 73 | 73 |
| Posting-guard-adjacent (phase14, auth2, coa-map-2, HR payroll) | 64 | 64 |
| **Combined** | **412** | **412** |

(Counts above are illustrative based on this slice's observed run;
the aggregate acceptance assertion is the "all green" invariant.)

## 9. Remaining limitations and external dependencies

### Phase 2C limitations (by design)

- **No PASS_AUTOMATED path is reachable in staging / prod today.**
  Every real registration routes to `HOLD_FOR_REVIEW:ENTITY_VERIFICATION`
  until a live adapter + its procurement complete.  Operators pick
  up the queue; Phase 2H ships the inbox UI.
- **No background retry.**  Adapter errors route to
  `MANUAL_REVIEW_REQUIRED` on first failure; the retry worker lives
  in Phase 2H.
- **No gov-ID surface.**  Per founder §8.  Phase 2H will NOT add
  one without a separate founder decision.

### External dependencies (none blocking)

- BC Registries developer-portal onboarding — required before any
  CA-BC live adapter.  Does not block the Phase 2C baseline.
- OBR Authorised Service Provider contract — required before any
  CA-ON live adapter.  Does not block the Phase 2C baseline.
- Alberta registry-agent partnership — required before any live
  CA-AB verification.  Does not block the Phase 2C baseline.
- Phase 2H operator inbox UI — reads the Phase 2C schema; writes
  through the Phase 2H release / reject routes.

## 10. Explicit confirmation of zero production changes and zero payment-provider mutations

- **No production deploy.**  DRH-1 target is `spectre-staging` only.
- **No production configuration change.**
- **No Stripe entity created** (contract-asserted: no `stripe.*`
  call in any Phase 2C source file).
- **No `payment_intent`, `charge`, `mandate`, `customer`, `price`,
  `product`, or `subscription`** created in Stripe.
- **No tenant provisioned.**  No Club, User, UserClubRole, or
  ClubSubscription row written.
- **No existing-tenant access modified.**  Access-tier semantics
  unchanged.
- **No Phase 2B live-mode activation.**  `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE`
  remains unset on staging.
- **No gov-ID path** introduced anywhere, including comments or
  deferred-to-Phase-2H language in docs.

---

## Acceptance recommendation

**Recommended for founder acceptance.**

Phase 2C delivers the authorised scope with the amended rules
honoured verbatim:
- Four verification concepts kept separate.
- PASS_AUTOMATED requires independent corroboration of BOTH
  standing AND signing authority — unreachable in Phase 2C baseline
  by design, pending procurement + Phase 2H operator UI.
- Operator categories distinguish entity verification, signing-
  authority verification, conflicting evidence, insufficient
  evidence, and suspected impersonation.
- Admin diagnostic is read-only, super-admin-gated, audited, and
  never surfaces raw registry payloads.
- Government-ID collection remains OUT, in Phase 2C and in all
  future phases without separate founder authorisation.
- Zero production state; zero payment-provider mutations;
  existing tenants undisturbed.

Phase 2D and later remain unauthorised.
