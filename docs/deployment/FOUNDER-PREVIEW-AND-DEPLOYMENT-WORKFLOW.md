# Founder Preview & Deployment Workflow

Effective **2026-09-04** (adopted starting TA-1C).

Development for Spectre follows three clearly-separated environments.
Which environment applies to a given change is determined by the
change type, not by developer preference.

---

## Three-stage flow

### Stage A · Founder Preview (local, hot-reload)

**Purpose:** get functionality and UI in front of the founder as fast
as possible. Iterate on visual + interaction changes in seconds.

**Environment:** local Next.js dev server + local SQLite dev DB
(with per-slice synthetic fixture).

**When to use:**
- Every new UI slice.
- Any product-behaviour change where the founder wants to click
  through the flow before we commit to a Fly deploy.
- Correctness iteration on service logic + tests.

**Never do here:**
- Fly deploy.
- Production Docker build.
- Any operation that costs 8–15 minutes of wall-clock per iteration.

**Commands:**

```bash
# 1. Sync the local dev DB to the current Prisma schema.
npx prisma db push --schema prisma/schema.prisma --skip-generate

# 2. Regenerate the Prisma client if the schema changed.
npx prisma generate --schema prisma/schema.prisma

# 3. Optional: seed the per-slice founder-preview fixture.
npx tsx scripts/ta1c-founder-preview-fixture.ts   # or the slice's fixture

# 4. Start the dev server.
npm run dev

# 5. Founder opens the printed URL, clicks through, reports notes.
```

Founder Preview ends with either:
- **Corrections requested** → iterate in Stage A until the founder is satisfied.
- **Founder Preview accepted** → proceed to Stage B.

### Stage B · Staging Acceptance

**Purpose:** verify the accepted slice against the production-like
Fly environment (Postgres on Neon, real integrations, canonical CDN
+ CSP headers).

**Environment:** `spectre-staging` on Fly.io, backed by Neon primary
Postgres.

**When to use:**
- Only after the founder has explicitly accepted the Founder Preview.
- Every code change that ships to production must pass through
  Staging Acceptance first.

**Steps:**

```bash
# 1. Final regression sweep.
npx tsc --noEmit
npx vitest run <slice's tests + directly adjacent regressions>
npm run scan:placeholders

# 2. Local Docker production build. If this fails, never push.
docker version                        # confirm Docker Desktop is running
flyctl deploy --config deploy/fly.web.toml --local-only

# 3. Verify staging.
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  https://staging.spectreautomation.com/api/health
flyctl releases --app spectre-staging | head -3

# 4. Staging Playwright.
npm run test:e2e:staging -- tests/e2e/<slice>.staging.spec.ts

# 5. Founder inspects on staging.
```

Staging Acceptance ends when:
- All Playwright gates pass.
- Founder confirms behaviour on `https://staging.spectreautomation.com/…`.

### Stage C · Production

**Never** without explicit per-change founder authorisation. A prior
"you can deploy staging" NEVER authorises production. There is no
default production deploy path.

---

## Why this split

Prior to TA-1C, every UI iteration went through a full Fly deploy
(≈8–12 minutes per attempt on the founder's Windows workstation,
occasionally 15+ when the recurring `app repository not found` Fly
registry token quirk required a retry). The founder was waiting
double-digit minutes to see whether a button-label change looked
right.

Founder Preview drops that iteration cost to sub-second (hot module
reload) or a few seconds for a server-component change. Staging
Acceptance runs once when the founder is ready to commit to a
deploy.

**One-sentence rule:**
> *Iterate in Founder Preview. Deploy to Staging only after
>  Founder Preview is accepted.*

---

## Deployment performance audit (2026-09-04)

Snapshot of the current staging deploy path. All measurements taken
against `spectre-staging` on `deployment-01M1G88RR9KVZ9M8W13SXTD6CM`
(v342, TA-1B closeout).

### Current shape

- **Dockerfile:** 3-stage (deps / builder / runner). See
  [Dockerfile](../../Dockerfile).
  - `deps` stage: `npm ci --ignore-scripts` on an alpine `node:20`
    base. Cached by `package-lock.json` hash.
  - `builder` stage: copies deps → `COPY . .` (full source) →
    `prisma generate` (Postgres schema) → `next build`.
  - `runner` stage: copies `public`, `.next`, `prisma/`,
    `prisma-postgres/`, **full `node_modules`**, `package.json`.
    Runs as non-root `spectre` user. Executes `next start`.
