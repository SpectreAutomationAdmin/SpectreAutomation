# SIGNUP-2 Phase 2C — Implementation Authorisation Package (DRAFT)

**Status.** PLANNING ONLY, pending founder authorisation.  No application
code; no Prisma migration; no Stripe entity; no production configuration;
no tenant provisioning; no live attestation; no activation of Phase 2D.

**Supersedes.** None (Phase 2C first draft).
**Depends on.**
- SIGNUP-2 Architecture Decision Document v3 (`sha-07db40b`).
- SIGNUP-2 Phase 2A — accepted baseline `sha-c3e337e` / Fly v870.
- SIGNUP-2 Phase 2B — accepted baseline `sha-9c717e1` / Fly v875.
- SIGNUP-1G Recovery Repair — accepted baseline `sha-9c717e1` / Fly v875.
- Commercial-authority verification requirements v2
  ([docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md)).

**Confirmed on filing this document:**
- No production state has changed.
- No new Stripe entity exists.
- No DB migration has been applied.
- No existing-tenant `accessTier` has been written.
- The Phase 2B attestation workflow remains dormant
  (`SPECTRE_SIGNUP_2B_ATTESTATION_LIVE` unset; ToS is dev fixture).

---

## 1. Exact scope and exclusions

### 1a In-scope for Phase 2C

Phase 2C ships the **entity-standing + delegated-authority corroboration
layer** that sits between Phase 2B's signatory attestation and Phase
2E's payment collection.  Concretely:

1. **Jurisdiction-registry adapter interface.**  A provider-independent
   `EntityRegistryAdapter` service port in `src/lib/signup/entity-registry/`
   with per-jurisdiction adapters:
   - `CA-ON` (Ontario Business Registry) — modern REST API.
   - `CA-BC` (BC Registries) — modern REST API.
   - Stub adapters for `CA-AB`, `CA-QC`, `CA-SK`, `CA-MB`, `CA-NS`,
     `CA-NB`, `CA-NL`, `CA-PE` that return
     `MANUAL_REVIEW_REQUIRED` outcomes without any outbound HTTP
     call (so a Club in a gap jurisdiction routes to the
     operator-review path).  Live adapter implementation for the
     gap jurisdictions is deferred to the Phase 2C-Follow-On or
     Phase 2D as the operator population demands.
2. **`EntityStandingCheck` writer.**  Fetches the registry record at
   authorisation time, redacts the raw payload (PII minimisation per
   Section 4), persists one `EntityStandingCheck` row keyed by
   `SignupRegistration.id`, and classifies the outcome.
3. **Delegated-authority corroborator.**  Reads the Phase 2B
   `SubscriptionAuthorisationAttestation` row, the SIGNUP-1
   automated-ownership-classifier result, and the
   `EntityStandingCheck` outcome.  Produces a single verdict:
   `PASS_AUTOMATED` / `HOLD_FOR_REVIEW` / `REJECT`.
4. **Registration state transition.**  Extends the `SignupRegistration.step`
   state machine with two new terminal-for-2C states:
   - `AUTHORISED` — baseline evidence set + green classifier +
     attestation + entity ACTIVE + authority corroboration passed.
     This is the input to Phase 2E (mandate collection).
   - `HOLD_FOR_REVIEW` — any upstream signal demands human
     judgement.  Phase 2H ships the operator review surface; Phase
     2C persists the row that surface will read.
5. **Applicant-facing state surface.**  Extends the existing
   `/signup/t/[token]/status` page with (a) a verification-state
   affordance that reports "verification in progress / under review /
   complete" without disclosing the specific signal classification,
   and (b) a muted hint on `/signup/t/[token]/authority/complete`
   indicating next steps.  No new routes.
6. **Attestation integration gate.**  The Phase 2B attestation POST
   route gains a Phase 2C precondition: `EntityStandingCheck` for the
   registration must be `fetchedAt > NOW - 24h` AND standing must be
   `ACTIVE | MANUAL_REVIEW_REQUIRED`.  Dissolved / inactive entities
   cannot persist an attestation.  This gate is additive to the
   existing Phase 2B feature-flag + ToS gates; it does NOT weaken
   them.
7. **Audit coverage.**  Every registry fetch, every classification
   outcome, every registration-step transition emits an `audit()`
   call with action strings `signup.entity-standing.fetched`,
   `signup.entity-standing.classified`, `signup.registration.hold`,
   `signup.registration.authorised`.
8. **Contract tests + Playwright acceptance.**  Target >= 60 passing
   source-contract assertions across four new vitest files; one
   staging Playwright spec exercising the end-to-end routing with
   a fixture adapter.  Live-flag OFF unless founder authorises
   adapter live-mode.

### 1b Out-of-scope for Phase 2C (deferred by phase)

