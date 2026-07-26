---
name: workflow-verification
description: Verify an end-to-end workflow actually works in a browser.
---

# Workflow verification

## When to use
Before claiming any user-visible workflow is "done". Re-run after any
cross-cutting change that touches the workflow's services or pages.

## Steps
1. Identify the actor (which seeded user) and their permission set.
2. Boot the dev server (`npm run dev`) and sign in as that user.
3. Walk the workflow exactly as a real operator would:
   - Click the entry point in the nav.
   - Fill the form with real-looking data.
   - Submit. Verify the success path: did the row appear? Did the
     audit log get written? Did the dashboard update?
   - Re-submit with an invalid input. Verify the error banner appears
     and the form data is preserved.
   - Where applicable, sign in as a SECOND user (different role or
     different club) and verify they cannot see or touch the first
     user's data.
4. Open the database (`npx prisma studio` or a query) and verify the
   rows exist with the expected status / clubId / audit pointer.
5. For workflows that emit notifications, webhooks, or external
   side-effects, verify those land or are at least queued.
6. Document the verified path in
   `docs/workflow-audit.md` — move the row from "untested" /
   "partially functional" to "works end-to-end" and date the entry.

## Completion criteria
- Both happy path AND one error path tested in the browser.
- Tenant isolation tested with a second user where applicable.
- DB rows confirmed with expected shape and clubId.
- `docs/workflow-audit.md` updated.

## Red flags
- "It type-checks" used as evidence of working behaviour.
- A workflow that returns HTTP 200 but doesn't write expected rows.
- Audit log entries missing for state changes.
- The page renders demo data without a visible "DEMO" tag.
- A path that crashes when the entity doesn't exist (missing
  `NotFoundError`).

## Discoverability check
Before signing off on a workflow, verify the founder click-path:
1. Log in as the role that owns the workflow.
2. Reach every new page from the sidebar or a hub card — no typed URLs.
3. Run `npm run nav:audit`. URL-only count must be 0.
4. The post-task reboot report must include the exact click path, not
   just the route (per `feedback-post-task-reboot` rule).