- **.dockerignore:** already excludes `node_modules`, `.next`, `.git`,
  `test-results`, `.claude`, `.vscode`, most `*.md`, coverage,
  playwright-report. Well-maintained.
- **Deploy path:** `flyctl deploy --local-only` (local Docker build +
  push to Fly registry). Remote builder is not used per the
  Payroll-3B-5B-3A OOM incident.

### Findings

1. **`COPY . .` at line 34 invalidates the builder cache on every
   source change.** This is unavoidable while every source file is
   part of the Next build. Confirmed behaviour — small source edits
   force `prisma generate` + `next build` to rerun. Wall-clock ≈
   4–6 min on the founder's workstation.

2. **`next start` runtime uses the full `node_modules` tree** even
   though the Dockerfile header comment claims "standalone runtime."
   Currently ships ≈120MB of node_modules in the runner. Next.js
   supports an `output: "standalone"` mode that produces a
   minimum-dependency `.next/standalone` directory (`node build.js`
   as entry, ≈40–50MB of runtime deps). **Not enabled** in
   [next.config.js](../../next.config.js).

3. **Recurring Fly registry `app repository not found` on the first
   push after a long-running local build.** Reproducible on the
   founder's Windows workstation. Root cause is a flyctl registry
   token that has expired mid-build. Every retry succeeds
   immediately. Not a code fix — needs an infra note ("if the first
   push fails with `app repository not found`, retry once").

4. **Prisma client generation runs against `prisma-postgres/schema.prisma`
   (11k+ lines) inside the builder stage.** Runs once per build.
   Prior heap-ceiling tuning documented in the Dockerfile header —
   currently pinned at 2560 MB after the Payroll-3B-5B-3A remote-builder
   OOM incident. Local Docker Desktop with sufficient RAM handles it
   fine.

5. **Two heap ceilings for two RUN commands** — `prisma generate`
   (2560 MB) and `next build` (3840 MB). The comment at
   Dockerfile:36–55 documents why the ceilings are split. Correct.

### Quick wins (safe to attempt soon)

- **Enable Next.js standalone output** — one line in `next.config.js`
  + update runner stage to copy `.next/standalone` + `.next/static` +
  `public` instead of the whole `node_modules`. Expected: image
  drops ~50–60%, push wall-clock drops proportionally, run-time RAM
  usage drops. Requires a separate slice — do NOT bundle with a
  product feature.
- **Docker `--build-arg BUILDKIT_INLINE_CACHE=1`** on the local
  build so subsequent builds can pull cached layers from the
  registry. Modest wall-clock win on repeat deploys.
- **Add a `flyctl deploy --local-only --push-retries=3`
  wrapper script** to auto-retry the token-expiry push failure
  without founder intervention.

### Medium improvements (defer until Q4)

- **Move `prisma generate` into a dedicated build stage** so its
  cache invalidates only when `prisma-postgres/schema.prisma`
  changes (not when unrelated source changes). Requires refactoring
  the builder into two stages.
- **Bundle the Postgres schema separately** so `prisma migrate deploy`
  doesn't re-copy the whole prisma-postgres directory.
- **Investigate a Fly-side remote builder upgrade** so we can drop
  `--local-only`. Requires ops action (Fly VM class change).

### Not worth touching

- Base image (alpine 20). Already minimal, well-understood by the
  team.
- Multi-stage architecture. Clean and correct.
- `.dockerignore`. Thoughtful and current.

### One-sentence recommendation

> *Enable Next.js standalone output as a dedicated slice; retry the
>  registry-token push failure with a small wrapper; defer everything
>  else until we've paid down the outstanding TA-1 work.*

---

## Founder Preview per-slice checklist

Every slice that reaches Founder Preview should end with:

1. `npx tsc --noEmit` clean.
2. Slice's vitest suite green.
3. `npm run dev` running.
4. Fixture seeded if the slice needs founder-visible data.
5. Local URL + click path printed at the end of the checkpoint
   report.
6. Explicit `STOP` — no Fly deploy without founder acceptance.

Staging Acceptance runs are always a SEPARATE checkpoint, after the
founder has said "Founder Preview accepted, ship to staging."
