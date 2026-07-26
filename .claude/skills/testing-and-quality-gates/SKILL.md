---
name: testing-and-quality-gates
description: Run the right gate at the right time. Never declare done without it.
---

# Testing and quality gates

## When to use
Before claiming any task is complete. Also after any cross-cutting refactor.

## Steps
1. **Targeted typecheck** — `npm run typecheck`. Must be clean.
2. **Targeted tests** — for an isolated change, run the most relevant
   `tests/<area>.test.ts` file via `npx vitest run tests/<area>.test.ts`.
   For a cross-cutting change, run `npm run test`.
3. **Placeholder scan** — `npm run scan:placeholders`. Must be clean.
4. **Build (broad changes only)** — `npm run build`. Must be clean.
5. **Smoke (production-shaped changes)** — `npm run smoke`. Should be
   PASS or WARN — never FAIL.
6. **Full quality gate** — `npm run quality` runs steps 1–5 in order
   and stops at the first failure.
7. **End-to-end click-through** — for UI-visible work, boot the dev
   server (`npm run dev`) and exercise the golden path + at least one
   edge case in a browser.

## Completion criteria
- All required gates green.
- The change is exercised end-to-end where applicable.
- No `--no-verify`, no `--force`, no test skips.

## Red flags
- Declaring done after only `tsc --noEmit` clean.
- Claiming a feature works because the page returns HTTP 200.
- Skipping the smoke runner because "it's been clean before".
- Adding a feature flag to hide a half-built feature instead of
  finishing or removing it.
- Inserting `@ts-expect-error` to push past failing types.