| Area | Deferred to | Why |
|---|---|---|
| Operator review surface + queue UI | Phase 2H | Phase 2C persists the review inbox entry; operator UI is the Phase 2H focus. |
| Mandate collection + Stripe setup intents | Phase 2E | Phase 2C's `AUTHORISED` state is the trigger for 2E, not its implementation. |
| Tenant provisioning (Club shell creation) | Phase 2G | `AUTHORISED` → Phase 2E → `BillingCycle.SETTLED` → activation gate → Phase 2G provisioning.  2C does not provision anything. |
| Welcome emails + invitation delivery | Phase 2G | Same chain; 2C has no new tenant to welcome. |
| Daily reconciliation worker | Phase 2I | Independent lifecycle. |
| Elevated-risk gov-ID path | Phase 2H + separately-authorised 2C.1 | Spec'd in commercial-authority-verification v2; implementation path requires founder re-authorisation if operational data demand it. |
| Any `ClubSubscription` write | Phase 2G | No Club shell exists in 2C. |
| Live mode for the attestation workflow | Separate founder decision | Phase 2B's live-mode preconditions (flag + APPROVED ToS) remain unchanged; Phase 2C does not alter them. |

### 1c What Phase 2C does NOT change

- Phase 2A schema remains frozen except for ONE additive migration
  (Section 4), which is an index + an optional `verificationStatus`
  column on `SignupRegistration` — no column rename, no breaking
  change.
- Phase 2B's attestation API continues to require the feature flag
  and the APPROVED ToS to persist a row.
- SIGNUP-1G recovery-link mechanics (landing page + POST consume,
  30-min TTL, atomic single-use) are untouched.
- The access-tier capability matrix (Phase 2B) is untouched.  Its
  grandfather semantics for legacy tenants remain the primary
  defence against regression on existing Clubs.
- Government-ID collection remains OUT.  Phase 2C does not add a
  gov-ID surface.

---

## 2. Proposed user journey and UI states

### 2a The applicant's view

Phase 2C sits silently between Phase 2B's attestation acceptance and
Phase 2E's mandate collection.  The applicant does not see a new
page; they see a new **state** on the existing status page.

1. SIGNUP-1 finishes identity verification → applicant lands on
   `/signup/t/[token]/status` with the "What happens next" copy.
2. [Phase 2B live-mode] applicant clicks the CTA, lands on
   `/signup/t/[token]/authority`, attests → lands on
   `/signup/t/[token]/authority/complete`.
3. **[NEW IN PHASE 2C]** background: adapter fires one registry
   fetch, writes `EntityStandingCheck`, corroborator writes the
   verdict.  The `complete` page displays one of three states:
   - **"Verification complete; next step prepared."** —
     authorised path.  Phase 2E will proceed when its own
     authorisation lands.
   - **"Under review by Spectre."** — hold path.  No signal
     specifics disclosed to the applicant.  A time estimate
     ("typically 1 business day") is offered.
   - **"Verification could not be completed."** — a dissolved /
     inactive entity, impersonation signal, or hard reject.
     Applicant is directed to contact `hello@spectreautomation.com`.
     The specific reason stays server-side; the applicant sees a
     neutral refusal.
4. If the applicant revisits `/signup/t/[token]/status`, the same
   state is reflected in the status card: a new "Verification"
   row shows `In progress`, `Under review`, `Verified`, or
   `Requires contact` with corresponding `data-testid`s.

### 2b Operator's view (deferred to Phase 2H)

Phase 2C writes an `OperatorInboxEntry` for every HOLD outcome.
The entry carries: registration id tail, legal name, jurisdiction,
standing code, classifier decision, and the attestation id tail.
Phase 2H renders the inbox; Phase 2C only writes the row.

### 2c SpectreAdmin's view

Phase 2C adds a **read-only** diagnostic surface at
`/app/admin/signup-ops/registration/[id]` (or equivalent) that
displays the three records (classifier, attestation, standing-check)
for a single registration.  Scope: internal operator read access
behind the existing `platform:signups:read` permission.  No write
affordances in Phase 2C.

---

## 3. Verification architecture and authoritative data sources

### 3a The verification pipeline

```
SIGNUP-1 → ClassifierDecision (ownershipVerificationState)
                 │
Phase 2B → SubscriptionAuthorisationAttestation
                 │
Phase 2C → EntityStandingCheck + AuthorityCorroborationVerdict
                 │
                 ↓
       SignupRegistration.step ∈ { AUTHORISED | HOLD_FOR_REVIEW | REJECTED }
                 │
Phase 2E → mandate collection (gated on AUTHORISED)
```

### 3b Authoritative registry sources per jurisdiction

| Jurisdiction | Source | Access | Status columns we read |
|---|---|---|---|
| CA-ON | Ontario Business Registry (REST) | Public REST, API key — Phase 2C obtains a non-production key before adapter runs live | legal name match; standing (`Active` / `Inactive`); corporation key / business number; registered address |
| CA-BC | BC Registries API (REST) | Public REST, API key — same procurement step | same column set; also directors list for soft-signal use |
| CA-AB | Alberta Corporate Registry | SOAP, paid tier — stub returns MANUAL_REVIEW_REQUIRED in Phase 2C baseline | — |
| CA-QC | REQ public search | Scrape-only; stub returns MANUAL_REVIEW_REQUIRED | — |
| CA-SK/MB/NS/NB/NL/PE | Smaller registries | Mix of HTML + paid APIs; stubs return MANUAL_REVIEW_REQUIRED | — |
| CA-* (fallback) | None | Any registration without a jurisdiction match routes to MANUAL_REVIEW | — |

