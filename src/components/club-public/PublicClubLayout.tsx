import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveBranding } from "@/lib/branding";
import { ClubHeader } from "./ClubHeader";
import { ClubFooter } from "./ClubFooter";

// Shared wrapper used by every Silver-Springs-style public page.
//
// - Club mode  → renders the public chrome (header + footer) around children.
// - Platform   → redirects to the platform marketing page at /.
// - Unknown    → redirects to /unknown-domain (Phase 15 safe error page).
//
// Pages MUST pass their own `children` element. The wrapper loads the club
// record on the server so we don't render the chrome with stale wordmark.
export async function PublicClubLayout({
  children,
  // Tell the layout NOT to redirect platform-mode visitors away. The home
  // page uses this so it can render the Spectre marketing copy when the
  // request lands on the platform host. Every other public page leaves this
  // false so accidental hits on localhost go back to the platform site.
  allowPlatform = false,
}: {
  children: React.ReactNode;
  allowPlatform?: boolean;
}) {
  const branding = await getActiveBranding();
  if (branding.mode === "unknown") redirect("/unknown-domain");
  if (branding.mode === "platform" && !allowPlatform) redirect("/");
  if (branding.mode === "platform") {
    // Returning null here would render nothing; we expect home to short-circuit
    // before calling this when platform mode is allowed.
    return <>{children}</>;
  }
  const club = branding.clubId
    ? await prisma.club.findUnique({
        where: { id: branding.clubId },
        select: { name: true, wordmark: true, address: true, foundedYear: true },
      })
    : null;
  const wordmark = club?.wordmark ?? club?.name ?? branding.displayName;
  return (
    <div className="bg-club-cream text-club-ink min-h-screen flex flex-col">
      <ClubHeader wordmark={wordmark} foundedYear={club?.foundedYear ?? null} />
      <main className="flex-1">{children}</main>
      <ClubFooter wordmark={wordmark} address={club?.address ?? null} foundedYear={club?.foundedYear ?? null} />
    </div>
  );
}
