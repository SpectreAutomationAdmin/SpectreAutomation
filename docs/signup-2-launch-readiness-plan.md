# SIGNUP-2 — Consolidated Launch-Readiness Plan

**Audience.** Founder (non-technical).  Readable without source
code.  This document consolidates every blocker between
today's accepted mock-backed staging baseline and the first
paying club.

**Status.** PLANNING ONLY, pending founder authorisation of the
individual slices.  No implementation under this document.

**Supersedes.**  The two §13 "launch blocker" tables in
`docs/signup-2-phase-2g-acceptance.md` and
`docs/signup-2-phase-2h-acceptance.md`.  All items from both
tables are consolidated here.

**Depends on.**
- Phase 2A–2H accepted baselines (mock-backed, staging-only).
- Phase 2E Stripe follow-up tracker
  (`docs/signup-2-phase-2e-stripe-followup.md`).
- Posting-guard race investigation
  (`docs/signup-2-posting-guard-race-investigation.md`).

**Preserves the approved commercial model.**  CAD $38,000
annually, ACSS PAD primary payment method.  No change proposed
to pricing or payment mechanism.

---

## 1. One-line summary

Twelve blockers remain between today's mock-backed staging
baseline and the first paying club.  Six are engineering
work; three require founder action (legal / commercial /
procurement); three are polish that can safely wait.  **The
critical path is five slices** (M1–M5 below), estimated at the
low end of mid-complexity.

---

## 2. Blocker inventory + per-blocker summary

Each row has: current status, why it matters, blocks-first-club,
dependencies, acceptance criteria, founder action, safe to
defer.

### B-01. Phase 2G steps 4-7 real importers

| Field | Value |
|---|---|
| Current status | 501-refuse in production path.  Mock path stamps anchors. |
| Why it matters | A real tenant cannot reach Tier 2 until mandatory configuration (COA, opening balance, branding, invitations) is really committed, not stubbed. |
| Blocks first paying club | **YES.** |
| Dependencies | None technical; each importer already exists in Spectre for existing-tenant admin use.  Phase 2G simply needs to wire the Phase 2G state machine to the existing importer paths. |
| Acceptance criteria | Each step writes real rows (CoaAccount, OpeningBalance ledger, S3 branding asset, UserInvitation sends).  Playwright scenario proves a mock-backed tenant reaches COMPLETED with REAL rows (idempotent on replay). |
| Founder action | **No.** |
| Safe to defer | No — on the critical path. |

### B-02. Phase 2G step 8 real welcome-email delivery

| Field | Value |
|---|---|
| Current status | Stub; stamps `welcomeEmailProviderMessageId` with a placeholder.  No `sendMail` call fires. |
| Why it matters | The founding admin cannot sign in on their first club without the invitation email. |
| Blocks first paying club | **YES.** |
| Dependencies | SIGNUP-1G Microsoft Graph `sendMail` adapter (already exists). |
| Acceptance criteria | Phase 2G step 8 calls the SIGNUP-1G adapter; the real message id is stamped; the acceptance Playwright verifies the message id matches a Graph `sendMail` response. |
| Founder action | **No.** |
| Safe to defer | No — on the critical path. |

### B-03. Live Stripe ACSS PAD integration (test mode first)

| Field | Value |
|---|---|
| Current status | Mock StripeAdapter only (Phase 2E).  No live credentials.  Phase 2E Stripe follow-up tracker lists items 1.1–1.8. |
| Why it matters | Phase 2E's authorisation gate (G1-G9) requires real Stripe evidence (balance transaction, charge, mandate).  The founder's commercial model is CAD $38,000 annually via ACSS PAD; without a live adapter, the first club cannot be charged. |
| Blocks first paying club | **YES.** |
| Dependencies | Stripe merchant account activation + live credentials (founder action, item 1.1); Stripe test mode credentials for a dry run (item 1.2); production webhook signing secret (item 1.5); legal review of the ACSS PAD mandate language (item 1.8). |
| Acceptance criteria | Phase 2E's live adapter path produces `evidenceSource = "live-stripe"` on a real test-mode payment intent; Phase 2F's gate accepts it; Phase 2G provisions a real tenant end-to-end on staging. |
| Founder action | **YES.** Items 1.1 (merchant account), 1.5 (signing secret), 1.8 (legal review) require founder sign-off / procurement. |
| Safe to defer | No — on the critical path. |