The stub adapters are **not placeholders**: they are an explicit,
auditable product decision that gap-jurisdiction applicants wait on
a human reviewer by design.  No fabricated "ACTIVE" verdicts.

### 3c Classifier decoupling

Phase 2C MUST NOT mutate the ownership classifier.  The classifier is
owned by SIGNUP-1 and remains the preliminary identity signal.  Phase
2C READS its decision and ROUTES on it.  If the classifier shows
`NEEDS_MANUAL_REVIEW` or `ESCALATED`, Phase 2C writes a HOLD regardless
of what the registry says — the two signals are AND'd for `PASS`,
OR'd for `HOLD`.

### 3d Officer-match semantics

Per the commercial-authority verification v2 doc: signatory-vs-officer
match is a **soft signal**, never a gate.  If BC Registries returns
a directors list, the corroborator checks whether the attestation's
signatory full name appears.  Soft match outcomes:
- `MATCHED` → +1 confidence (recorded, not required).
- `PARTIAL` → recorded, no routing change.
- `NOT_MATCHED` → recorded, no routing change — a Controller may
  legitimately not appear on the directors list.
- Not provided by registry → `null`, no routing change.

### 3e Risk-based routing matrix

| classifier | standing | officerMatch | → verdict |
|---|---|---|---|
| AUTOMATED_PASSED | ACTIVE | any | **PASS_AUTOMATED** |
| AUTOMATED_PASSED | MANUAL_REVIEW_REQUIRED (gap jurisdiction) | any | **HOLD_FOR_REVIEW** |
| AUTOMATED_PASSED | NOT_ACTIVE / NOT_FOUND | any | **REJECT** (entity cannot authorise) |
| NEEDS_MANUAL_REVIEW | ACTIVE | any | **HOLD_FOR_REVIEW** |
| NEEDS_MANUAL_REVIEW | NOT_ACTIVE / NOT_FOUND | any | **REJECT** |
| ESCALATED | any | any | **HOLD_FOR_REVIEW** (SpectreAdmin direct contact) |
| OVERRIDDEN | ACTIVE | any | **PASS_AUTOMATED** (with override reason recorded) |

Impersonation / abuse-signal records on the Microsoft `oid` short-
circuit the matrix to `REJECT` regardless of other signals.

---

## 4. Database changes, if required

Phase 2C's working principle is **reuse Phase 2A schema where
sufficient** (same rule applied to Phase 2B).  Concretely:

### 4a Phase 2A columns Phase 2C writes to (no migration needed)

- `EntityStandingCheck.jurisdiction` (`CA-ON`, …).
- `EntityStandingCheck.businessNumber`.
- `EntityStandingCheck.standing` (`ACTIVE | NOT_ACTIVE | NOT_FOUND |
  MANUAL_REVIEW_REQUIRED`).
- `EntityStandingCheck.officerMatch`.
- `EntityStandingCheck.registryPayloadJson` — **redacted** per
  Section 9d.
- `EntityStandingCheck.fetchedAt`.

### 4b Additive Phase 2C migration (ONE)

A single additive migration — no breaking changes — adding:
- `SignupRegistration.verificationVerdict` (nullable string:
  `PASS_AUTOMATED | HOLD_FOR_REVIEW | REJECT`).  Default null.
- `SignupRegistration.verificationDecidedAt` (nullable `DateTime`).
- `SignupRegistration.verificationDeciderUserId` (nullable string,
  for Phase 2H operator overrides; `null` when the corroborator
  wrote it automatically).

Index on `(verificationVerdict, verificationDecidedAt)` so the
Phase 2H operator inbox query is cheap.

The migration is applied twice (dual-schema SIGNUP-1F pattern): once
to `prisma/schema.prisma` and once to `prisma-postgres/schema.prisma`.

### 4c Prisma `step` string enum extension

`SignupRegistration.step` is a free-form string.  Phase 2C adds two
new permitted values (`AUTHORISED`, `HOLD_FOR_REVIEW`) at the TypeScript
union layer; no DB enum constraint change.  Existing step values
remain accepted.

### 4d What Phase 2C does NOT change

- No column rename.
- No breaking type change on any existing column.
- No removal of any existing column, index, or relation.
- No change to `ClubSubscription` (no new tenant exists in 2C).
- No change to `SubscriptionAuthorisationAttestation` (Phase 2B's
  table is read-only for 2C).

---

## 5. Service and API boundaries

### 5a New service modules (planned paths)

- `src/lib/signup/entity-registry/index.ts` — the
  `EntityRegistryAdapter` port + the `resolveAdapter(jurisdiction)`
  factory.
- `src/lib/signup/entity-registry/adapters/ca-on.ts` — Ontario
  adapter.
- `src/lib/signup/entity-registry/adapters/ca-bc.ts` — BC adapter.
- `src/lib/signup/entity-registry/adapters/stub-manual-review.ts` —
  shared stub for gap jurisdictions.
