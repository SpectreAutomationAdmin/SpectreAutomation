# Spectre — Workflow Audit

Classification key:

- **GREEN** — service + UI complete, exercised by tests AND verified end-to-end in a browser within the last 30 days.
- **PARTIAL** — service works but UI is incomplete OR UI looks done but a key path stubs out.
- **PLACEHOLDER** — page renders, but the underlying behavior is mock / disabled / stub.
- **BROKEN** — known-failing path. Crashes, throws, or silently no-ops.
- **UNTESTED** — code exists but no automated test exercises the workflow end-to-end.

Last reviewed: 2026-05-24 (POS row only). Every entry includes the file:line that drove the rating.

| Workflow | Status | What works / what doesn't | Reviewed |
|---|---|---|---|
| Member onboarding (apply flow) | GREEN | `/clubs/[slug]/apply` 4-step token flow. Service `services/applications.ts` + tests `tests/applications.test.ts`. | 2026-05-17 |
| Member portal activation | GREEN | `MemberPortalInvite` lifecycle (PENDING → SENT → OPENED → ACTIVATED). Bulk send, resend, activation. Phase 13D + Phase 14D. | 2026-05-17 |
| Member AR billing | PARTIAL | Service `services/ar.ts` is solid (post/void/reverse + GL adapter). **No admin UI to actually post a charge or payment** — staff can't bill a member from `/app/admin/members/[id]`. Member-side `/app/member/account` shows balances; the "Make a payment" button is permanently `disabled` with `title="Payment integration placeholder"` (`src/app/app/member/account/page.tsx:60`). | 2026-05-17 |
| Collections | PARTIAL | Service `services/collections.ts` (templates, stages, notices, access restrictions). Admin UI at `/app/admin/collections` exists. Notice generation + send flow not verified end-to-end; member-facing notice surface is unverified. | 2026-05-17 |
| AP invoice posting | GREEN | Full lifecycle (DRAFT → APPROVED → POSTED → REVERSED), exception detection, contra entries. Phase 4 tests `tests/ap.test.ts`. | 2026-05-17 |
| AP payment batches | GREEN | Direct-pay + batch flow. Approval workflow. `tests/ap.test.ts`. | 2026-05-17 |
| GL journal posting | GREEN | Full DRAFT → APPROVED → POSTED → REVERSED. Period gate, balance check, audit. `tests/accounting.test.ts`. | 2026-05-17 |
| Financial statements | GREEN | Balance sheet, trial balance, income statement, department P&L. `tests/accounting.test.ts`. | 2026-05-17 |
| Imports (data migration) | GREEN | 3-phase `createBatch → validateBatch → commitBatch`. 8 domains. Phase 13B + tests. | 2026-05-17 |
| Import templates (Jonas + generic) | GREEN | 10 shipped templates, apply-to-batch, required-column validation. Phase 14C + tests. | 2026-05-17 |
| Opening balances + subledgers | GREEN | DRAFT → POSTED → LOCKED state machine, AR/AP subledger reconciliation. Phase 13C + 14E + tests. | 2026-05-17 |
| Member invites (bulk send) | GREEN | Tokens, suppression integration, bulk + resend + corrected-email. Phase 13D + 14D + tests. | 2026-05-17 |
| Email bounce / suppression | GREEN | Provider-agnostic event recording, suppression list. Phase 14D + tests. Note: **provider webhook signature verification is not implemented** (Phase 15 risk). | 2026-05-17 |
| Tee times | PARTIAL | Admin generates sheets at `/app/admin/ops/tee-sheet`. Lottery create/draw works. **No member-side booking page exists** — members cannot reserve a tee time. The tee-sheet itself only renders to admins. | 2026-05-17 |
| Tournaments — setup + registration | GREEN | Create, register-with-AR-charge, cancel-with-reverseCharge. Phase 9 + tests. | 2026-05-17 |
| Tournaments — member scoring | GREEN | Hole-by-hole entry at `/app/member/tournaments/[id]/score/[roundId]`. Phase 11E + 12C + 13G + tests. | 2026-05-17 |
| Tournaments — conflict resolution | GREEN | Conflict detection on stale save, admin queue at `/app/admin/ops/tournaments/conflicts`. Phase 13G + tests. | 2026-05-17 |
| POS sales | PARTIAL | Two POS workflows now ship. **Primary — Floor Map POS:** sidebar "Point of Sale" → `/app/admin/hospitality/reservations/floor` → click table → mark seated with primary member # → seat view at `/app/admin/ops/pos/lounge/table/[checkId]` → per-seat assignment + ordering → per-line modifiers (remove / add / substitute / allergy / note) → send chits (kitchen/bar) → settle to member account (full check or per-seat groups). Settlement folds modifier price deltas into POSSaleLine, snapshots POSSaleLineModifier rows, posts AR Charge + GL JE (DR 1110 / CR 4200 / CR 2110) for the modifier-adjusted total, the member dining receipt at `/app/member/dining/[id]` shows the same itemised breakdown, and receipt emails are sent (a) once on the merge-all-into-one case (single group, MEMBER_ACCOUNT, fully closed) writing to POSCheck.receiptEmailStatus, OR (b) once per MEMBER_ACCOUNT group on a split-bill close writing to POSSettlementGroup.receiptEmailStatus. The Split & Settle modal flips to a per-group result panel showing each payer + email status; the closed-checks history page surfaces each group as a sub-row with its own receipt-email cell. Service backing in `src/lib/pos/seat-checks.ts` + `src/lib/pos/checks.ts` + `src/lib/pos/modifiers.ts` + `src/lib/pos/receipts.ts`; tests in `tests/pos-seat-workflow.test.ts`, `tests/pos-seat-ordering.test.ts`, `tests/pos-seat-modifiers.test.ts`, `tests/pos-seat-settlement-modifiers.test.ts`, `tests/pos-seat-settle-receipt-email.test.ts`, `tests/pos-seat-split-receipt-emails.test.ts`, `tests/pos-seat-drilldown.test.ts`, `tests/floor-map.test.ts`. **Secondary — Quick Sale / Bar:** `/app/admin/ops/pos/lounge` (legacy tableless LoungePOS) kept for bar / to-go / no-table transactions. **Why still PARTIAL, not GREEN:** StationView optimistic update has no rollback on action failure; 8 POS-surface tables missing empty-state fallback; 6 pages missing `spectre_*_error` cookie pattern; QR_PAY-per-group silently unavailable in split-bill. Per-group resend now ships in `/admin/ops/pos/lounge/history` via `GroupResendReceiptButton` — disabled with a clear reason when the group has no email / is QR_PAY / has no sale / belongs to a voided check; reuses `sendAndRecordGroupReceiptEmail` so no second engine. Hospitality surveys now ride along on split-bill receipts: each MEMBER_ACCOUNT settlement group gets its own `HospitalitySurveyInvitation` row (anchored by `posSettlementGroupId`), each paying member's email carries a distinct token, and submissions write `posSettlementGroupId` onto the response so dashboards can aggregate by group. Whole-check / merge-all surveys keep the existing posSettlementGroupId=null shape — same single-row reuse on resend. Full punch list in [docs/pos-cleanup-plan.md](docs/pos-cleanup-plan.md). | 2026-05-25 |
| Inventory | PARTIAL | Admin UI offers item create, receive, adjust. **Counts and transfers exist as services but no UI**. Low-stock card present. | 2026-05-17 |
| Reporting packages | PARTIAL | Create + list exists at `/app/admin/governance/packages`. **Section composition and commentary are placeholder UIs**; package distribution writes to log but distribution channel isn't wired. | 2026-05-17 |
| Notifications | PARTIAL | Inbox + template library at `/app/admin/notifications`. **No "send notification" action from the UI**; no campaign creation form. Email-health + analytics dashboards work. | 2026-05-17 |
| Support impersonation | GREEN | Request/approve/start/end session flow. READ_ONLY vs ELEVATED enforcement. Phase 13F + 14B + tests. | 2026-05-17 |
| Training mode | GREEN | Toggle + scenarios. `assertNotTraining` wired into every posting boundary in Phase 14A. Tests cover blocked + allowed paths. | 2026-05-17 |
| Pilot onboarding wizard | GREEN | 15-step wizard, blockers, signoffs, go-live approval. Phase 13A + tests. | 2026-05-17 |
| Implementation playbook | GREEN | 15 entries, clone-to-project idempotent, markdown export. Phase 14H + tests. | 2026-05-17 |
| Go-live control center | GREEN | Aggregates onboarding + smoke + launch + Phase 14I checks. Tests cover NO_GO and CAUTION recommendations. | 2026-05-17 |
| MFA enrolment + verify | UNTESTED | Service `src/lib/mfa/index.ts` works; no Vitest assertion against the enrolment UI at `/app/admin/mfa`. Manual verification only. | 2026-05-17 |
| SSO (OIDC) | PARTIAL | Phase 12B production OIDC exchange. **No admin UI to configure providers** — must use a DB write or API. SAML side is explicitly "scaffold only" (`src/lib/sso/index.ts:7`). | 2026-05-17 |
| Settings → integrations | PLACEHOLDER | `/app/admin/settings` renders a hardcoded "Coming soon" list of 8 features (Bank Feeds, Production OCR, Tee Sheet, Weather API, GPS Bag Tag, Beverage Cart, Door Unlocks, AI Commentary). Pure UI shell with no service backing (`src/app/app/admin/settings/page.tsx:80-92`). | 2026-05-17 |
| Welcome / timeline | PLACEHOLDER | `src/app/app/welcome/timeline/page.tsx:9` carries a TODO about linking from member hub. The page is reachable but not actually wired into a real first-login flow. | 2026-05-17 |
| Hardware / IoT | PLACEHOLDER | `src/lib/hardware/index.ts:4` is explicit: "every adapter is a stub". Device registry persists; no real protocols. | 2026-05-17 |

## Quick counts

| Status | Count |
|---|---:|
| GREEN | 17 |
| PARTIAL | 9 |
| PLACEHOLDER | 3 |
| BROKEN | 0 |
| UNTESTED | 1 |

## What this audit changes about my prior claims

Earlier phase summaries described features as "complete" or "ready" that this
audit downgrades. Specifically:

- **Tee sheet** was called "production-ready" in the Phase 8 README. There is
  no member-facing booking UI. Real members cannot use this.
- **POS** was called "production-grade end-to-end". As of 2026-05-24 there are
  two POS workflows: the primary seated-dining workflow (Floor Map POS →
  SeatPOS, full lifecycle) and the secondary tableless Quick Sale / Bar (the
  legacy LoungePOS, kept for bar / to-go). Both work; the primary still has
  stabilisation work outstanding (see the PARTIAL row above and
  [docs/pos-cleanup-plan.md](docs/pos-cleanup-plan.md)).
- **AR billing** is missing the most common staff workflow: post a charge to
  a member from the admin members directory.
- **Notifications** was called "working". Inbox renders. There is no way for
  staff to actually send a notification from a button.
- **Settings page** is the literal example of UI placeholder the user
  complained about: a hardcoded grid of "Coming soon" labels.