### B-04. Real legally-reviewed Terms of Service v1 document

| Field | Value |
|---|---|
| Current status | Only the dev-fixture ToS is committed (`docs/legal/terms-of-service-fixture-dev.md`).  The staging-only acceptance fixture (`docs/legal/terms-of-service-v1.md`) is removed at every teardown. |
| Why it matters | Phase 2F's G7 gate refuses in production without an APPROVED ToS v1.  Phase 2B's attestation surface records the signatory accepting a document; that document must exist and be legally defensible. |
| Blocks first paying club | **YES.** |
| Dependencies | Legal review (founder action). |
| Acceptance criteria | `docs/legal/terms-of-service-v1.md` committed with `Status: APPROVED` + a signed legal-review attestation; Phase 2F G7 passes on a live tenant; the ToS SHA is stable across clubs. |
| Founder action | **YES.** Primary blocker on the founder side. |
| Safe to defer | No — on the critical path. |

### B-05. ACSS PAD mandate text (legal) + Phase 2E signatory flow polish

| Field | Value |
|---|---|
| Current status | Phase 2E's mandate text + signatory flow is mock-backed; the actual mandate language is a placeholder. |
| Why it matters | Canadian ACSS PAD requires specific mandate language (Payments Canada Rule H1).  Signatory consent is enforceable only against the exact text they signed. |
| Blocks first paying club | **YES.** |
| Dependencies | Legal review of the mandate text (same lawyer as B-04 can combine); Phase 2E mandate-service wiring (small code change to swap the placeholder text for the reviewed version). |
| Acceptance criteria | A reviewed mandate text is committed; Phase 2E mandate flow records the exact SHA; Playwright verifies the recorded SHA matches the committed file. |
| Founder action | **YES.** |
| Safe to defer | No — on the critical path. |

### B-06. Phase 2E webhook adapter wiring to Phase 2H suspension

| Field | Value |
|---|---|
| Current status | Phase 2E's reversal webhook writes `BillingCycle.reversedAt` + `subscriptionStatus=REVERSED`.  It does NOT automatically call Phase 2H's `suspendTenant()`. |
| Why it matters | A real reversal would leave an ACTIVE / FULL tenant able to post operational writes until an operator manually flipped it to UNDER_REVIEW.  Phase 2H's trigger set (PAD_RETURN / PAYMENT_REVERSAL / REFUND / DISPUTE / FAILED_RENEWAL) exists; the webhook dispatcher just needs to call it. |
| Blocks first paying club | **YES.** |
| Dependencies | Phase 2H (already accepted); Phase 2E webhook dispatcher (already shipped). |
| Acceptance criteria | A simulated reversal webhook in staging flips the tenant to UNDER_REVIEW within one dispatcher tick; posting-guard refuses the next GL write without operator intervention. |
| Founder action | **No.** |
| Safe to defer | No — on the critical path.  Without this, Phase 2H is only usable by manual operator intervention. |

### B-07. Posting-guard / Phase 2H row-lock serialisation (race fix)

| Field | Value |
|---|---|
| Current status | Documented in `docs/signup-2-posting-guard-race-investigation.md`.  Phase 2H's own transaction protects the suspension flip; the race is on the posting-guard read side under read-committed isolation. |
| Why it matters | Without the row-lock, a GL write in flight at the moment of suspension can commit AFTER the suspension lands.  Bounded by request duration; worst case is a bulk importer taking seconds. |
| Blocks first paying club | **YES.** |
| Dependencies | Posting-guard refactor to accept a `{tx}` parameter + wrap every operational-write route's `assertPostingAllowed` call inside the write's own transaction (~ 20-30 routes). |
| Acceptance criteria | Dedicated integration test fuzzes concurrent write+suspend; no post-suspension commit lands.  Playwright scenario M proves the race-free property under load. |
| Founder action | **No.** |
| Safe to defer | No — financial integrity blocker. |

### B-08. Phase 2I legacy-tenant adoption workflow

