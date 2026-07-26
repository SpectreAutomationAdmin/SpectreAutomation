---
name: admin-workflows
description: Rules for any page or service touched by `/app/admin/*`.
---

# Admin workflows

## When to use
Any change under `src/app/app/admin/**` or the services those pages call.

## Steps
1. Permission gate FIRST. Every admin page resolves the principal and
   calls `requirePermission(principal, clubId, "<permission:key>")` or
   redirects to `/app/admin`. Never render an admin page without that
   gate.
2. Pages render a `<Sidebar>` + `<TopBar>` via the layout — don't
   re-implement chrome.
3. Server actions (`"use server"`) must call `getCurrentPrincipal()` and
   redirect to `/login` if missing.
4. Status mutations write `audit()` with the action/entity.
5. Pages that surface money use `formatCurrency()` from `@/lib/finance`.
6. Pages that surface dates use `formatDate()` from `@/lib/finance`.
7. When a service throws `AppError`, set the per-page error cookie
   (e.g. `spectre_<feature>_error`) and `revalidatePath` — surface the
   message at the top of the page.
8. Tables get an empty-state row, headers, and consistent column
   widths.

## Completion criteria
- Page loads with the right role in the seed (`admin@silversprings.club`).
- A user with insufficient permissions is redirected to `/app/admin`.
- Server actions handle the AppError → cookie → revalidate flow.
- Tables don't render blank when the list is empty.

## Red flags
- A page that doesn't call `requirePermission` or `hasPermission`.
- A server action that throws raw errors to the browser instead of
  setting the per-page error cookie.
- Money formatted with `.toFixed(2)` instead of `formatCurrency`.
- Tables with no `<thead>` headers.
- Inline styles instead of the design tokens.

## Discoverability
- A new admin page is not done until a Club Admin can reach it from the
  persistent sidebar (`src/components/Sidebar.tsx`) or from a hub page
  module card. Permission-gate the link with the same key as the page's
  server-side guard.
- Run `npm run nav:audit` before declaring done. Zero URL-only orphans.
- See `docs/navigation-audit.md`.
