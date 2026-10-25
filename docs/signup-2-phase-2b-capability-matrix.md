# SIGNUP-2 Phase 2B -- Capability Enforcement Coverage Matrix

**Mandated by founder §3.**  Audit of every Phase 2A capability
BEFORE implementing the posting-guard change.  Classifies each
capability into one of five enforcement outcomes.

**Operational posture in Phase 2B:**  Zero `ClubSubscription`
rows on staging have a non-null `accessTier`.  Phase 2B's gate
grandfathers the entire existing tenant base (`null -> PASS`).
Phase 2G is the earliest point at which `accessTier = STAGED` is
assigned to a new tenant; Phase 2B therefore wires the gate
PROSPECTIVELY.

**Classification key:**

| Code | Meaning |
|---|---|
| `A` | Code path exists today AND currently passes through posting-guard.  Covered by the Phase 2B wire-in. |
| `B` | Code path exists today AND currently passes through `assertSensitiveActionAllowed`.  Covered by the Phase 2B wire-in (both guards gain the tier check). |
| `C` | Code path exists today but does NOT pass through posting-guard.  Needs a narrow Phase 2B gate at the service boundary. |
| `D` | No code path exists today; the feature has not been built.  No Phase 2B enforcement needed; add gate when the feature lands. |
| `E` | Platform-level (not Club-scoped).  Access-tier check does not apply. |

---

## FULL-tier capabilities