| Field | Value |
|---|---|
| Current status | Phase 2H refuses to suspend tenants with `subscriptionStatus = null`.  Legacy tenants (every pre-SIGNUP-2 Club) are grandfathered. |
| Why it matters | **For the FIRST paying club this does NOT block** — the first paying club is a NEW signup, which will enter the pipeline with a non-null subscriptionStatus from Phase 2A.  Blocks only existing-tenant migration into the new lifecycle. |
| Blocks first paying club | **NO.** |
| Dependencies | Phase 2H's state machine + a dedicated adoption script that writes initial `subscriptionStatus=ACTIVE` + `accessTier=FULL` + `signupRegistrationId=null` for a legacy tenant. |
| Acceptance criteria | Adoption script runs idempotently; adopted tenants work identically under the new lifecycle; a prior refusal of suspension on the legacy tenant now succeeds post-adoption. |
| Founder action | **No** — but requires explicit per-tenant founder approval before adopting any existing tenant. |
| Safe to defer | **Yes.** |

### B-09. User reuse by Microsoft identity (schema slice)

| Field | Value |
|---|---|
| Current status | Phase 2G baseline hard-refuses on email collision.  A user signing up for a second club gets refused + alerts the operator. |
| Why it matters | The first paying club is a single tenant with a single admin; **does not block the first paying club**.  Second club becomes relevant once Spectre has multiple paying clubs AND a human admin signs up for both. |
| Blocks first paying club | **NO.** |
| Dependencies | Schema extension: `User.microsoftOid + User.microsoftTenantId` + unique index; Phase 2G `stepUserCreated` policy change to reuse by Microsoft identity. |
| Acceptance criteria | A second signup with the same Microsoft identity reuses the existing User id; a second signup with the same EMAIL but different oid still refuses (never link by email alone). |
| Founder action | **No.** |
| Safe to defer | **Yes.** |

### B-10. Automatic Fly-worker cron for Phase 2G provisioning-tick

| Field | Value |
|---|---|
| Current status | Phase 2G ships operator-tick only (D6 decision).  No scheduled worker calls the tick endpoint. |
| Why it matters | A real applicant who completes Phase 2A-2F in the middle of the night does not get provisioned until an operator manually ticks.  **For the first paying club this is operator-acceptable** — the first signup will be hand-held.  For scale, the cron is needed. |
| Blocks first paying club | **NO.** |
| Dependencies | Fly worker image already runs under `spectre-staging-worker`.  Add a scheduled task that calls `tickProvisioningJob()` for each eligible `TenantProvisioningJob(state=CREATED, nextAttemptAt<=now)`. |
| Acceptance criteria | Scheduled tick advances a mock-backed job through all 9 steps without operator action; interrupts cleanly on reversal. |
| Founder action | **No.** |
| Safe to defer | **Yes.** |

### B-11. Rich operator-remediation UX

| Field | Value |
|---|---|
| Current status | Phase 2H ships functional minima: timeline GET + suspend POST + reinstate POST + three RBAC permissions.  No dedicated UI pages. |
| Why it matters | The operator can drive remediation via the API or via a thin page, but a polished UX (operator inbox, bulk resolution, investigation workbench) is not shipped. |
| Blocks first paying club | **NO.** |
| Dependencies | Design + implementation of three operator-admin pages. |
| Acceptance criteria | Functional pages for inbox view, tenant lifecycle timeline, suspend/reinstate dialogs; keyboard-navigable; audit-reviewer-ready. |
| Founder action | **No** (but may want to review the design pass once drafted). |
| Safe to defer | **Yes.** |

### B-12. Placeholder-scan allowlist cleanup

| Field | Value |
|---|---|
| Current status | ~ 39 pre-existing placeholder hits in `prisma/schema.prisma` and `prisma/seed.ts`.  Not introduced by Phase 2A-2H.  DRH-1 does not block on the scan. |
| Why it matters | Policy hygiene; not functional. |
| Blocks first paying club | **NO.** |
| Dependencies | None. |
| Acceptance criteria | `npm run scan:placeholders` exits 0. |
| Founder action | **No.** |
| Safe to defer | **Yes.** |

---

## 3. Phase 2E Stripe follow-up items (incorporated)

The Phase 2E Stripe follow-up tracker enumerates 1.1–1.8.  All
are captured in B-03 above except where they already converged
with blockers B-04 / B-05.  Mapping:

