# Spectre — Remediation Backlog

Sorted by priority. P0 blocks any pilot demo. P1 is "looks done but isn't".
P2 is ugly / confusing UI. P3 is polish.

This list reflects the honest workflow audit in `docs/workflow-audit.md`.
Phase numbers from earlier work are referenced for context; nothing here is
new product scope.

## P0 — broken core workflow (must fix before any pilot demo)

| # | Item | Where | What's needed |
|---|---|---|---|
| P0-1 | Member "Make a payment" button is permanently disabled | `src/app/app/member/account/page.tsx:60` | Either build a working tokenized payment flow against an existing PaymentMethod (calls the same path as the admin posting service) OR remove the button entirely. The current state — disabled button with the literal hover text "Payment integration placeholder" — is the loudest possible "this app isn't done" signal. |
| P0-2 | No admin UI to post a charge or payment to a member | `src/app/app/admin/members/[id]/page.tsx` | The most common staff workflow (charge a member, record a payment) has no form. Service is `postCharge` / `postPayment` in `services/ar.ts`. Add a tabbed "Activity / Add Charge / Record Payment" section to the member detail page. |
| P0-3 | Tee sheet has no member booking surface | `src/app/app/member/` | Admins can generate sheets but members can't reserve. Either build a member booking page that calls the existing `teesheet` service, or remove the "Tee Times" admin marketing copy until that path exists. |
| P0-4 | Settings page renders a hardcoded "Coming soon" grid of 8 features | `src/app/app/admin/settings/page.tsx:80-92` | Delete the placeholder block. It's the highest-visibility "this is scaffolding" signal in the admin UI. Replace with a real Integrations panel that links to `/app/admin/integrations`. |

## P1 — placeholder pretending to be functional

| # | Item | Where | What's needed |
|---|---|---|---|
| P1-1 | Hardware adapter framework is explicitly stubs | `src/lib/hardware/index.ts:4` | Either implement one real adapter (the simplest is a webhook ingest with HMAC) or remove the page at `/app/admin/devices` from the admin nav. Today it lists devices that can never report. |
| P1-2 | SSO SAML side is "scaffold only" | `src/lib/sso/index.ts:7` | Phase 12B did real OIDC. SAML is documented as not implemented. Hide the SAML option in any SSO setup UI until it's done, or implement against `@node-saml/node-saml`. |
| P1-3 | Notifications has no "send" action from the UI | `src/app/app/admin/notifications/page.tsx` | Inbox + template library render. Add a "Send notification" form that posts a `Notification` row via `notificationService.create` + dispatches through the delivery adapter. |
| P1-4 | Reporting packages — section composition is a placeholder UI | `src/app/app/admin/governance/packages/` | Create + list works. Section authoring + distribution targets are not wired into a real UX flow. Pick one: either build the section editor or restrict packages to a "predefined template" set. |
| P1-5 | Member-side bag tag / cart / door / weather / OCR settings are listed but absent | `src/app/app/admin/settings/page.tsx` | These belong on the same kill list as P0-4. Either delete the labels or move them to a CHANGELOG-style "roadmap" page that isn't pretending to be active integrations. |
| P1-6 | POS UI is a single-line quick-sale, not a real point-of-sale | `src/app/app/admin/ops/pos/page.tsx` | Service supports multi-line + multi-payment. UI doesn't. For pilot demo, either ship a cart UI or label POS as "Quick sale only — full terminal in Phase 16". |
| P1-7 | Welcome timeline carries a TODO and isn't linked from member hub | `src/app/app/welcome/timeline/page.tsx:9` | Wire it from `/app/member` OR remove the route. Standalone wizards that no one navigates to from anywhere are scaffold. |
| P1-8 | Email bounce webhook has no signature verification | `src/lib/email-delivery/index.ts` + webhook route | `recordEvent` accepts any caller. Add per-provider HMAC checks (SES SNS, Postmark, SendGrid) in the receiving route before calling `recordEvent`. |