- `src/lib/signup/entity-registry/adapters/fixture.ts` — deterministic
  test-only adapter; used by Playwright in Phase 2C (never active
  outside staging).
- `src/lib/signup/entity-standing-service.ts` — the writer that
  calls `resolveAdapter(…).fetch(…)` and persists the
  `EntityStandingCheck` row.
- `src/lib/signup/authority-corroborator.ts` — pure function:
  `(classifier, attestation, standingCheck) → VerificationVerdict`.
- `src/lib/signup/registration-verification.ts` — thin orchestrator
  that chains standing fetch → corroborate → persist →
  `SignupRegistration` step transition in one `prisma.$transaction`.

### 5b New API routes (planned paths)

- `POST /api/signup/verification/kick` — internal trigger used by
  the Phase 2B `POST /api/signup/authority/accept` handler to
  fire the verification pipeline.  Rate-limited by registration
  id.  Returns 202 (asynchronous).  Phase 2C runs the pipeline
  synchronously initially; moving to a background worker is a
  Phase 2C-Follow-On if latency is a problem.
- `GET /api/admin/signup-ops/registration/[id]/verification` —
  read-only diagnostic endpoint for SpectreAdmin, gated by the
  existing `platform:signups:read` permission.

No new PUBLIC consume-style URLs.  No new email-delivered links.
No new webhooks.

### 5c Fixture-adapter boundary (critical safety)

The fixture adapter — selected only when `SPECTRE_SIGNUP_2C_ADAPTER_MODE
= "fixture"` — exists so Playwright can exercise all three verdict
branches deterministically.  Production + staging default to the
real adapters.  A contract test must assert the fixture adapter is
NEVER selected when the env var is unset or set to any value other
than `"fixture"`.

### 5d Backward compatibility

- Pre-Phase-2C registrations whose `verificationVerdict IS NULL` are
  treated as `HOLD_FOR_REVIEW` by downstream Phase 2E — meaning
  Phase 2E will not mandate-collect without an explicit verdict.
  This is intentional: the gate is additive, not retroactive.
- Legacy tenants (existing production Clubs) are unaffected — they
  have no `SignupRegistration` row.

---

## 6. Signatory-authority verification approach

Phase 2C's authority corroboration follows commercial-authority-verification
v2 verbatim.  The approach:

1. **Microsoft work-or-school identity is the PREREQUISITE** (Phase 1
   gate).  Personal MSA accounts are already rejected upstream.  Phase
   2C does not re-run this check; it reads `SignupRegistration.
   adminMicrosoftOid` and `adminMicrosoftTenantId` as proven inputs.
2. **Signatory attestation is the EXPLICIT consent** (Phase 2B).
   Phase 2C reads `SubscriptionAuthorisationAttestation` and
   validates that it exists for the registration before any
   corroboration runs.  If no attestation exists (because the Phase
   2B flow has not completed), Phase 2C does nothing.
3. **Delegated authority is the DEFAULT**, not an exception.
   Controllers, GMs, Head Pros, Treasurers, Finance VPs — all
   accepted.  The accepted-roles list is for operator guidance
   only; the corroborator does not reject on role-string mismatch.
4. **Entity standing is the HARD GATE.**  A dissolved / inactive
   entity cannot authorise regardless of signatory evidence.  This
   is the one `REJECT` branch that cannot be overridden by a
   soft-signal match elsewhere.
5. **Officer-match is a SOFT SIGNAL.**  Recorded for audit; never
   routing-affecting.  A Controller who legitimately is not on the
   corporate officer list still passes.
6. **Impersonation / abuse is ESCALATED.**  Pre-existing abuse
   signals on the Microsoft `oid` short-circuit the matrix to
   REJECT.  A Phase 2H operator surface will eventually ingest
   these signals; Phase 2C reads from the existing abuse-signal
   store (if present) or ignores if the store is empty.
7. **Government-ID is OUT.**  Phase 2C does not collect, store, or
   verify any government-issued identity document.  The one path
   that collects gov-ID in commercial-authority-verification v2 is
   deferred to Phase 2H (or a dedicated 2C.1 sub-slice) with its
   own founder authorisation.

---

## 7. Manual-review and exception workflow

### 7a HOLD_FOR_REVIEW routing

When the corroborator writes `verificationVerdict = HOLD_FOR_REVIEW`:
1. One `OperatorInboxEntry` is written with
   `severity = ROUTINE`, `category = PROVISIONING_FAILURE`
   (reused), and a Phase-2C-specific sub-category string
   `category_detail = "verification_hold"`.  Phase 2A's existing
   `OperatorInboxEntry` columns suffice; no schema change.
2. One `audit()` call is emitted with action
   `signup.registration.hold`, carrying registration-id tail +
   jurisdiction + classifier decision + standing code (no raw
   PII).
3. The applicant's `/signup/t/[token]/status` page renders the
   "Under review by Spectre" state via a new `data-testid`.

### 7b Operator release (Phase 2H ships the UI; 2C defines the hook)

