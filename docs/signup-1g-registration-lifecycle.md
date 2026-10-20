# Registration Lifecycle — Specification

**Scope.** Clarifies the SIGNUP-1 registration lifecycle after the
SIGNUP-1G adjustment.  Spells out the two independent expiry
clocks, what happens at each boundary, and the recovery options
available to an applicant at every stage.

**Design intent.** A legitimate applicant must be able to recover
or restart an incomplete registration without unexpected loss of
important information.  "Important information" = anything the
applicant invested effort to provide (Club identity + verified
Microsoft identity + role).  Once that information is captured,
Spectre must not quietly discard it on a timer.

---

## Two independent expiry clocks

Spectre's signup flow carries two expiry concepts that must stay
separate.  They are two different fields on two different tables,
measured in different units, with different purposes.

### Clock A — Recovery-link TTL (30 minutes)

- **Field.** `SignupRecoveryLink.expiresAt`.
- **Set when.** A recovery link is issued — either automatically
  after the Microsoft callback, or on demand from `/signup/resume`.
- **Default.** `issuedAt + 30 minutes` (env-overridable via
  `SIGNUP_RECOVERY_LINK_TTL_MS`).
- **At expiry.** The row stays in the DB (as an audit record)
  but `consumeRecoveryLink` rejects it with `status: "EXPIRED"`.
  The applicant lands on `/signup/resume?error=expired` and can
  immediately request a fresh link.
- **Purpose.** Bound the time a leaked email link can be used.
  Short so the leaked window is narrow; cheap to re-issue so the
  short window imposes no real friction on legitimate recovery.
- **Scope.** One link per issuance.  Issuing a new link
  auto-revokes any still-active prior links with
  `revokeReason: "SUPERSEDED"`.

### Clock B — Registration record TTL (7 days, DRAFT only)

- **Field.** `SignupRegistration.expiresAt`.
- **Set when.** The registration row is created (Screen 1 submit).
- **Default.** `createdAt + 7 days` (env-overridable via
  `SIGNUP_REGISTRATION_TTL_MS`).
- **At expiry — DRAFT.** The row's `status` moves from `DRAFT` to
  `ABANDONED` on the next sweeper tick.  The row is NOT deleted;
  its identity data (legalName, address, website) remains for
  duplicate-detection and audit.  Resuming via the original token
  returns `null` from the resolver — the applicant must start a
  new registration.
- **At expiry — VERIFIED / ESCALATED.** Nothing happens.  The
  `expiresAt` timestamp becomes meaningless once Microsoft identity
  is captured.  The row remains accessible via the browser-session
  cookie, via `/signup/resume` with the verified email, or via
  SpectreAdmin tooling until SIGNUP-2 either activates the tenant
  or operator-rejects.
- **Purpose.** Garbage-collect genuinely-abandoned Screen 1 drafts
  so the dashboards + duplicate-detection counts stay accurate.
- **Scope.** One record per Club identity attempt.

The two clocks are **independent**.  A VERIFIED registration whose
7-day expiresAt has passed is still fully recoverable through the
30-minute recovery-link flow.  A DRAFT registration whose 7-day
window is still open is still subject to the 30-minute recovery-link
clock on each individual recovery email.

### Why "DRAFT-only" matters (the lifecycle bug fix in SIGNUP-1G)

Before SIGNUP-1G, the resolver filtered out ANY registration whose
`expiresAt` had passed, regardless of status.  Combined with the
sweeper (which only swept DRAFT), a VERIFIED registration whose
7-day window lapsed would still exist in the DB but would be
unresolvable by any token.  The identity data was effectively
quarantined.

