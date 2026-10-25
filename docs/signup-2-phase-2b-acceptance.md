# SIGNUP-2 Phase 2B — Acceptance Evidence

**Status:** ACCEPTED BY FOUNDER 2026-10-25.
**Final deployed baseline:** `sha-9c717e1` / Fly v875
(image `registry.fly.io/spectre-staging:sha-9c717e1c5fad`).
The v875 image contains the full Phase 2B stack: `07924e9`
(implementation) + `2a0e939` (polish) + `9c717e1` (SIGNUP-1G
recovery repair, delivered in the same window).  Founder-confirmed
Phase 2B closure via the same email that authorised Phase 2C
planning.

**Authored branch:** `staging-deploy/web1b1-framer-fidelity`
**Phase baseline:** sha-9fbc7fc (Phase 2B authorization at sha-c3e337e)
**Date:** 2026-10-25

## 1. Commits + Fly release

- Implementation commits:
  - **sha-07924e9** — Phase 2B main implementation (18 files, 2264+).
  - **sha-2a0e939** — Phase 2B polish (`verify` fixture subcommand +
    Playwright hardening + acceptance evidence update).
  - **sha-9c717e1** — SIGNUP-1G recovery repair (scanner-safe GET
    landing page + POST-only consume).
- **Final deployed baseline: Fly spectre-staging v875**
  (image `registry.fly.io/spectre-staging:sha-9c717e1c5fad`),
  deployed 2026-10-25 22:05 UTC.  Supersedes the interim v873
  (`sha-07924e911c7e`).  v875 includes the full Phase 2B stack
  AND the SIGNUP-1G repair in one image.
- Worker release: **spectre-staging-worker** on `sha-9c717e1c5fad`
  (one machine started; all machines on expected tag).
- Rollback anchor: v874 (`sha-07924e911c7e`) — Phase 2B main at
  v873 before the SIGNUP-1G repair landed.