The release path is defined but implemented in 2H:
- `POST /api/admin/signup-ops/registration/[id]/release` —
  SpectreAdmin-gated, rate-limited.  Writes
  `verificationVerdict = PASS_AUTOMATED`,
  `verificationDeciderUserId = operator`, emits
  `audit("signup.registration.operator_released", …)`.
- Operator refuses: `POST /api/admin/signup-ops/registration/[id]/reject`
  — writes `verificationVerdict = REJECT`,
  `SignupRegistration.status = ABANDONED`.
- Operator requests supporting artefact: not a Phase 2C-primary
  path; the artefact-upload surface is a 2H decision.

Phase 2C does NOT ship those two routes; they are listed here so
2C's schema + hooks are compatible with the 2H deliverable.

### 7c Verification-failure branches (REJECT)

- Entity `NOT_ACTIVE` or `NOT_FOUND` → immediate REJECT, no
  review path.  Applicant receives neutral "Verification could
  not be completed; please contact `hello@spectreautomation.com`"
  message.
- Impersonation / abuse signal → immediate REJECT.  SpectreAdmin
  notified via `OperatorInboxEntry.severity = IMMEDIATE`.

### 7d Incomplete-application branches

Phase 2C does not auto-expire a registration.  If a hold persists:
- SIGNUP-1G recovery-link expiry (30 min) still applies to the
  resume-token issuance side.
- A hold-for-review stays open indefinitely from the applicant's
  perspective; operator triage drives closure.  This is intentional
  per the founder's "humans close holds" posture.

### 7e Verification stale-after-24h (ambition, not blocker)

The attestation-integration gate (Section 1a.6) requires
`EntityStandingCheck.fetchedAt > NOW - 24h` to accept an attestation.
If the attestation is attempted beyond that window, the handler
transparently re-runs the standing fetch before accepting.  This
makes the standing check durable without requiring a background
re-fetch worker in Phase 2C.

---

## 8. Staged-access enforcement matrix

Phase 2A + 2B already implement the three-tier capability matrix and
the three enforcement seams (posting-guard + sensitive-action +
`selectEmailAdapter`).  Phase 2C does NOT add new seams.

Phase 2C's contribution to the matrix is:

| Registration state | Attestation present | Verification verdict | Access tier a future tenant would receive |
|---|---|---|---|
| `IDENTITY` / `ADMIN_VERIFIED` | No | n/a | n/a (no tenant exists) |
| `READY_FOR_AUTHORITY_ATTESTATION` | No | n/a | n/a |
| `AUTHORITY_ACCEPTED` | Yes | null (pre-2C) | n/a (2C not run yet) |
| `AUTHORITY_ACCEPTED` | Yes | HOLD_FOR_REVIEW | n/a — no tenant until released |
| `AUTHORITY_ACCEPTED` | Yes | REJECT | n/a — ABANDONED |
| **`AUTHORISED`** | Yes | PASS_AUTOMATED | Phase 2G provisions `accessTier = STAGED` (unchanged from v3 architecture Section 1a Tier 1) |

### 8a What this means for existing tenants

Existing tenants carry `accessTier = null` (legacy grandfather).
Phase 2C does not write to any existing `ClubSubscription`.  The
grandfather semantics in `assertAccessTierForPosting` continue to
return PASS for null.  Zero existing tenants lose access as a
result of Phase 2C.

### 8b Server-side authorisation requirements

Every new Phase 2C route (`verification/kick`, admin diagnostics)
goes through:
- `requireSession()` + principal resolution (existing SIGNUP-1
  machinery).
- `hasPermission(principal, clubId, …)` where applicable
  (`platform:signups:read` for the admin surface).
- Rate limiting via `checkAuthRateLimit` with a new bucket
  `signup_verification_kick`.
- Audit emission with tails only (no raw oid, no raw hash, no
  raw email).

### 8c Pending, failed, expired, rejected handling

- Pending → `verificationVerdict IS NULL`.  Phase 2E refuses to
  proceed.
- Failed (adapter error) → `verificationVerdict = HOLD_FOR_REVIEW`
  with a `operator_hint` field in the OperatorInboxEntry.  Retry
  logic is operator-driven in 2C; a background retry worker is a
  2C-Follow-On.
- Expired (stale standing check) → re-fetched on next attestation
  attempt per Section 7e.
- Rejected → `SignupRegistration.status = ABANDONED`; no further
  attestation attempts accepted (the existing Phase 2B gate
  already refuses ABANDONED).

### 8d Operator overrides + audit

Operator overrides are implemented in Phase 2H.  Phase 2C's schema
supports them (`verificationDeciderUserId`).  Every override will
record the operator user id, before/after verdict, and reason
string via `audit()`.  Phase 2C's contract tests pin the audit
emission shape.

### 8e Safe transition into Phase 2E

The sole trigger from Phase 2C into Phase 2E is:
`SignupRegistration.step == "AUTHORISED"
 AND SignupRegistration.verificationVerdict == "PASS_AUTOMATED"`.
Phase 2E ships separately with its own founder authorisation and
its own feature flag.

---

## 9. Security and privacy risk assessment

### 9a Threat model summary

