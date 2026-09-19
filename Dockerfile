# Phase 8I — Production Dockerfile (web tier).
# Multi-stage build for the Next.js runtime.
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
#   • devDeps are installed in production because `prisma` + `tsx` are
#     devDependencies and we need them at release + runtime respectively.
#     No `--omit=dev`. The image is a few MB larger; the alternative
#     is to promote both to `dependencies` which is invasive to
#     package.json for a minor size win.
#
# DRH-1 (2026-09-19) — attempted `output: "standalone"` slimming here
# but the Next.js standalone tracer (`Collecting build traces`) is
# silent for 10+ min under Windows Docker Desktop + buildkit and
# tripped the deployment controller's BUILD idle watchdog. Reverted to
# the fat-runner design that historically deployed successfully. The
# reliability improvement moved to `scripts/deploy-staging.mjs` (which
# owns preflight, stage-specific watchdogs, retry policy, health
# verification, rollback anchor, and structured logging).
# CI-runner slimming is deferred to DRH-1 §21.

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
# Heap ceilings split per RUN (see git blame for detailed rationale).
RUN NODE_OPTIONS="--max-old-space-size=2560" \
    npx prisma generate --schema prisma-postgres/schema.prisma
RUN NODE_OPTIONS="--max-old-space-size=3840" \
    DATABASE_URL="postgresql://build:build@build.invalid:5432/build_placeholder?sslmode=require" \
    SPECTRE_SESSION_SECRET="build-time-placeholder-32-chars-min-abcdefghijk" \
    npm run build

# ---- runner stage ----
FROM node:20-alpine AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl curl
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Create non-root user.
RUN addgroup --system --gid 1001 spectre && adduser --system --uid 1001 --ingroup spectre spectre

COPY --from=builder /app/public ./public
COPY --from=builder --chown=spectre:spectre /app/.next ./.next
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma-postgres ./prisma-postgres
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
# One-shot maintenance scripts (backfills, verification helpers).
# Bundled so `flyctl ssh console --command 'node /app/scripts/...'`
# has them without a separate SFTP hop. Read-only at runtime;
# nothing on the serving path imports from here.
COPY --from=builder /app/scripts ./scripts

USER spectre
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node_modules/.bin/next", "start"]
