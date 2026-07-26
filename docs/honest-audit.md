# Spectre — Honest Pre-Pilot Audit

Read this with the workflow audit (`docs/workflow-audit.md`) and the
remediation backlog (`docs/remediation-backlog.md`). This file ranks
findings by how badly they hurt a pilot demo.

## Top 20 broken / incomplete workflows

Each is something a real club operator would try and either fail or be
confused by.

1. **Member "Make a payment" CTA** is disabled with hover text reading
   "Payment integration placeholder". The single highest-visibility broken
   button in the member portal.
2. **No admin form to post a charge to a member.** Most common staff
   workflow has zero UI; service-only.
3. **No admin form to record a member payment.** Same gap as above.
4. **Tee sheet has no member booking page.** Admins generate sheets, no
   one can reserve.
5. **Settings page renders a hardcoded "Coming soon" grid** of 8 features
   that the user will read as "this product is half built". It is.
6. **POS is single-line only.** No multi-line cart, no terminal/session
   shell. Service supports it; UI doesn't.
7. **Notifications has no "send" action.** Inbox + templates render;
   nothing to push a notification with from the UI.
8. **Hardware adapters are stubs.** `/app/admin/devices` is reachable.
   No device can actually report.
9. **SSO SAML is scaffold-only.** Admins shown a SAML option but it can't
   complete a real exchange.
10. **No admin UI to configure SSO providers.** Even OIDC, which works,
    can only be configured via DB / API.
11. **Reporting packages section editor is incomplete.** Create + list
    works; the actual report composition is rough.
12. **Reporting package distribution channel is not wired.** Status
    flips but nothing leaves the system.
13. **Inventory has no UI for counts or transfers.** Service exists.
14. **MFA enrolment has no automated test.** Works manually; one regression
    away from breaking silently.
15. **Member welcome timeline isn't linked from anywhere** members
    actually go (member hub doesn't reference it).
16. **Collections notice send-to-member is unverified end-to-end.**
    Template renders; delivery to the affected member's portal hasn't
    been verified by a browser walk-through.
17. **Email bounce webhook has no provider signature check.** A
    malicious caller can mark any address suppressed.
18. **GCP KMS provider falls back to local.** AWS works; GCP advertises
    in the launch checklist but isn't really there.
19. **No automated end-to-end test for the full pilot flow** (apply →
    invite → activate → first charge → first payment). Each phase has
    tests but the seam between them is hand-verified only.
20. **The `/app/admin/queues` dashboard exists** but isn't tied to a
    real queue worker outside dev; production needs a real adapter.

## Top 20 placeholder risks

Things the placeholder scanner flagged or that I identified by walking
the code. None of these are dishonest from a code-comment perspective
(most are clearly tagged in source), but several leak into user-facing
surfaces.

1. `src/app/app/member/account/page.tsx:60` — disabled "Make a payment"
   button (P0-1).
2. `src/app/app/admin/settings/page.tsx:80-92` — "Coming soon" grid
   (P0-4).
3. `src/app/app/welcome/timeline/page.tsx:9` — TODO comment.
4. `src/lib/hardware/index.ts:4` — explicit stub-only adapters.
5. `src/lib/sso/index.ts:7` — explicit SAML scaffold-only.
6. `src/lib/opening-balance/index.ts:16` — "not implemented" comment
   for the unlock path (controller override after LOCK). Acceptable
   because the path doesn't exist yet — but worth a real
   `NotImplementedError` if a caller ever reaches for it.
7. `src/lib/security/auth-guard.ts:60` — "temporary" describes the
   lockout duration (false positive — the word is non-scaffolding).
8. `prisma/schema.prisma:494` — application-fee handling "placeholder"
   comment; the column exists but the processor adapter isn't.
9. `prisma/schema.prisma:550` — storageKey "placeholder" comment;
   actual storage abstraction exists, comment is misleading.
10. `prisma/schema.prisma:743` — payment `processorRef` "placeholder";
    same shape as #9 — comment outdated, behavior is real.
11. `prisma/schema.prisma:5584` — `invoiceJson` "placeholder — full
    invoice flow lives in Phase 11". Outdated comment; Phase 11 is done.
12. `prisma/seed.ts:818` — device `authTokenHash: "demo-token-hash-
    placeholder"`. Demo seed is the right place but the tag should
    visibly say "DEMO" in any UI that renders it.
13. `src/lib/imports/index.ts:405` — "we just upsert a stub Account
    row" — the COA import skips dimensions; real COA setup needs the
    categories/fsGroups/departments wiring.
14. `src/lib/integrations/exports.ts:310` — "minimal type stubs for
    the renderer libs". The render code is real; the typing is just
    minimal. Comment is misleading.
15. `src/lib/marketplace/index.ts` — in-process auth code map. Phase
    12F deliberately deferred a real OAuth flow; the doc-comment is
    clear, but the marketplace admin UI shows installs as if real.
16. `src/lib/billing/index.ts` — Stripe provider works; the Phase 11
    handler only acts on invoice-level events. Subscription-state
    edge cases (trial → past_due → unpaid) are unverified.
17. `src/lib/tournament/conflict.ts` — `MERGED` decision exists in the
    schema enum but the resolve function only implements server/client
    swap. Merged path defers to manual JSON entry.
18. `src/lib/push/vapid.ts` — VAPID keys are seeded as dev defaults;
    production launch check would warn. Worth a real WARN in the
    Settings → Notifications screen.
19. `src/lib/integrations/llm.ts` — Phase 7 LLM commentary adapter is
    structurally complete but defaults to a stub that returns
    deterministic strings. Not a placeholder per se, but presented in
    Settings as "AI Financial Commentary (adapter wired, model not
    enabled)".