- `/api/health` post-deploy: **HTTP 200** · DB ok · queue ok.
- Migration outcome: **no migration applied** (Phase 2B reuses
  Phase 2A's schema per founder §6).
- Log scan result: zero errors / zero warnings in the 60-second
  window after v875 landed.

## 2. Scope — in Phase 2B, strictly

Phase 2B ships the attestation surface, the ToS-pipeline, and the
access-tier enforcement seams prospectively.  The feature flag
`SPECTRE_SIGNUP_2B_ATTESTATION_LIVE` stays OFF.  No live signatory
is ever exposed to the development fixture.

The following are explicitly out-of-scope for Phase 2B and NOT
touched:

- `ClubSubscription.create` / `upsert` for any new tenant.
- Any `accessTier` write to any existing tenant.
- Any Stripe entity.
- Any production configuration change.
- Any new user / Club / UserClubRole / portal publish.
- Phase 2C and later.

## 3. Capability enforcement coverage matrix (§3 mandate)

See [signup-2-phase-2b-capability-matrix.md](./signup-2-phase-2b-capability-matrix.md).

Three seams:

1. **Seam 1 — posting-guard** (`src/lib/posting-guard/index.ts`):
   `assertPostingAllowed` + `assertSensitiveActionAllowed` both call
   `await assertAccessTierForPosting(clubId)` after the training-mode
   and support-session gates.  Covers classifications A + B (40+
   callers).
2. **Seam 2 — email adapter** (`src/lib/integrations/email.ts`):
   `selectEmailAdapter(clubId)` calls
   `await assertAccessTierForClubEmail(clubId)` BEFORE any adapter
   construction.  Covers classification C (`club.mailbox.send`,
   `club.user-invites.deliver`).
3. **Seam 3 — Microsoft 365 delegated mailbox write**: Deferred
   to Phase 2G (no new tenants with mailbox integrations are
   created in Phase 2B).

All gates grandfather legacy tenants:
`accessTier IS NULL → PASS`, no `ClubSubscription` row → PASS,
`accessTier = "FULL"` → PASS, `subscriptionStatus = "MANUAL_INVOICE"`
→ PASS.  Only `STAGED` / `SUSPENDED_READ_ONLY` and unknown-future
tier values FAIL.  Existing tenants: ZERO have a non-null tier on
staging today — ZERO regress.

## 4. UI + persistence evidence

- Attestation surface at `/signup/t/[token]/authority` renders a
  fail-closed banner when the flag is unset.  When live, it renders
  the attestation copy, the two signatory fields, the required
  checkbox, and the submit button — all with stable `data-testid`
  values for Playwright coverage.
- Status page at `/signup/t/[token]/status` carries a feature-flagged
  CTA linking to `/authority` — hidden until the flag is on AND the
  admin is Microsoft-verified.
- Receipt page at `/signup/t/[token]/authority/complete` displays
  the attestation metadata (signatory name/title, ToS version label,
  acceptance timestamp) with no automatic progression — a Phase 2B
  dead end by design.
- API `/api/signup/authority/accept` persists one
  `SubscriptionAuthorisationAttestation` row + flips
  `SignupRegistration.step → AUTHORITY_ACCEPTED` in a single
  `prisma.$transaction`.
- No new Prisma migration: the Phase 2A `SubscriptionAuthorisationAttestation`
  model already contains every field this phase writes.  Phase 2B
  reuses that schema per founder §6 ("Prefer the existing Phase 2A
  schema where sufficient").

## 5. Legal + feature-flag safety

- `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE` is the single live-mode gate.
  Default (unset) or anything other than the literal string `"1"`
  → fail-closed (`ForbiddenError`).
- The Terms-of-Service helper
  (`src/lib/billing/terms-of-service.ts`) rejects any resolved
  document whose status is not `APPROVED`, and additionally
  blocks any label starting with `ToS-dev-fixture`.
- The committed dev fixture at
  `docs/legal/terms-of-service-fixture-dev.md` carries
  `Label: ToS-dev-fixture-2026-10-25` and
  `Status: DEVELOPMENT_FIXTURE`.  Even with the flag flipped to
  `"1"` on staging, the gate refuses to persist an attestation
  against the dev fixture — the live form will not render.

Founder decisions preserved:

- §2.1 "Do not publish or activate placeholder legal terms" — code
  refuses to even if operator flips the flag.
- §2.3 "Draft professional wording.  Do not represent it as legally
  approved" — `ATTESTATION_TEXT` is professional attestation
  wording, exported as a constant and SHA-256 hashed at acceptance
  time; a review path can rotate it before activation.
- §5 "Do not change production configuration" — no `fly.toml`,
  secrets, or env changes.

## 6. Security + idempotency tests

Contract tests (vitest, 92/92 pass):

| File | Assertions | Covers |
|---|---|---|
| `tests/signup-2-phase-2b-attestation-contract.test.ts` | 30 | Fail-closed gates; input validation; server-side identity (NO client trust); idempotent `$transaction`; audit tails-only; Phase-2G isolation; UI gates |
| `tests/signup-2-phase-2b-enforcement-wiring.test.ts` | 19 | Posting-guard + email-adapter wiring; legacy-grandfather semantics; the gate is read-only |
| `tests/signup-2-phase-2b-tos-pipeline.test.ts` | 14 | Path resolution; SHA-256 shape; fail-closed flag semantics ("1" ONLY); dev-fixture rejection |
| `tests/signup-2-phase-2b-capability-coverage.test.ts` | 29 | Every classification-A/B file calls a posting-guard assertion; Seam 1 + 2 wired; classification-D symbols do NOT exist; platform adapter is not tier-gated |
| **Total** | **92** | — |

Server-side identity + idempotency (asserted by contract tests):

- Microsoft `oid` + `tid` are read ONLY from `SignupRegistration.*`
  — explicit `.not.toMatch(/form\.get\("adminMicrosoftOid"/)`
  guards against the client-trust regression.
- `clubLegalName` comes from `reg.legalName`, not the form.
- `termsVersionSha256` + `termsVersionLabel` are computed /
  resolved server-side from the ToS helper.
- `attestationTextHash` is computed from the server-exported
  `ATTESTATION_TEXT` constant, not the form.
- Idempotent replay via `findUnique({ where: { signupRegistrationId:
  reg.id } })`; a second submission with the same registration
  returns the receipt without a second write.
- Audit emission `signup.authority.accepted` carries ONLY tails
  (`registrationIdTail`, `termsVersionSha256Tail`,
  `acceptedByMicrosoftOidTail`, `attestationTextHashTail`) — no raw
  oid, no full hashes.

## 7. Existing-tenant compatibility

Three tiers of evidence:

1. **Code** — The access-tier gate in
   `src/lib/billing/access-tier.ts` short-circuits on three legacy
   paths: no `ClubSubscription` row; `accessTier IS NULL`; and
   `accessTier` set to the operational-FULL value.
   Contract test
   `tests/signup-2-phase-2b-enforcement-wiring.test.ts` asserts all
   three branches literally.
2. **Database** — Zero `ClubSubscription` rows on staging have a
   non-null `accessTier` today (per Phase 2A acceptance
   `sha-c3e337e`).  Every existing tenant falls into the legacy
   grandfather branch.
3. **Regression** — The posting-guard-adjacent test suites
   (`phase14.test.ts`, `auth2/http-boundary.test.ts`,
   `coa-map-2-contract.test.ts`,
   `hr/financial-systems/payroll-profile-activate-uses-posting-guard.test.ts`)
   remain 64/64 green.

## 8. Regression counts

| Suite | Pass | Total |
|---|---|---|
| SIGNUP-1 contract + Phase 2A primitives | 275 | 275 |
| SIGNUP-2 Phase 2B contract (new) | 92 | 92 |
| Posting-guard regression | 64 | 64 |
| **Combined** | **431** | **431** |

Typecheck: clean (`tsc --noEmit` exit 0).

Placeholder scan: no Phase 2B surface flagged (`npm run
scan:placeholders` output does not include any
`src/app/api/signup/authority/`, `src/app/signup/t/[token]/authority/`,
`src/lib/billing/terms-of-service.ts`,
`src/lib/billing/access-tier.ts`, `src/lib/posting-guard/index.ts`,
or `src/lib/integrations/email.ts` paths).

## 9. Zero payment mutations confirmation

Explicit contract-test assertions in
`signup-2-phase-2b-attestation-contract.test.ts`:

- `.not.toMatch(/clubSubscription\.create\(/)` on the attestation API.
- `.not.toMatch(/clubSubscription\.upsert\(/)` on the attestation API.
- `.not.toMatch(/accessTier\s*:/)` on the attestation API — no tier
  writes anywhere in the acceptance route.
- `.not.toMatch(/\bstripe\./)` on the attestation API.
- `.not.toMatch(/sendWelcomeEmail\(/)` + `.not.toMatch(/prisma\.user\.create/)`
  + `.not.toMatch(/prisma\.club\.create/)` — no provisioning side
  effects.

The access-tier gate itself is read-only.  Contract test
`.not.toMatch(/clubSubscription\.update|upsert|create|delete/)` on
`access-tier.ts` enforces the invariant.

## 10. Staging-only fixtures

Script `scripts/signup-2-phase-2b-staging-fixture.mjs`:

- `create` seeds one `SignupRegistration` row with a canned
  Microsoft identity (`00000000-2b2b-2b2b-2b2b-000000000000` oid)
  in `step = READY_FOR_AUTHORITY_ATTESTATION`.
- `destroy` deletes by the deterministic oid; idempotent; prints
  `{destroyed:N}`.
- The token prefix `sig2b-fixture-` is observable in logs so the
  fixture is self-identifying.
- No persistent public debug endpoint; the fixture only exists
  while the Playwright run holds it, then is torn down.

Playwright acceptance:
`tests/e2e/signup-2-phase-2b-authority-acceptance.staging.spec.ts`
runs six scenarios (A–F) exercising fail-closed banner, hidden
status-page CTA, API-level fail-closed POST, bogus-token refusal,
zero-attestation-row invariant, and deterministic teardown.

## 11. Remaining blockers

**None blocking acceptance.**

Deferred (by design, outside Phase 2B scope):

- Live-mode activation requires:
  - Flipping `SPECTRE_SIGNUP_2B_ATTESTATION_LIVE=1` on staging.
  - A founder-APPROVED `docs/legal/terms-of-service-v1.md` with
    `Status: APPROVED` and a non-`ToS-dev-fixture` label.
- Both are intentionally NOT performed in Phase 2B per founder
  §2.1 ("Development fixtures only.  Do not publish placeholder
  legal terms.") and §5 ("Do not change production configuration.").

Deferred to later phases (unchanged from authorization):

- Phase 2C — subscription provisioning / Stripe mandate collection.
- Phase 2E — Payments Canada ACSS Debit.
- Phase 2G — Club shell creation on first attestation (backfills
  `clubId` into the attestation row).
- Phase 2G — Microsoft 365 delegated mailbox write gate (Seam 3).
- Phase 2H — operator surfaces (manual-invoice confirmation,
  subscription suspend / cancel).

## 12. Acceptance recommendation

**Recommended for founder acceptance.**

Phase 2B delivers:
- A fail-closed attestation surface (zero live-signatory risk).
- Three narrow enforcement seams, all legacy-grandfathered.
- 92 new source-contract assertions, 431 combined passing.
- Deterministic staging fixtures + a Playwright acceptance that
  proves the fail-closed path end-to-end.
- No production config / data mutations.
- No existing-tenant access change.

The next slice (Phase 2C) remains unauthorized per founder §8.
