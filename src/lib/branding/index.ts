// Per-request branding resolution.
//
// `getActiveBranding()` is the single read used by every layout, the login
// page, and any header/footer chrome that needs club-specific text.
//
// Resolution mirrors `getActiveClubId`:
//   1. If middleware stamped a club host, resolve to that club.
//   2. Otherwise return PLATFORM branding (Spectre wordmark).
//
// Layouts must call this in a Server Component — `headers()` only works in
// the request context.

import { headers } from "next/headers";
import { prisma } from "../prisma";
import { resolveClubByHost } from "../tenant-resolver";

export type Branding = {
  mode: "platform" | "club" | "unknown";
  hostname: string;
  // Always populated. Falls back to "Spectre" in platform mode.
  displayName: string;
  // Visible wordmark in nav. "Spectre" on the platform host; the club's
  // wordmark (or name) on a club host.
  wordmark: string;
  logoUrl: string | null;
  primaryColor: string;
  // True when the club has opted in to white-label (default true). When
  // true, the platform footer / "Powered by Spectre" mark is HIDDEN.
  hidePlatformBrand: boolean;
  // Populated only in `mode === "club"`.
  clubId: string | null;
  clubSlug: string | null;
  domainKind: string | null;
};

const PLATFORM_BRANDING: Branding = {
  mode: "platform",
  hostname: "",
  displayName: "Spectre Automation",
  wordmark: "Spectre",
  logoUrl: null,
  primaryColor: "#2f5832",
  hidePlatformBrand: false,
  clubId: null,
  clubSlug: null,
  domainKind: null,
};

export async function getActiveBranding(): Promise<Branding> {
  let host = "";
  try {
    const h = headers();
    host = h.get("x-spectre-host") ?? h.get("host") ?? "";
  } catch {
    return PLATFORM_BRANDING;
  }
  const resolved = await resolveClubByHost(host);
  if (resolved.mode === "platform") return { ...PLATFORM_BRANDING, hostname: host };
  if (resolved.mode === "unknown") {
    return { ...PLATFORM_BRANDING, mode: "unknown", hostname: resolved.hostname };
  }
  const club = await prisma.club.findUnique({
    where: { id: resolved.clubId },
    select: { id: true, slug: true, name: true, wordmark: true, logoUrl: true, primaryColor: true, whitelabelEnabled: true },
  });
  if (!club) return { ...PLATFORM_BRANDING, hostname: host };
  const displayName = club.wordmark ?? club.name;
  return {
    mode: "club",
    hostname: host,
    displayName,
    wordmark: displayName,
    logoUrl: club.logoUrl,
    primaryColor: club.primaryColor,
    hidePlatformBrand: club.whitelabelEnabled,
    clubId: club.id,
    clubSlug: club.slug,
    domainKind: resolved.domainKind,
  };
}

// Guard for platform-only routes. Redirect target is /app/admin so we don't
// expose a 404 (which would confirm the route exists). Returns void on
// allowed; throws via `redirect()` on club host.
export async function assertPlatformHost() {
  const branding = await getActiveBranding();
  if (branding.mode === "platform") return;
  // Imported lazily to avoid pulling next/navigation into every consumer.
  const { redirect } = await import("next/navigation");
  redirect("/app/admin");
}
