---
name: no-placeholder
description: Refuse to ship scaffolding disguised as a feature.
---

# No placeholder

## When to use
Before writing any service, page, or component. Re-run before declaring
the change done.

## Steps
1. Re-read your own diff. Ask: does every code path execute REAL
   behavior? Are there any `// TODO`, `// for now`, "coming soon",
   "not implemented", "mock-only", "future implementation",
   "temporary", "scaffold only" comments?
2. If a behavior is intentionally deferred, the function must:
   - Either NOT be exported, or
   - Throw a clearly named error (e.g.
     `throw new NotImplementedError("Phase 15: <reason>")`), so callers
     break loudly rather than silently doing nothing.
3. Any UI that surfaces mock data MUST visibly say so — a `MOCK`
   badge, an amber banner, the literal text "demo data only". Never
   let a member or admin think they're looking at real numbers when
   they aren't.
4. Run `npm run scan:placeholders`. If it flags a string that's
   intentional (a docs page describing a Phase 15 plan, for example),
   add an entry to `config/placeholder-allowlist.json` with a reason.
5. Prefer removing the half-finished surface to "wiring it up later".
   A missing page is fixable. A page that lies is a bug.

## Completion criteria
- `npm run scan:placeholders` exits 0.
- Every exported function executes real behaviour or throws cleanly.
- The UI never shows fake numbers without a visible "DEMO" tag.

## Red flags
- Adding a new entry to the placeholder allowlist without a reason.
- A function that returns `[]` or `{}` "for now".
- Comments like "real wiring lives in Phase N+1".
- Pages that render a hardcoded array of demo data.
- New product modules built around stub services.
