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
#   • devDeps are installed in production because `prisma` + `tsx` are
#     devDependencies and we need them at release + runtime respectively.
#     No `--omit=dev`. The image is a few MB larger; the alternative
#     is to promote both to `dependencies` which is invasive to
#     package.json for a minor size win.

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
# Generate the Postgres Prisma client explicitly. If prisma-postgres/
# is missing or out of sync, this fails fast and the image cannot be
# built — surfacing schema drift before it reaches production.
RUN npx prisma generate --schema prisma-postgres/schema.prisma
ENV NEXT_TELEMETRY_DISABLED=1
# Sprint 2 Step 8 (2026-07-20) — Next.js build was OOMing at V8's
# default 1.5 GB heap on Fly's shared-cpu-2x remote builder (4 GB RAM).
# The build "completed" but left .next/ without a BUILD_ID, so the
# runtime crashed with "Could not find a production build". 3072 MB
# fits comfortably inside the builder's 4 GB.
ENV NODE_OPTIONS="--max-old-space-size=3072"
# Build-only placeholders. Next.js 14's "Collecting page data" phase
# evaluates every route module, which transitively imports src/lib/env.ts
# and runs Zod validation at module load. DATABASE_URL and
# SPECTRE_SESSION_SECRET are runtime Fly secrets — absent during build.
# These placeholders are scoped to THIS RUN command only (not `ENV`),
# so they are NOT baked into any image layer and are NOT visible at
# runtime. The real Fly secrets are injected by the platform when the
# container starts and re-parsed by env.ts at process boot.
RUN DATABASE_URL="postgresql://build:build@build.invalid:5432/build_placeholder?sslmode=require" \
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

USER spectre
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/api/health || exit 1

CMD ["node_modules/.bin/next", "start"]