| Capability | Classification | Entry file(s) | Phase 2B enforcement point |
|---|---|---|---|
| `gl.journal.post` | A | [src/lib/accounting/journal.ts](../src/lib/accounting/journal.ts) | posting-guard seam |
| `ap.invoice.post` | A | [src/lib/ap/invoices.ts](../src/lib/ap/invoices.ts) | posting-guard seam |
| `ap.payment.post` | A | [src/lib/ap/payments.ts](../src/lib/ap/payments.ts) | posting-guard seam |
| `ar.invoice.post` | A | AR surfaces route through journal post | posting-guard seam |
| `member.billing.post` | A | AR surfaces route through journal post | posting-guard seam |
| `member.statement.publish` | A | AR surfaces route through journal post | posting-guard seam |
| `payroll.batch.run` | A | [src/lib/payroll/approve-and-post.ts](../src/lib/payroll/approve-and-post.ts) | posting-guard seam |
| `payroll.statement.publish` | A | [src/lib/payroll/approved-time.ts](../src/lib/payroll/approved-time.ts) | posting-guard seam |
| `club.coa.commit` | A | [src/lib/imports/index.ts](../src/lib/imports/index.ts), [src/lib/opening-balance/index.ts](../src/lib/opening-balance/index.ts) | posting-guard seam |
| `club.opening-balance.commit` | A | [src/lib/opening-balance/index.ts](../src/lib/opening-balance/index.ts) | posting-guard seam |
| `hr.sensitive-identity.edit` | A + B | [src/lib/hr/sensitive-identity.ts](../src/lib/hr/sensitive-identity.ts) | posting-guard seam (both) |
| `hr.compensation.edit` | A | [src/lib/hr/compensation.ts](../src/lib/hr/compensation.ts) | posting-guard seam |
| `hr.employment-assignment.change` | A | [src/lib/hr/employment-assignments.ts](../src/lib/hr/employment-assignments.ts) | posting-guard seam |
| `hr.bank-account.edit` | B | [src/lib/hr/bank-account.ts](../src/lib/hr/bank-account.ts) | sensitive-action seam |
| `hr.tax-profile.edit` | B | [src/lib/hr/tax-profile.ts](../src/lib/hr/tax-profile.ts) | sensitive-action seam |
| `hr.employee.create` | B | [src/lib/hr/employees.ts](../src/lib/hr/employees.ts) | sensitive-action seam |
| `hr.employment-period.edit` | B | [src/lib/hr/employment-periods.ts](../src/lib/hr/employment-periods.ts) | sensitive-action seam |
| `hr.onboarding-session.release` | B | [src/lib/hr/onboarding-sessions.ts](../src/lib/hr/onboarding-sessions.ts) | sensitive-action seam |
| `hr.credentials.edit` | B | [src/lib/hr/credentials.ts](../src/lib/hr/credentials.ts) | sensitive-action seam |
| `hr.documents.edit` | B | [src/lib/hr/documents.ts](../src/lib/hr/documents.ts) | sensitive-action seam |
| `payroll.implementation-declaration` | B | [src/lib/payroll/implementation-declaration.ts](../src/lib/payroll/implementation-declaration.ts) | sensitive-action seam |
| `club-domains.edit` | B | [src/lib/club-domains/index.ts](../src/lib/club-domains/index.ts) | sensitive-action seam |
| `permissions.edit` | B | [src/lib/permissions.ts](../src/lib/permissions.ts) | sensitive-action seam |
| `club.mailbox.send` | C | [src/lib/integrations/email.ts](../src/lib/integrations/email.ts) `selectEmailAdapter(clubId)` | Narrow gate at `selectEmailAdapter` entry |
| `club.mailbox.integration.write` | C | Microsoft Graph delegated writes in [src/lib/integrations/email-via-mailbox-connection.ts](../src/lib/integrations/email-via-mailbox-connection.ts) and the mailbox-integration callbacks | Narrow gate at mailbox-integration write boundary |
| `club.user-invites.deliver` | C | [src/lib/hr/invitations.ts](../src/lib/hr/invitations.ts) + [src/lib/hr/invitation-email.ts](../src/lib/hr/invitation-email.ts) -- the HR invitation path uses `assertSensitiveActionAllowed` but the actual send goes through `selectEmailAdapter` | Covered twice: sensitive-action seam (invitation create) + `selectEmailAdapter` gate (delivery) |
| `club.branding.upload` | B | [src/lib/club/media.ts](../src/lib/club/media.ts) uses posting-guard | posting-guard seam |
| `announcements.create` | A | [src/lib/announcements.ts](../src/lib/announcements.ts) | posting-guard seam |
| `inventory.adjust` | A | [src/lib/ops/inventory.ts](../src/lib/ops/inventory.ts) | posting-guard seam |
| `hospitality.*` (reservations, surveys, dining) | not-yet-mapped | [src/lib/hospitality/*](../src/lib/hospitality/) -- some use posting-guard, some don't | Case-by-case; most hospitality tables are not FULL-tier (menu / tables / covers are member-facing config, not money); flagged for Phase-2G review |
| `pos.chit.send` | not-yet-mapped | [src/lib/pos/*](../src/lib/pos/) | Case-by-case; POS receipts flow through `selectEmailAdapter` so the C-tier gate covers them |
| `api.token.issue` | **D** | Grep returned ZERO matches for `generateApiToken` / `createApiToken` / `issueToken`.  Spectre has no user-issued API-token surface today. | No Phase 2B enforcement needed.  Add gate when feature lands. |
| `member.portal.publish` | **D** | Grep returned only the capability-key reference in `access-tier.ts`.  No portal-publish code path exists. | No Phase 2B enforcement needed.  Add gate when feature lands. |
| `integration.webhook.enable` | **D** | Spectre has webhooks on the receiving side (Stripe, Microsoft Graph).  No user-visible "enable webhook" feature. | No Phase 2B enforcement needed.  Add gate when feature lands. |
| `operator.manual-invoice.confirm` | **D** | No manual-invoice path exists; Phase 2A's state machine documents it but Phase 2G/2H implements it. | No Phase 2B enforcement needed.  Operator-only when added. |
| `operator.subscription.suspend` | **D** | No operator surface yet; Phase 2H. | No Phase 2B enforcement needed. |
| `operator.subscription.cancel` | **D** | Phase 2H. | No Phase 2B enforcement needed. |

**Platform-level excluded (classification E):**

| Capability | Why E |
|---|---|
| `signup.resume_email.send` | Routes through `selectPlatformEmailAdapter()` -- Spectre's own transactional-mail identity, not Club-scoped.  No tenant to check. |
| `signup.recovery_link.consume` | Public endpoint; no Club context yet. |
| `admin.user-management` (SpectreAdmin) | Platform-level; not scoped to a specific Club's tier. |

---

## STAGED-tier capabilities (Phase 2B scope note)

Per the Phase 2B plan, STAGED-tier capabilities (Club identity
edit, department config, dry-run COA, branding upload, portal
copy edit, user-invite queue) are **NOT enforced in Phase 2B**.

Rationale:
- Phase 2B does not create any `ClubSubscription` row with
  `accessTier = STAGED`.  The attestation surface records only
  `SubscriptionAuthorisationAttestation` + `SignupRegistration.
  step = AUTHORITY_ACCEPTED`; the Club shell is deferred to
  Phase 2G.
- STAGED-tier capabilities therefore have no realistic subject
  in Phase 2B.  Enforcement wires in Phase 2G when the Club
  shell is created with `accessTier = STAGED` from day one.
- STAGED-tier capability routes continue to use their existing
  RBAC `requirePermission` + tenant-isolation checks in
  Phase 2B.

---

## Phase 2B enforcement wire-in -- three seams

Based on the matrix above, Phase 2B wires FULL-tier enforcement
at exactly three seams.  Legacy grandfather applies at every
seam.

### Seam 1 -- `src/lib/posting-guard/index.ts`

- `assertPostingAllowed(principal, clubId, action, ...)` calls
  `await assertAccessTierForPosting(clubId)`.
- `assertSensitiveActionAllowed(principal, clubId, action, ...)`
  calls `await assertAccessTierForPosting(clubId)`.
- Covers classifications A + B (40+ callers).

### Seam 2 -- `src/lib/integrations/email.ts` `selectEmailAdapter`

- Early in `selectEmailAdapter(args)`, call
  `await assertAccessTierForClubEmail(args.clubId)`.
- Covers `club.mailbox.send` + `club.user-invites.deliver`
  (classification C paths that bypass posting-guard).

### Seam 3 -- Microsoft 365 delegated mailbox write

- Narrow Phase 2B scope: Spectre's existing Microsoft 365
  delegated writes (restoring/deleting Outlook messages from
  Work Intake) are gated by posting-guard already in the HR
  training + employee-portal paths.  Pure mailbox-mutation
  writes (WI-SYNC-1g restore mutations) do NOT currently go
  through posting-guard, but they're triggered BY user actions
  on existing Work Intake UI which goes through RBAC.
- Phase 2B does NOT add a dedicated gate here because the only
  path to trigger a WI-SYNC mutation requires a Club admin
  session for a Club with an active mailbox integration -- and
  Phase 2B does not create any new tenants with mailbox
  integrations.
- Flagged for Phase 2G review.

---

## Shared helper `assertAccessTierForPosting(clubId)`

Single implementation in `src/lib/billing/access-tier.ts`:

```ts
export async function assertAccessTierForPosting(clubId: string): Promise<void> {
  const sub = await prisma.clubSubscription.findUnique({
    where: { clubId },
    select: { accessTier: true, subscriptionStatus: true },
  });
  if (!sub) return;                               // legacy grandfather
  const tier = readAccessTier(sub.accessTier);
  if (tier === null) return;                      // legacy grandfather
  if (tier === "FULL") return;                    // normal operational
  if (sub.subscriptionStatus === "MANUAL_INVOICE") return;  // operator-elected
  throw new ForbiddenError(
    `SIGNUP-2 access-tier: posting-tier action rejected for Club ${clubId} (tier=${tier}, status=${sub.subscriptionStatus})`,
  );
}
```

Three PASS conditions:
1. No `ClubSubscription` row for the Club (legacy).
2. `accessTier IS NULL` or an unknown string (legacy).
3. `accessTier = "FULL"` OR `subscriptionStatus = "MANUAL_INVOICE"`.

One FAIL condition: everything else (`STAGED`, `SUSPENDED_READ_ONLY`,
or any future value we haven't whitelisted).

Shared helper `assertAccessTierForClubEmail(clubId)` has the
same semantics; separate name so each seam is grep-visible.

---

## Verification

Phase 2B's contract tests include a capability-coverage test
that:

1. Enumerates every classification-A/B file above.
2. Asserts each file imports `assertPostingAllowed` or
   `assertSensitiveActionAllowed`.
3. Asserts `src/lib/posting-guard/index.ts` calls
   `assertAccessTierForPosting`.
4. Asserts `src/lib/integrations/email.ts selectEmailAdapter`
   calls `assertAccessTierForClubEmail`.
5. Asserts the entry files listed in classifications D + E
   contain no new import of the Phase 2B tier helpers (so a
   future change can't quietly broaden Phase 2B).

The test prints the full matrix on run so future reviewers can
diff coverage over time.