| Threat | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Registry adapter returns false ACTIVE on dissolved entity | Low (public registries are authoritative) | Allows unauthorised authorisation | 24-hour standing check freshness; operator re-run on next attestation attempt; audit emission allows later retroactive invalidation |
| Signatory impersonation (stolen Microsoft creds) | Low | Allows attestation | Microsoft OIDC remains upstream gate; abuse-signal check short-circuits REJECT; attestation is immutable + SHA-256 locked for forensic review |
| Adapter credentials leaked | Low | Allows third-party registry queries at Spectre's cost | Credentials are Fly secrets (never in repo); scoped to read-only; rotated per standard cadence; staging vs prod key separation |
| HOLD_FOR_REVIEW inbox DoS (many fake registrations) | Low | Operator queue bloat | SIGNUP-1 rate limits (existing); plus Phase 2C ships rate limit on `/api/signup/verification/kick` |
| Classifier bypass via adapter-only route | Low | Would allow NEEDS_MANUAL_REVIEW to pass | Routing matrix (Section 3e) AND's classifier and standing — adapter alone cannot pass |
| Fixture adapter active in production | Low (contract-asserted) | Would allow deterministic PASS | Env-var gate contract-tested; staging-only acceptance test; separate secrets per env |
| Cross-tenant data leakage via admin diagnostic | Low | PII disclosure | Admin endpoint requires `platform:signups:read`; tenancy filter applied; no raw payload exposed to tenant surfaces |
| Registry payload PII retention beyond need | Medium (default behaviour of adapters) | Compliance risk | Per Section 9d, `registryPayloadJson` is REDACTED at write time — only standing + business number + officer-match flag survive; raw payload is discarded in memory |

### 9b Minimisation of personal information

Phase 2C stores:
- Entity-level fields (legal name, jurisdiction, business number,
  address, standing).
- The soft-signal classification outcome (`officerMatch`).
- No officer-list personal data; no director names persisted
  after the officer-match classification runs; no gov-ID; no
  address of individuals.

### 9c No gov-ID collection

Per founder non-authorisations, Phase 2C does not implement any
gov-ID path.  The commercial-authority-verification v2 doc defers
that one specific elevated-risk path to Phase 2H plus a separate
founder decision.

### 9d Registry-payload redaction

The adapter writes `EntityStandingCheck.registryPayloadJson` only
AFTER applying a per-jurisdiction redactor:
- Entity-level fields retained (legal name, business number,
  jurisdiction, address, standing code).
- Director / officer names: hashed (SHA-256) and recorded only as
  a flag (`officerMatch ∈ {MATCHED | PARTIAL | NOT_MATCHED |
  null}`).  Raw names never persisted.
- Any field marked PII in the registry's own schema is dropped
  before the write.
- The redaction function is pure + unit-tested with golden-file
  fixtures per jurisdiction.

### 9e Prevention of self-approval

Phase 2C's corroborator runs on the Phase 2B attestation POST
handler's server side.  The applicant has no path to invoke the
corroborator with their own inputs or to override its verdict.
The one operator-override path (Phase 2H) requires a different
Microsoft principal and a different permission scope.

### 9f Tenant-isolation enforcement

Phase 2C writes rows keyed by `signupRegistrationId` — not by
`clubId` (no club shell exists yet).  Tenant isolation for the
admin diagnostic endpoint is enforced by the existing
`platform:signups:read` permission check; no club-scoped tenancy
filter is applicable because the data is pre-tenancy.

### 9g Retention, correction, and deletion

- `EntityStandingCheck` rows: retained for the lifetime of the
  `SignupRegistration` plus 7 years from `AUTHORISED` (same
  retention as the Phase 2A attestation record, aligned with
  Payments Canada Rule H1 Section 23 — the subject of a Phase
  2A pre-flight verification).  Operator deletion is explicit and
  audited.
- Correction: Phase 2C does not expose corrective writes to the
  applicant.  An operator with `platform:signups:write` (added in
  Phase 2H) can refresh the standing check, which creates a new
  row and marks the prior one superseded via a dedicated column
  (`supersededAt`); no mutation.
- Deletion requests under PIPEDA / provincial equivalents are
  honoured through a Phase 2H operator-driven path.

---

## 10. Contract and Playwright test plan

### 10a Vitest source-contract tests (target: >= 60 assertions)

1. `tests/signup-2-phase-2c-entity-registry-contract.test.ts`
   (~20 assertions): adapter port shape; per-adapter contract
   (`fetch(…)` signature, return-type disc union); fixture adapter
   is only active with the env var; stub adapter never returns
   ACTIVE.
2. `tests/signup-2-phase-2c-corroborator.test.ts` (~15
   assertions): the routing matrix (Section 3e) tested with every
   row's inputs; pure-function property (no DB access); no
   officer-match hard gate; override reasons captured.
3. `tests/signup-2-phase-2c-verification-pipeline.test.ts` (~15
   assertions): the orchestrator wraps fetch + corroborate +
   persist in one `prisma.$transaction`; audit emissions; step
   transitions correct; attestation gate re-fetches when stale.
