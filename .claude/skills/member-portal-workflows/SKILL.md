---
name: member-portal-workflows
description: Rules for any page or service touched by `/app/member/*`.
---

# Member portal workflows

## When to use
Any change under `src/app/app/member/**`, `src/lib/portal/**`,
`src/lib/member-invites/**`, or any service that accepts a Principal
with `memberId` set.

## Steps
1. Reject cross-member access: every route resolves the member from the
   principal's `memberId`. Never trust a `memberId` from the URL or form
   without re-asserting it against the principal.
2. Member-portal permissions all start with `self:` (e.g.
   `self:account:read`, `self:payment_methods:write`,
   `self:statements:read`, `self:disputes:open`). Use those, not the
   staff equivalents.
3. Any action that touches money (open dispute, set primary payment
   method) audits with `action: "portal.<thing>.<verb>"`.
4. Read-only views must call `recomputeAccount` on read if the member's
   `lastRecomputedAt` is stale (more than ~5 minutes).
5. Polished tone — this surface is for paying members. No tech jargon
   in error messages. No raw enum names in the UI.
6. Forms collect payment data via the tokenized flow only — never store
   PAN/account numbers; the `processorToken` column is the only storage.

## Completion criteria
- A second member's data cannot be reached even by pasting an id into
  the URL. Test it.
- The page handles "no statements yet", "no payment methods", and
  "credit balance" cases.
- Every action button confirms before doing anything destructive.

## Red flags
- Reading a member by URL id without re-checking `principal.memberId`.
- Permissions that don't begin with `self:`.
- Raw error messages like "ConflictError: ..." leaking to members.
- Hardcoded demo names / placeholder content.
- Any reference to `processorToken` outside a service function.

## Discoverability
- A new member route is not done until it appears in the member sidebar
  (`MEMBER_NAV` in `src/components/Sidebar.tsx`) or is linked from the
  Member Hub. Members never see admin links; admin permission gating
  exists only on the admin side of the same Sidebar component.
- Run `npm run nav:audit` before declaring done.
