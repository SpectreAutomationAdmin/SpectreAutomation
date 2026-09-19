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
#   • next.config.js now sets `output: "standalone"`. The builder
#     stage's `next build` produces `.next/standalone/` containing a
#     traced-minimum node_modules plus a `server.js` entry.
#   • The runner stage COPIES ONLY the standalone bundle + static +
#     public + Prisma runtime + Prisma CLI (for release_command) +
#     prisma-postgres migrations. It no longer ships the entire
#     builder-stage node_modules — the largest, slowest layer in the
#     old design and the one that stalled buildkit's export step for
#     40+ minutes on Windows Docker Desktop.
#   • Runtime CMD is `node server.js` (the standalone bundle's own
#     entry), not `next start` on top of the full framework.

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
# Heap ceilings split per RUN (see original commentary above).
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

RUN addgroup --system --gid 1001 spectre && adduser --system --uid 1001 --ingroup spectre spectre

# Public assets (served statically by the standalone server).
COPY --from=builder /app/public ./public

# Standalone bundle: server.js + traced-minimum node_modules.
# The bundle already declares its own package.json so `node server.js`
# resolves everything internally.
COPY --from=builder --chown=spectre:spectre /app/.next/standalone ./
COPY --from=builder --chown=spectre:spectre /app/.next/static ./.next/static

# Prisma runtime — the generated client under node_modules/.prisma and
# @prisma/client is USED by every server route. Next.js standalone
# should include these automatically via tracing, but we copy them
# explicitly to guarantee they are present even if a tracing gap
# appears in a future minor of Next.js.
COPY --from=builder --chown=spectre:spectre /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=spectre:spectre /app/node_modules/@prisma ./node_modules/@prisma

# Prisma CLI — required by fly.web.toml's release_command
# (`npx prisma migrate deploy`). Not traced (nothing imports the CLI).
COPY --from=builder --chown=spectre:spectre /app/node_modules/prisma ./node_modules/prisma

# Postgres migrations + schema — read by prisma migrate deploy at
# release time. Never accessed by the running server.
COPY --from=builder --chown=spectre:spectre /app/prisma-postgres ./prisma-postgres

# One-shot maintenance scripts (backfills, verification helpers).
# Bundled so `flyctl ssh console --command 'node /app/scripts/...'`
# has them without a separate SFTP hop. Read-only at runtime;
# nothing on the serving path imports from here.
COPY --from=builder --chown=spectre:spectre /app/scripts ./scripts

# tsx — some maintenance scripts under /app/scripts are TypeScript and
# invoked ad-hoc via `npx tsx`. Ship the CLI so on-call debugging keeps
# working. tsx is small (~50 MB) relative to the bundle.
COPY --from=builder --chown=spectre:spectre /app/node_modules/tsx ./node_modules/tsx
COPY --from=builder --chown=spectre:spectre /app/node_modules/esbuild ./node_modules/esbuild
COPY --from=builder --chown=spectre:spectre /app/node_modules/get-tsconfig ./node_modules/get-tsconfig
COPY --from=builder --chown=spectre:spectre /app/node_modules/resolve-pkg-maps ./node_modules/resolve-pkg-maps
COPY --from=builder --chown=spectre:spectre /app/node_modules/.bin/tsx ./node_modules/.bin/tsx
COPY --from=builder --chown=spectre:spectre /app/node_modules/.bin/prisma ./node_modules/.bin/prisma

USER spectre
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

# Standalone bundle exposes its own server.js at repo root.
CMD ["node", "server.js"]