4. `tests/signup-2-phase-2c-redaction.test.ts` (~10 assertions):
   golden-file redaction tests for CA-ON and CA-BC payloads;
   director/officer names never present in `registryPayloadJson`;
   PII dropped per jurisdiction.

### 10b Playwright staging acceptance

- `tests/e2e/signup-2-phase-2c-verification-acceptance.staging.spec.ts`
  (one spec, four scenarios):
  - A. PASS_AUTOMATED: fixture adapter → ACTIVE → corroborator →
    AUTHORISED → applicant sees "Verification complete".
  - B. HOLD_FOR_REVIEW: fixture adapter → MANUAL_REVIEW_REQUIRED
    → corroborator → HOLD_FOR_REVIEW → applicant sees "Under
    review".  OperatorInboxEntry created.
  - C. REJECT: fixture adapter → NOT_ACTIVE → corroborator →
    REJECT → applicant sees "Could not be completed".
    `SignupRegistration.status = ABANDONED`.
  - D. Attestation gate: Phase 2B attestation POST refuses when
    standing is `NOT_ACTIVE` even if the Phase 2B feature flag
    is on and the ToS is APPROVED (we test with an approved
    staging ToS fixture).
- Uses the Phase 2B staging fixture harness (extended with a
  Phase 2C sub-command set) to seed fixtures deterministically.
- Runs under `staging-authenticated` project only (same guard
  pattern as Phase 2B).

### 10c Regression suites to keep green

- SIGNUP-1 contract (`tests/signup-1-contract.test.ts`).
- SIGNUP-1F recovery (`tests/signup-1f-recovery-link.test.ts`).
- SIGNUP-2 Phase 2A × 4 suites.
- SIGNUP-2 Phase 2B × 4 suites.
- Posting-guard adjacent (phase14, auth2 http-boundary,
  coa-map-2-contract, HR payroll-profile-activate).

### 10d Placeholder scan

`npm run scan:placeholders` must remain clean on new Phase 2C
surfaces.  All stub adapters document their stub status in a
comment allowed by the existing allowlist for `scaffold only` IF
the allowlist pattern applies; otherwise a Phase 2C-specific
allowlist entry is added with a one-line reason tying it to the
gap-jurisdiction product decision.

---

## 11. DRH-1 staging deployment procedure

Phase 2C follows the DRH-1 pattern established on Phase 2A and
Phase 2B:

1. Implementation on a working branch; PR into
   `staging-deploy/web1b1-framer-fidelity` (or a dedicated 2C
   branch if the founder prefers isolation).
2. Local gates: `npm run typecheck`; the four new Phase 2C contract
   suites; SIGNUP-1 + 1F + 2A + 2B regression; placeholder scan.
3. Commit with the standard attribution footer.
4. Push → GitHub Actions "Deploy — spectre-staging" fires.
5. Watch the DRH-1 run; wait for success (worker + web both on
   the new sha-tag; `/api/health` returns 200).
6. Capture the Fly release version and image sha in the acceptance
   evidence doc.
7. Run `tests/e2e/signup-2-phase-2c-verification-acceptance.staging.spec.ts`
   against the new release; capture the test-results screenshots
   + JSON evidence.
8. Scan staging logs for 60 seconds post-release; confirm zero
   errors / warnings on Phase 2C paths.

Rollback anchor: v875 (`sha-9c717e1c5fad`).

### 11a Live-mode toggles

Phase 2C ships with **both** adapter modes defaulting OFF:
- `SPECTRE_SIGNUP_2C_ADAPTER_MODE` — `fixture` (test only),
  `live` (real registry), or unset (= live).  Live is the
  prod/staging default once the registry API keys are configured
  as Fly secrets; the fixture mode is Playwright-only.
- `SPECTRE_SIGNUP_2C_VERIFICATION_LIVE` — gates the applicant-
  facing state-surface updates on the status page.  Default OFF
  (fail-closed, same posture as Phase 2B).  When OFF the
  verification machinery still runs server-side (the
  corroborator writes `verificationVerdict`); only the
  user-visible state surface stays hidden.

### 11b Non-authorisations preserved on this deploy

- No existing-tenant access change.
- No production configuration change.
- No new Stripe entity.
- No tenant provisioning.
- No Phase 2B live-mode activation (ToS still dev fixture).

---

## 12. Acceptance criteria and evidence requirements

Modeled on the Phase 2A + Phase 2B acceptance docs:

| Dimension | Criterion |
|---|---|
| Prisma migration | Applies cleanly on fresh DB; dual-schema parity; adds only the three new nullable columns + one index. |
| Typecheck | `npm run typecheck` clean. |
| Contract tests | Four new Phase 2C contract suites, >= 60 passing assertions in aggregate. |
| Playwright acceptance | `signup-2-phase-2c-verification-acceptance.staging.spec.ts` passes under `staging-authenticated` with all four scenarios green. |
| Regression | SIGNUP-1 + 1F + 2A + 2B + posting-guard-adjacent remain green (combined count will be published in the acceptance doc). |
| Audit coverage | Every new state transition is contract-tested for an `audit()` call with the correct action string and tails-only meta. |
| Placeholder scan | No new Phase 2C surface flagged. |
| Live-mode safety | Fixture-adapter env var contract-tested; live-mode toggle contract-tested. |
| Existing-tenant compatibility | Zero `ClubSubscription` writes; grandfather semantics unchanged. |
| Documentation | `docs/signup-2-phase-2c-acceptance.md` filled with evidence (test counts, migration id, image sha, Fly release). |
| Deployment | DRH-1 to staging; `/api/health` 200; log scan clean. |
| Non-authorisations preserved | No production state; no Stripe entity; SIGNUP-1G baseline untouched; Phase 2B live-mode preconditions unchanged. |