## P2 — ugly or confusing UI

| # | Item | Where | What's needed |
|---|---|---|---|
| P2-1 | Many admin tables lack a humane empty-row | scan via `npm run ui:audit` | Audit script flags the missing rows. Every table gets "No <thing> yet." colSpan row. |
| P2-2 | Status badges leak raw enum names | several pages | Wrap with `<Badge>` everywhere. The audit script flags `{x.status}` rendered without Badge. |
| P2-3 | Member-facing error messages leak `ConflictError:` prefix | various | Catch + reformat in the page boundary, not pass-through. |
| P2-4 | Inconsistent currency formatting | scan via `npm run ui:audit` | Wherever the audit flags `.toFixed(2)`, replace with `formatCurrency()`. |
| P2-5 | Member tournament score page should be more mobile-first | `src/app/app/member/tournaments/[id]/score/[roundId]/page.tsx` | Larger inputs, bigger hit targets, sticky "Save" button on small screens. |
| P2-6 | Member portal billing page mixes balance overview + statements + payment methods + disputes in one wall of cards | `src/app/app/member/billing/page.tsx` | Break into tabs or accordion sections. The current density is high for non-technical members. |
| P2-7 | Admin pilot onboarding wizard step buttons feel utilitarian | `src/app/app/admin/pilot/onboarding/[id]/page.tsx` | Replace the bare `<select>` per row with a step indicator (1-of-15) and a "Open this step's form" call-to-action. |

## P3 — polish

| # | Item | Where | What |
|---|---|---|---|
| P3-1 | Add keyboard shortcuts to common admin actions (Save, Approve, Post). | n/a | Low priority; nice for power users. |
| P3-2 | Audit log viewer doesn't filter by entityType | `/app/admin/security` adjacent | Existing service supports the filter; UI doesn't surface it. |
| P3-3 | Sidebar items reflect the user's actual permissions instead of role-based rules | `src/components/Sidebar.tsx` | Today the sidebar is role-driven. Permission-driven would be more accurate. |
| P3-4 | Add a `/api/healthz` JSON endpoint that wraps `runSmokeTests()` | n/a | Useful for an external monitor. |
| P3-5 | Member portal account page could surface one-click "Pay outstanding" CTA when balance > 0 — but only after P0-1 lands. | n/a | Dependent. |

## Test infrastructure — dedicated defect (opened 2026-07-25)

| # | Item | Where | What's needed |
|---|---|---|---|
| TI-1 | Vitest suites cannot run in parallel — every worker shares `prisma/test.db` and each `beforeAll` runs `prisma db push --force-reset`, so two workers mutually destroy each other's DB mid-run. Full non-e2e suite is therefore serial-only, ~5–6 hours wall-clock. Discovered while attempting the Sprint 3 Checkpoint 15H pre-deploy gate. | `tests/setup.ts:39-51`, `scripts/test-db-serial.ts`, `scripts/lib/test-categories.ts` | Refactor `tests/setup.ts` to derive a per-worker DB path (e.g. `prisma/test-w${process.env.VITEST_WORKER_ID ?? "1"}.db`), ensure `beforeAll` runs the `db push` against that path, reliably clean up on process exit even under Windows file-locking, and add a new `npm run test:db:parallel` script that removes `--maxWorkers=1`. Once green under 4 workers, promote it to the standard pre-deployment gate and update `CLAUDE.md`'s "Testing rule" section to point at it. Until this ships, no run of the full non-e2e suite is safe with >1 worker. |

## Out of scope until the workflow audit shows P0 + P1 are cleared

- New product modules (no new domains; finish what exists).
- Native mobile auto-publish to TestFlight / Play (handled in Phase 14G CI scaffolding only).
- Cross-club implementation analytics (requires a second pilot to exist).
- Public marketplace UI (deliberately deferred from Phase 12F).
