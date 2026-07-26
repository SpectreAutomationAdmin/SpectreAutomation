# Spectre Sprint Roadmap

**Status:** Locked authoritative tracker · Target ship: September 2026
**Owner:** Founder · **Updated:** 2026-07-18

This document tracks the seven design foundations that make up Spectre v1.0.
It is the single source of truth for what has shipped, what is in flight, and
what remains before September.

## Design Sprint Lifecycle (locked)

```
Design Concept ─► Founder Review ─► Founder Approval ─► Production Integration
                                                                    │
                                                                    ▼
                                                    Regression Testing ─► Foundation Locked
```

A foundation is **Locked** when it has been integrated into the production
application and passes regression testing. Locked foundations are not
redesigned — they are only revised in response to a genuine usability issue
discovered during real use.

## Foundation Tracker

| Foundation           | Concept | Founder Approved | Integrated | Locked |
|----------------------|:-------:|:----------------:|:----------:|:------:|
| Mission Control      |    ✅   |         ✅        |     ✅     |    ✅   |
| Data Workspace       |    ✅   |         ✅        |     ✅     |    ✅   |
| Workflow Surface     |    ✅   |         ⬜        |     ⬜     |    ⬜   |

**Data Workspace — Locked 2026-07-18.** Phase A shipped the workspace
shell (real search, real sort, saved views, density, first-class
selection with hidden-selection semantics, fund-applicability view,
read-only inspector, all legacy URL params preserved). Phase B replaced
the legacy edit modal with inline inspector editing driven by a
reload-less server action, wired the remaining three saved views
(Needs attention · Unassigned FS group · Recently changed), landed
bulk archive from the selection bar, retired the edit-modal
presentation code, and moved dead references out of `page.tsx`. Every
production capability preserved; every URL alias still resolves. See
[docs/design/data-workspace-foundation.md](data-workspace-foundation.md)
for the final production shape and
[docs/design/data-workspace-integration-plan.md](data-workspace-integration-plan.md)
for the completed-phase log.
| Workflow Surface     |    ⬜   |         ⬜        |     ⬜     |    ⬜   |
| Executive Reporting  |    ⬜   |         ⬜        |     ⬜     |    ⬜   |
| Settings             |    ⬜   |         ⬜        |     ⬜     |    ⬜   |
| Mobile               |    ⬜   |         ⬜        |     ⬜     |    ⬜   |

## Notes on the Foundations

**Mission Control** (Locked 2026-07-18).
The founder-approved Variant D "Professional Instrument" concept is now the
production landing page at `/app/admin`. Every displayed value is sourced
from real Prisma queries at request time. The design-language mockups
remain at `public/design-concepts/mission-control/` as the reference the
production page was translated from.

**Data Workspace** (Concept ready for founder review, 2026-07-18).
The refined interactive concept is at
`public/design-concepts/data-workspace/chart-of-accounts.html`. It
demonstrates the reusable workspace language — header, toolbar, saved
views, table + grouping, selection, inspector, URL state, save contract,
validation, status vocabulary, density, keyboard model, and empty states —
against the Chart of Accounts as the exemplar. The pattern will then be
reused for Trial Balance, Vendors, Members, Employees, Fixed Assets,
Inventory, Budgeting, and Journal Entries. Supporting documents:
- [Functional parity matrix](data-workspace-functional-parity.md) — every production CoA capability accounted for.
- [Foundation specification](data-workspace-foundation.md) — implementation-oriented reference for every primitive.
- [Integration plan](data-workspace-integration-plan.md) — ten-phase, feature-flagged, reversible integration roadmap.

**Workflow Surface** (Phase 0 concept complete, 2026-07-18 — awaiting founder review).
The foundation that will power every operational workflow in Spectre — AP
Invoice Approval, Journal Entry Approval, Member Applications, Payroll
Exceptions, Purchase Requests, Expense Claims, Capital Requests, HR
Onboarding, Work Orders. Nine reusable primitives (Workflow Queue,
Evidence Panel, Recommendation Card, Approval Bar, Activity Timeline,
Conversation Thread, State Chip, Workflow Banner, Workflow Detail) driven
by an AI-assisted-human-judgment philosophy: AI recommends and explains
with confidence + reasoning; humans always decide; every irreversible
action has a revert window. Three concept HTMLs at
`public/design-concepts/workflow-surface/`. Companion documents:
- [Foundation specification](workflow-surface-foundation.md) — architecture, primitives, interaction standards, AI philosophy.
- [State model](workflow-surface-state-model.md) — the 15-state machine, transitions, guards, error paths, and revert-window contract.
- [Integration plan](workflow-surface-integration-plan.md) — seventeen-phase rollout starting with AP Invoice Approval and generalising across the eight follow-on workflow types.

**Executive Reporting** (Not started).
The Monthly Board Reporting Package chapters. Substantial governance
rules already exist in `docs/spectre-executive-reporting-design-system.md`,
`docs/spectre-first-scroll-reporting-standard.md`, and the chart-system
docs; this foundation reconciles those rules with the Executive Interface
Standards.

**Settings** (Concept complete, awaiting founder approval).
The `/app/admin/settings` proof (Phase 2) demonstrates the pattern. Once
approved it will extend to sub-routes (`/app/admin/settings/domains`,
`/app/admin/settings/pos-printers`).

**Mobile** (Not started).
Responsive treatment of every Locked foundation at 390 × 844 (iPhone
portrait) and 768 × 1024 (tablet portrait). No standalone mobile app;
the same routes must work in a mobile browser.

## Project Execution Rule

Every completed design concept moves into production before the next
large-scale redesign begins elsewhere. Spectre is no longer producing
isolated mockups — every sprint must leave the shipping product closer
to September.