| Phase 2E item | Where it lives in this plan |
|---|---|
| 1.1 Merchant account activation | B-03 (founder action) |
| 1.2 Test-mode credentials | B-03 |
| 1.3 Live customer / mandate / subscription creation | B-03 |
| 1.4 Webhook endpoint signing secret | B-03 (founder action) |
| 1.5 Live balance-transaction fetch | B-03 |
| 1.6 Real ACSS PAD mandate text | B-05 (founder action — legal) |
| 1.7 Reconciliation + Phase 2H suspension wiring | B-06 |
| 1.8 Legal review of mandate + ToS | B-04 + B-05 (founder action) |

---

## 4. Release milestones (practical, not phases)

Rather than creating more numbered phases, the work organises
into **five milestones + one acceptance milestone**.

### M1 — Suspension lifecycle production-ready

**Scope.**  B-06 (webhook→suspension wiring) + B-07 (posting-
guard row-lock race fix).

**Why this first.**  Phase 2H is accepted; the race + the
webhook wiring are the two gaps between "accepted" and "I'd
let a real tenant depend on it."  Both are small, mechanical,
and testable.

**Blocks first paying club?** Yes.

**Founder action required?** No.

**Estimated complexity.** Low-to-medium (mostly posting-guard
refactor + webhook adapter — ~ 300-500 lines; 20-30 route
migrations).

### M2 — Live Stripe ACSS PAD test-mode integration + reconciliation

**Scope.**  B-03 + the technical half of B-05 (mandate-text SHA
plumbing once legal supplies text).

**Why second.**  Without a real Stripe adapter + webhook
reconciliation, Phase 2E produces mock evidence that Phase 2F
rejects in production.  No real tenant can be authorised.

**Blocks first paying club?** Yes.

**Founder action required?** Yes — items 1.1 (merchant), 1.4
(signing secret) BEFORE this milestone can finish; item 1.8
(legal review of mandate text) feeds M2 + M3.

**Estimated complexity.** Medium.  The adapter port is already
mocked; swapping the mock for a live client is well-scoped.
Reconciliation worker + webhook signature verification + idempotent
replay are 3-5 well-understood modules.

### M3 — Real mandatory tenant provisioning

**Scope.**  B-01 (steps 4-7 real importers) + B-02 (step 8 real
`sendMail`).

**Why third.**  Only reachable once M2 produces real
authorisation evidence.  The real importers already exist for
existing-tenant admin use; wiring them into Phase 2G's step
handlers replaces the stubs.

**Blocks first paying club?** Yes.

**Founder action required?** No.

**Estimated complexity.** Medium.  Each importer is a known
quantity; the surface is small (~ 200-400 lines per step
handler, with existing tests for the underlying importers).

### M4 — Legal + commercial authorisation

**Scope.**  B-04 (ToS v1 legal review + commit) + the
founder-side half of B-05 (ACSS mandate language).

**Why fourth.**  Legal review runs in parallel with M1-M3
engineering.  Must complete BEFORE M6 (production launch) but
does not block earlier milestones' development.

**Blocks first paying club?** Yes.

**Founder action required?** Yes — this IS the founder-action
milestone.

**Estimated complexity.** Zero engineering; external legal
counsel + commercial sign-off.

### M5 — Operational onboarding + first-club runbook

