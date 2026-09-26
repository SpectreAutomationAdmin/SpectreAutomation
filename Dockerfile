# Phase 8I — Production Dockerfile (web tier).
# Multi-stage build for the Next.js standalone runtime.
#
# Sprint 2 Step 7B (2026-07-20) — Postgres-safe Prisma path.
#   • `npm ci --ignore-scripts` skips the `postinstall` (which would
#     otherwise run `prisma generate` against the SQLite dev schema
#     and produce a SQLite client, then the runtime would refuse
#     `postgresql://` connections).
#   • The builder stage then generates the Prisma client EXPLICITLY
#     against `prisma-postgres/schema.prisma` (provider = postgresql,
#     kept in lockstep with the SQLite dev schema via
#     `scripts/sync-postgres-schema.mjs`).
#   • The release_command in fly.web.toml runs `prisma migrate deploy`
#     against the SAME Postgres schema so the migrations applied to
#     Neon exactly match the client generated here.
#
# DRH-1 (2026-09-19) — Next.js standalone output.
#   • next.config.js sets `output: "standalone"`. The builder stage's
#     `next build` produces `.next/standalone/` — a self-contained
#     runtime with only the traced-minimum node_modules plus a
#     `server.js` entry.
#   • The runner stage COPIES ONLY the standalone bundle + static +
#     public + Prisma runtime + Prisma CLI (for release_command) +
#     prisma-postgres migrations. Runtime image drops from ~2.3 GB to
#     ~350-400 MB.
#   • Canonical execution environment is a Linux CI runner
#     (.github/workflows/deploy-staging.yml). The Next.js standalone
#     tracer is silent for 10+ min on Windows Docker Desktop; the
#     Linux path completes it in ~90s.

# ---- deps stage ----
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Heap ceilings split per RUN — prisma generate needs modest heap and
# next build needs a large one. Setting both via ENV would cause the
# smaller build to over-allocate address space.
RUN NODE_OPTIONS="--max-old-space-size=2560" \
    npx prisma generate --schema prisma-postgres/schema.prisma
RUN NODE_OPTIONS="--max-old-space-size=3840" \
    DATABASE_URL="postgresql://build:build@build.invalid:5432/build_placeholder?sslmode=require" \
    SPECTRE_SESSION_SECRET="build-time-placeholder-32-chars-min-abcdefghijk" \
    npm run build

# ---- runner stage (DRH-1 slim runtime) ----
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl curl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user.
RUN addgroup --system --gid 1001 spectre && adduser --system --uid 1001 --ingroup spectre spectre

# Public assets served by the standalone server.
COPY --from=builder /app/public ./public

# Standalone bundle: server.js at repo root + traced-minimum
# node_modules. The bundle's own package.json declares the entry.
COPY --from=builder --chown=spectre:spectre /app/.next/standalone ./
COPY --from=builder --chown=spectre:spectre /app/.next/static ./.next/static

# Prisma runtime — the generated client under .prisma + @prisma/client.
# Next.js standalone should trace these, but we copy them explicitly so
# a tracing regression in a future minor of Next.js cannot break Prisma.
COPY --from=builder --chown=spectre:spectre /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=spectre:spectre /app/node_modules/@prisma ./node_modules/@prisma

# Prisma CLI — required by fly.web.toml's release_command. Invoked
# directly as `node /app/node_modules/prisma/build/index.js migrate
# deploy` so the CLI's own dirname resolves to `prisma/build/` and its
# sibling files (e.g. prisma_schema_build_bg.wasm) are located
# correctly. We intentionally do NOT copy `.bin/prisma` because
# Docker COPY dereferences symlinks and produces a standalone file
# whose __dirname is `.bin/`, breaking the WASM sibling lookup.
COPY --from=builder --chown=spectre:spectre /app/node_modules/prisma ./node_modules/prisma

# Postgres migrations + schema — read by prisma migrate deploy at
# release time. Never accessed by the running server.
COPY --from=builder --chown=spectre:spectre /app/prisma-postgres ./prisma-postgres

# One-shot maintenance scripts (backfills, verification helpers).
# Bundled so `flyctl ssh console --command 'node /app/scripts/...'`
# has them without a separate SFTP hop.
COPY --from=builder --chown=spectre:spectre /app/scripts ./scripts

# AUTH-3D.RBAC.FIX (2026-09-26) — the RBAC catalogue at
# src/lib/permissions.ts is a zero-import pure-data module. Copied here
# so /app/scripts/sync-rbac.ts (invoked via tsx by the fly.web.toml
# release_command after `prisma migrate deploy`) can import it directly
# and project the code catalogue into Permission / Role / RolePermission
# rows. hasPermission() reads the in-code constant at request time; the
# DB projection is for admin UI + audit introspection.
COPY --from=builder --chown=spectre:spectre /app/src/lib/permissions.ts ./src/lib/permissions.ts

# tsx — some maintenance scripts under /app/scripts are TypeScript.
# tsx + esbuild + resolvers together weigh ~50 MB, small next to the
# rest of the runtime.
#
# AUTH-3D.RBAC.FIX.PATCH (2026-09-26) — esbuild ships its platform-
# specific binary via the optionalDependencies mechanism as a separate
# package `@esbuild/<os>-<arch>`. On the Linux runner that resolves to
# `@esbuild/linux-x64`. Without the sibling package copied here, tsx
# fails at first script run with:
#   Error: The package "@esbuild/linux-x64" could not be found, and
#   is needed by esbuild.
# Copy the whole @esbuild scope so future architecture/version shifts
# don't require another Dockerfile change.
COPY --from=builder --chown=spectre:spectre /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder --chown=spectre:spectre /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=builder --chown=spectre:spectre /app/node_modules/@esbuild ./node_modules/@esbuild
COPY --from=builder --chown=spectre:spectre /app/node_modules/get-tsconfig ./node_modules/get-tsconfig
COPY --from=builder --chown=spectre:spectre /app/node_modules/resolve-pkg-maps ./node_modules/resolve-pkg-maps
COPY --from=builder --chown=spectre:spectre /app/node_modules/.bin/tsx ./node_modules/.bin/tsx

# bcryptjs — required by the staging synthetic-fixture script
# (scripts/slice-c-staging-screenshot-fixture.mjs) which is invoked
# via `flyctl ssh console` on the machine. Server routes import
# bcryptjs too, so standalone tracing normally includes it — the
# explicit copy is defensive.
COPY --from=builder --chown=spectre:spectre /app/node_modules/bcryptjs ./node_modules/bcryptjs

USER spectre
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# Standalone bundle exposes its own server.js at repo root.
CMD ["node", "server.js"]
