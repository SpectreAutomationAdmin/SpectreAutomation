// White-label custom-domain tenant resolver.
//
// Three resolution outcomes for any inbound host:
//
//   { mode: "platform" }          — Spectre platform host (or local dev).
//                                   No club pinned. SUPER_ADMIN-only pages
//                                   are reachable.
//
//   { mode: "club", clubId, … }   — host matches an ACTIVE `ClubDomain` row.
//                                   Club is pinned for the request.
//
//   { mode: "unknown" }           — host is neither. Layout redirects to
//                                   /unknown-domain.
//
// Hostname matching is exact + case-insensitive. The port is stripped so
// `silversprings.club:443` matches `silversprings.club`. Subdomains do NOT
// match each other (e.g. `members.silversprings.club` requires its own row).

import { prisma } from "../prisma";
import { env } from "../env";

export type ResolveResult =
  | { mode: "platform" }
  | { mode: "club"; clubId: string; clubSlug: string; domainKind: string; domainId: string; isWhitelabel: boolean }
  | { mode: "unknown"; hostname: string };

const LOCAL_DEV_SUFFIXES = [".localtest.me", ".localhost"];
const LOCAL_DEV_EXACT = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export function normalizeHost(rawHost: string | null | undefined): string {
  if (!rawHost) return "";
  // Strip port + trailing dots, lowercase.
  return rawHost.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

export function isPlatformHost(host: string): boolean {
  const configured = env.SPECTRE_PLATFORM_HOST?.toLowerCase();
  if (configured && host === configured) return true;
  if (LOCAL_DEV_EXACT.has(host)) return true;
  if (LOCAL_DEV_SUFFIXES.some((s) => host.endsWith(s))) {
    // *.localtest.me with no SPECTRE_LOCAL_PIN_CLUB_SLUG override is platform.
    return !env.SPECTRE_LOCAL_PIN_CLUB_SLUG;
  }
  return false;
}

// Local-dev convenience: a SUPER_ADMIN can pin themselves to a specific club
// by setting SPECTRE_LOCAL_PIN_CLUB_SLUG. This bypasses the host check
// entirely and is only honored when the host is also local-dev.
async function localPinnedResolution(host: string): Promise<ResolveResult | null> {
  const slug = env.SPECTRE_LOCAL_PIN_CLUB_SLUG;
  if (!slug) return null;
  const isLocal = LOCAL_DEV_EXACT.has(host) || LOCAL_DEV_SUFFIXES.some((s) => host.endsWith(s));
  if (!isLocal) return null;
  const club = await prisma.club.findUnique({ where: { slug }, select: { id: true, slug: true, whitelabelEnabled: true } });
  if (!club) return null;
  return {
    mode: "club", clubId: club.id, clubSlug: club.slug,
    domainKind: "PRIMARY", domainId: "local-pin", isWhitelabel: club.whitelabelEnabled,
  };
}

export async function resolveClubByHost(rawHost: string | null | undefined): Promise<ResolveResult> {
  const host = normalizeHost(rawHost);
  if (!host) return { mode: "unknown", hostname: "" };

  // 1. Explicit platform host always wins.
  const configuredPlatform = env.SPECTRE_PLATFORM_HOST?.toLowerCase();
  if (configuredPlatform && host === configuredPlatform) return { mode: "platform" };

  // 2. Exact-localhost (no host suffix games) is platform unless a pin is set.
  if (LOCAL_DEV_EXACT.has(host)) {
    const pinned = await localPinnedResolution(host);
    if (pinned) return pinned;
    return { mode: "platform" };
  }

  // 3. Explicit ClubDomain row wins over implicit local-dev fallback. This
  //    is what lets `silver-springs.localtest.me` resolve to the seeded
  //    club row even though it ends with a local-dev suffix.
  const match = await prisma.clubDomain.findUnique({
    where: { hostname: host },
    include: { club: { select: { id: true, slug: true, whitelabelEnabled: true } } },
  });
  if (match && match.status === "ACTIVE") {
    return {
      mode: "club",
      clubId: match.clubId,
      clubSlug: match.club.slug,
      domainKind: match.kind,
      domainId: match.id,
      isWhitelabel: match.club.whitelabelEnabled,
    };
  }

  // 4. Local-dev suffix with no DB match → platform (handy for ad-hoc
  //    `tunnel.localtest.me` tinkering during development).
  if (LOCAL_DEV_SUFFIXES.some((s) => host.endsWith(s))) {
    const pinned = await localPinnedResolution(host);
    if (pinned) return pinned;
    return { mode: "platform" };
  }

  // 5. Non-local host with no ACTIVE ClubDomain match → unknown (404 / safe
  //    error page in production).
  return { mode: "unknown", hostname: host };
}

// Server-side helper to read the host stamped by middleware. Falls back to
// the raw Host header if middleware hasn't run (e.g. test harness).
export function getRequestHost(headerBag: Headers | undefined | null): string {
  if (!headerBag) return "";
  return normalizeHost(headerBag.get("x-spectre-host") ?? headerBag.get("host"));
}

// Slug-based fallback used by the legacy `/clubs/[clubSlug]/apply` route.
// Keep this intentional — it's the public apply flow, which has always been
// slug-routed and should remain so.
export async function resolveClubBySlug(slug: string) {
  return prisma.club.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, wordmark: true, logoUrl: true, primaryColor: true, whitelabelEnabled: true },
  });
}