That was a silent-loss defect against the founder's lifecycle
directive.  SIGNUP-1G ships the fix:
[src/lib/signup/registration.ts#resolveRegistrationByToken](../src/lib/signup/registration.ts#L166)
now gates the TTL check with `reg.status === "DRAFT"`.

Contract test
[tests/signup-1-contract.test.ts](../tests/signup-1-contract.test.ts)
locks the fix:

```ts
expect(R).toMatch(/if \(reg\.status === "DRAFT" && reg\.expiresAt\.getTime\(\) < Date\.now\(\)\) return null/);
expect(R).not.toMatch(/^\s*if \(reg\.expiresAt\.getTime\(\) < Date\.now\(\)\) return null;\s*$/m);
```

---

## Status transitions — complete map

```
                        createRegistration (Screen 1 submit)
                        ───────────────────────────────────▶
                           +resumeTokenHash
                           +expiresAt = now + 7 days
                           status = DRAFT
                           step   = IDENTITY
                                        │
                                        │ user clicks "Sign in with Microsoft"
                                        ▼
                           step = ADMIN_PENDING  (status still DRAFT)
                                        │
                                        │ Microsoft OIDC callback succeeds
                                        │ identity + oid + tid persisted
                                        │ SignupRecoveryLink issued + email sent
                                        ▼
                           status = VERIFIED
                           step   = ADMIN_VERIFIED
                           +completedAt
                                        │
                                        │  (static — no auto-transition from here)
                                        │
                                        ▼
                            [awaits SIGNUP-2 operator action]
                            = activate / escalate / reject
```

Three sweeper interactions:

- **DRAFT, expired.**  `sweeper.ts tickSignupSweep` moves it to
  `ABANDONED` after 7 days of inactivity.  Row preserved for
  duplicate-detection.
- **Pending SignupOAuthTransaction, expired.**  Sweeper marks the
  transaction `outcome = "EXPIRED"` and `consumedAt = now`.
  Prevents stale OAuth state leaking replay opportunities.
- **VERIFIED / ESCALATED.**  Sweeper does **not** touch these.

---

## What the applicant sees at each state

| State | Status | What `/signup/t/<token>/status` shows | Recovery options |
|---|---|---|---|
| Mid-Screen-1 (no row yet) | — | — | Start over at `/signup`. |
| DRAFT, inside 7 days | `DRAFT` | Screen 2 if they came in via cookie, Screen 3 skeleton otherwise. | Resume cookie OR start a new registration (prior row stays as a dup-signal). |
| DRAFT, after 7 days (ABANDONED) | `ABANDONED` | 404 (resolver returns `null`). | Start a new registration — the applicant re-enters the Screen 1 data; the ABANDONED row is retained for Spectre's dup-signal scan. |
| VERIFIED, cookie present | `VERIFIED` | Full status card: Club identity + Microsoft-verified admin + ownership-verification state. | Direct URL via cookie, OR `/signup/resume` → fresh 30-min recovery link. |
| VERIFIED, cookie lost | `VERIFIED` | — (cookie-based path fails). | **`/signup/resume`** — enter the Microsoft-verified email, receive a fresh single-use 30-min recovery link.  Click lands on the status page with a fresh browser-session cookie. |
| VERIFIED, >7 days old | `VERIFIED` | Full status card — **unchanged** (SIGNUP-1G fix). | Same as above. |
| ESCALATED (SpectreAdmin flagged) | `ESCALATED` | Status card with the applicant-friendly ownership-verification copy. | Spectre reaches out directly; otherwise same recovery options as VERIFIED. |

---

## Where to look in the code

- Clock A (recovery link) — [src/lib/signup/recovery-link.ts](../src/lib/signup/recovery-link.ts).  Default TTL `30 * 60 * 1000`.
- Clock B (registration) — [src/lib/signup/registration.ts](../src/lib/signup/registration.ts).  Default TTL `7 * 24 * 60 * 60 * 1000`.
- Sweeper — [src/lib/signup/sweeper.ts](../src/lib/signup/sweeper.ts).  Default interval 15 min.
- Resolver — [src/lib/signup/registration.ts#L147](../src/lib/signup/registration.ts#L147).  DRAFT-only expiry gate ships in SIGNUP-1G.
- Fresh-link endpoint — [src/app/api/signup/resume/request/route.ts](../src/app/api/signup/resume/request/route.ts).  Enumeration-safe.
- Consume endpoint — [src/app/signup/r/[token]/route.ts](../src/app/signup/r/[token]/route.ts).

---

## Operator overrides

Both TTLs are env-overridable (unit: milliseconds):

- `SIGNUP_RECOVERY_LINK_TTL_MS` — recovery-link TTL (default 1 800 000 = 30 min).
- `SIGNUP_REGISTRATION_TTL_MS` — Screen-1 DRAFT TTL (default 604 800 000 = 7 days).
- `SIGNUP_SWEEP_INTERVAL_MS` — sweeper interval (default 900 000 = 15 min).

These should not be adjusted without a deliberate reason recorded
in the Spectre changelog.  Shortening the recovery-link TTL below
10 minutes risks timing-out legitimate users; lengthening the
registration TTL past 30 days clutters the dup-signal corpus with
real abandonments.

---

## What this document does NOT cover

- The SIGNUP-2 lifecycle (activation / rejection / renewal) — see
  [docs/signup-2-payment-architecture.md](signup-2-payment-architecture.md).
- The SignupRecoveryLink revocation model — see the
  recovery-link service doc comment in
  [src/lib/signup/recovery-link.ts](../src/lib/signup/recovery-link.ts).
- Commercial-authority verification — see
  [docs/signup-2-commercial-authority-verification.md](signup-2-commercial-authority-verification.md).