20. The placeholder scanner allowlist is shipped but has not been
    reviewed by anyone other than me. Every rule in
    `config/placeholder-allowlist.json` should be questioned.

## Top 20 UI problems

1. The `/app/admin/settings` page is mostly hardcoded labels.
2. Many admin tables don't have an empty-state row.
3. Raw enum names render as user-facing text without `<Badge>`.
4. Money columns inconsistently use `.toFixed(2)` vs `formatCurrency()`.
5. Member-facing error messages occasionally include the underlying
   error name (`ConflictError: …`).
6. The pilot onboarding wizard step rows use a plain `<select>` to
   change status — there is no per-step "open form" call to action.
7. Member tournament score entry on mobile feels small; no sticky
   Save button.
8. Member billing page is dense; sections compete for attention.
9. Sidebar exposes routes the current user lacks permission to use,
   redirecting on click instead of hiding the link.
10. The "Devices" admin nav item is visible but the underlying
    feature is stubbed (P1-1).
11. The "Coming soon" labels in Settings (P0-4 / P1-5).
12. Admin notifications page has no obvious entry point to create
    or send a message.
13. Pilot go-live control center NO_GO recommendation doesn't link
    each blocker to the page that fixes it.
14. AP invoice detail page is long-scrolling; lines + exceptions +
    audit + approval competes for vertical space.
15. AR aging page renders a single big table; no graphical summary,
    no per-bucket drilldown.
16. Imports detail page shows raw row JSON without column labels.
17. Member portal billing recent payments doesn't link to the source
    statement.
18. Reporting packages page lacks an "import default sections from
    template" CTA, leaving the section editor empty after create.
19. Login page is functional but unbranded — no club logo or
    welcome copy.
20. The /app/admin Dashboard renders a long list of cards with no
    role-based prioritization.

## Recommended repair order

Phase the fixes so the pilot demo lands cleanly.

1. **Today (before any pilot demo):**
   - P0-1 (Make a payment) — remove the disabled button OR ship the
     real flow.
   - P0-4 (Settings "Coming soon" grid) — delete the placeholder
     block.
   - P0-3 (Tee sheet member view) — either ship or remove from nav.
   - P1-7 (Welcome timeline) — wire from member hub or delete the
     route.

2. **This week:**
   - P0-2 (Admin post-charge form) — high-frequency staff workflow.
   - P0-2-companion (Admin record-payment form).
   - P1-3 (Send notification action).
   - P1-1 (Hardware adapters): either implement one real one or hide
     `/app/admin/devices` from nav.
   - P1-2 (SAML scaffold): hide the SAML choice in any SSO UI.

3. **Before the second pilot:**
   - P1-4 / P1-6 (Reporting packages + POS terminal completeness).
   - P1-8 (Bounce webhook signature verification).
   - P2-1 / P2-2 / P2-4 (UI consistency cleanup).
   - All UNTESTED workflows get at least one happy-path test.

4. **Polish (optional before pilot, expected before commercial launch):**
   - Everything in P2 + P3 not listed above.

## What must be fixed before any pilot demo

A demo means a real human walks through the product. The list is short
and explicit:

- **P0-1, P0-2, P0-3, P0-4** — these four items, in any combination,
  scream "scaffold" the moment a real operator clicks. Fix or remove.
- **The "Settings → Coming soon" grid is the worst offender.** Whoever
  the pilot operator is, they will land on Settings within their
  first hour. The current page is not a demo asset; it's an apology.
- **Add a visible "DEMO DATA" banner anywhere mock data renders.** Right
  now hardware events, seeded LLM commentary, and bundle templates can
  look real.
- **`npm run quality` should pass cleanly** before the demo. Currently
  `scan:placeholders` flags 13 entries — half are intentional schema
  comments (allowlist them or rewrite the comment); half are real
  TODOs that should either be fixed or filed.

## Definition of "ready for first pilot demo"

ALL of:
- `npm run quality` is green.
- Workflow audit shows ZERO PLACEHOLDER and ZERO BROKEN.
- The four P0 items are resolved (fixed or removed from the UI).
- The pilot onboarding wizard has been walked end-to-end with a
  real second user, and a `pilotGoLiveSignoff` row exists per category.