---

## 13. Dependencies on later SIGNUP-2 phases

| Later phase | Phase 2C provides | Phase 2C does NOT provide |
|---|---|---|
| Phase 2D (not named in v3; reserved) | — | — |
| Phase 2E (Mandate collection / Stripe setup intent) | The `AUTHORISED` state that gates mandate collection; the business-number record Stripe needs for its merchant-side KYC. | The Stripe entity itself; the SetupIntent; the mandate record (`SubscriptionPaymentMandate` writer). |
| Phase 2F (Settlement + activation gate) | — | — |
| Phase 2G (Tenant provisioning) | The `AUTHORISED` + settled signal; the signatory + attestation record Phase 2G reads to create the Club shell with `accessTier = STAGED`. | The `TenantProvisioningJob` runner (writer exists from 2A); the Club / User / UserClubRole writes themselves. |
| Phase 2H (Operator surface) | The `OperatorInboxEntry` rows; the admin diagnostic read endpoint; the schema that supports `verificationDeciderUserId` for overrides. | The operator inbox UI; the release / reject / artefact-request routes. |
| Phase 2I (Reconciliation worker) | — | — |

Phase 2C has NO dependency on any un-shipped phase.  It is runnable
immediately after Phase 2B, against staging only, with the
feature flags defaulting to safe modes.

---

## 14. Founder decisions required before implementation

The following decisions must land in writing before Phase 2C
implementation is authorised:

1. **Jurisdiction scope at launch.**  v3 names CA-ON and CA-BC as
   the two live adapters.  Confirm whether CA-AB (paid SOAP) or
   CA-QC (scrape) is live-adapter or stub at Phase 2C launch.
   Recommended: **both stub** — operators review via the Phase
   2H inbox until operator population demands a live adapter.
2. **Operator sub-category naming.**  Phase 2A's `OperatorInboxEntry`
   has a free-form `category_detail`-style field (via `title` +
   `body`); confirm whether Phase 2C uses the existing
   `PROVISIONING_FAILURE` category or adds a new `VERIFICATION_HOLD`
   category.  Recommended: **add `VERIFICATION_HOLD`** to the
   enum list so operator triage is a filterable column.  (This
   is a one-line enum extension; captured as an open question
   because it's user-facing to the operator inbox.)
3. **Classifier-override policy.**  Phase 2C treats classifier
   `OVERRIDDEN` as `AUTOMATED_PASSED` for authority routing.
   Confirm this is correct per founder's SIGNUP-1 classifier
   decisions.  Alternative is to always HOLD on any override.
4. **Standing-check freshness window.**  Phase 2C uses 24 hours.
   Confirm or specify a different window (12h and 72h are both
   defensible).
5. **Rate-limit bucket size on `/api/signup/verification/kick`.**
   Phase 2C's draft is 10 calls per registration per hour (same
   magnitude as Phase 2B's `signup_authority_accept`).  Confirm
   or specify.
6. **Live-mode activation decision.**  Phase 2C ships with
   `SPECTRE_SIGNUP_2C_VERIFICATION_LIVE` OFF.  Confirm this is the
   intended staging default and that live activation is a
   separate per-change founder authorisation.
7. **Government-ID path assignment.**  Confirm that the elevated
   gov-ID path from commercial-authority-verification v2 is
   deferred to Phase 2H (or a dedicated 2C.1 sub-slice) rather
   than Phase 2C.  Recommended: **defer to 2H** so Phase 2C does
   not introduce any gov-ID surface.
8. **Admin diagnostic surface permission.**  The read-only admin
   endpoint uses `platform:signups:read`.  Confirm this is the
   correct scope or specify a Phase-2C-dedicated scope.

Decisions 1 + 7 are the only ones that materially change Phase 2C's
code surface.  The others are configuration or copy decisions that
can be adjusted inside the plan without reopening the architecture.

---

## 15. What this document is + is not

**IS:**
- The Phase 2C planning document, awaiting founder authorisation.
- A reconciliation of the v3 architecture's Phase 2C scope with
  the founder's expected areas in the authorisation package.
- A specification complete enough that implementation is a direct
  translation.

**IS NOT:**
- Authorisation to implement.
- A code change.
- A deployment.
- A Stripe API call.
- A commitment to any specific registry vendor beyond stated
  provider-independent patterns.
- A change to the Phase 2A or Phase 2B accepted baselines.

**Awaiting founder authorisation of Phase 2C per Section 12.**