**Scope.**  Operator runbook for M1-M3 workflows (suspend /
reinstate / retry / resolve), first-club dry run with a
staging-only synthetic club end-to-end through live-test-mode
Stripe + real importers + real `sendMail`, and the operator
UX functional minima (B-11's thin pages, not polish).

**Blocks first paying club?** Yes (the runbook); no (the UX
polish).

**Founder action required?** Review the runbook.

**Estimated complexity.** Low engineering (thin admin pages +
docs); must gate on M1-M4 complete.

### M6 — Production launch acceptance

**Scope.**  Production secrets + first-club controlled
acceptance window + DRH-1 production variant + on-call rota
decision + the first paying club actually onboards.

**Blocks first paying club?** This IS the first-paying-club
milestone.

**Founder action required?** Yes — final go/no-go.

**Estimated complexity.** Low engineering; high operational
weight (first-production-deploy procedures, support rota,
observability).

### Items safely deferred (not on the critical path)

- B-08 Legacy-tenant adoption workflow (post-launch; required
  only when migrating existing tenants).
- B-09 User reuse by Microsoft identity (post-launch; required
  when a human signs up for a 2nd club).
- B-10 Fly-worker cron for Phase 2G tick (first-club window
  can be hand-held).
- B-11 Operator-UX polish (functional minima + the thin pages
  from M5 are sufficient; polish is a design slice).
- B-12 Placeholder-scan allowlist cleanup (hygiene).

---

## 5. Critical path summary

```
M1 (suspension race fix + webhook wiring)
   |
   v
M2 (live Stripe test-mode + reconciliation)
   |
   +-- M4 (legal review runs in parallel, needed by M6)
   |
   v
M3 (real importers + welcome email)
   |
   v
M5 (operator runbook + first-club dry run)
   |
   v
M6 (production launch + first paying club)
```

- M4 (legal) runs IN PARALLEL with M1-M3 and converges at M5/M6.
- M1 + M3 are engineering-only; M2 is engineering + founder.
- Deferrable items can land after M6 without blocking the first
  paying club.

---

## 6. Testing strategy across milestones

Each milestone follows the Phase 2A-2H pattern:

1. Contract tests (≥ 20 assertions per milestone).
2. Full SIGNUP-2 regression (prior milestones unchanged).
3. Deployed staging Playwright acceptance under a controlled
   flag window.
4. DRH-1 deployment + post-deploy image-tag reliability gate.
5. Flag OFF after acceptance.
6. `docs/signup-2-milestone-<N>-acceptance.md` evidence doc.

M6 adds:
- Production deploy via a dedicated DRH-1 variant.
- A pre-flight live-tenant acceptance checklist run against
  the first paying club's staging-synthetic twin.
- On-call rotation + incident runbook.
- Prod secrets rotation + verification.

---

## 7. Non-authorisations preserved (reaffirmed)

Under this plan NO WORK:

- Activates real tenants.
- Initiates real payments.
- Enables live Stripe integration.
- Modifies existing-tenant access.
- Deploys to production.
- Activates unapproved legal terms.
- Collects government identification.
- Begins Phase 2I or later numbered phases (deferred items are
  milestones, not phases).

---

## 8. Open founder decisions in this plan

| # | Decision | Options | Recommended default | Blocks M1? |
|---|---|---|---|---|
| LD1 | Order of M1 vs M2 | (a) M1 first (recommended).  (b) M2 first. | **(a).** M1 is quicker + unblocks a cleaner-looking Phase 2H in staging. | — |
| LD2 | Fix the admin-config write gap under SUSPENDED_READ_ONLY in M1? | (a) Yes (blocks STAGED-tier admin writes too).  (b) Defer. | **(a).** Minor scope add; prevents a suspended tenant from editing their own club identity. | — |
| LD3 | Enforce the posting-guard row-lock via SELECT FOR UPDATE | (a) Yes (recommended).  (b) Keep the race documented + rely on bounded request times. | **(a).** | No |
| LD4 | M2 scope: test-mode first, or jump straight to live-mode once credentials exist | (a) Test-mode first (recommended).  (b) Straight to live. | **(a).** | No |
| LD5 | M5 operator pages scope | (a) Three functional pages (timeline / inbox / detail).  (b) Full UX design slice. | **(a).** Polish deferred to a design slice. | No |
| LD6 | M6 first-club identity | (a) A synthetic founder-owned test club.  (b) A real external paying club. | **(a).** Founder-controlled first-club minimises third-party coordination. | No |

**No decision blocks starting M1.**

---

## 9. What signing this plan authorises

Replying **"Launch-readiness plan APPROVED; proceed with M1"**
(or specifying a different first milestone) authorises Claude
to implement M1 to this specification, following the
Phase 2A-2H pattern (schema if applicable, service, routes,
posting-guard update, contract tests, Playwright staging
acceptance, DRH-1 deploy, flag OFF, acceptance doc).

**Signing this plan does NOT authorise:**
- M2-M6 implementation.
- Production deploy.
- Live Stripe activation.
- Legal terms activation.
- Modifying existing tenants.
- Any item marked "founder action required".

---

## 10. Document scope

**IS:**
- A consolidated inventory of the 12 Phase 2A-2H launch blockers.
- A mapping to practical release milestones.
- A critical-path summary.
- An authorisation request for M1.

**IS NOT:**
- Authorisation to implement any milestone.
- A commitment to a specific calendar date.
- A code change.
- A production deployment.

**Awaiting founder authorisation of M1 per §9.**
