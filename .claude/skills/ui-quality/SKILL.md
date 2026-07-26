---
name: ui-quality
description: Enforce minimum UI quality for any page or component change.
---

# UI quality

## When to use
Any time you create or edit a file under `src/app/**/*.tsx` or
`src/components/**/*.tsx`.

## Steps
1. Identify the page's three states: empty, loading, error.
2. Use the shared primitives — `<Badge>`, `card`, `card-body`,
   `card-overflow-hidden`, `table-base`, `btn`, `btn-primary`,
   `btn-secondary`, `btn-sm`, `input`, `section-title`, `page-title`.
3. Tables must declare `<thead>` headers and a "no rows" `<tr><td colSpan=…>`
   row. Never let an empty list render zero rows with no explanation.
4. Destructive actions go through a confirm flow (modal, `<details>`,
   or `confirm()`). Never destructive-on-click.
5. Form errors render as a red banner near the top of the page
   (`spectre_*_error` cookie pattern is the convention).
6. Every action button is disabled when its precondition isn't met,
   not silently no-op.
7. Long lists paginate or cap at a sensible limit (200 default).
8. Boot the dev server and click through the page before declaring done.

## Completion criteria
- Page renders in the browser without console errors.
- Empty state has a humane message ("No invites yet" not "—").
- Each action button has a tested success and failure path.
- Visual style matches the surrounding admin pages (same spacing,
  same badge colors, same table chrome).

## Red flags
- Any "TODO design" / "real UI later" / "scaffold" in JSX.
- Buttons that look real but log to console or no-op.
- Tables with no empty-state row.
- Pages that show stale data after a write (missing
  `revalidatePath` / `revalidateTag`).
- Inline styles or hex colors instead of the design tokens.

## Discoverability
- A new page is not done until a user can reach it without typing the URL.
- Top-level workflows belong in `src/components/Sidebar.tsx`. Sub-features
  belong on the relevant hub page (e.g. `/app/admin/hospitality`,
  `/app/admin/ops`) as a module card.
- Detail and sub-form routes (`/X/[id]`, `/X/new`) must be reachable
  from a parent list/detail page link.
- Run `npm run nav:audit` before declaring done. Zero URL-only orphans
  is the bar; genuinely-internal routes are allowlisted in
  `scripts/nav-audit.ts` with a one-line reason.
- See `docs/navigation-audit.md` for the current map.
