import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getCurrentUser } from "@/lib/session";
import { Sidebar } from "@/components/Sidebar";
import { TopBar } from "@/components/TopBar";
import { Toast } from "@/components/Toast";
import { prisma } from "@/lib/prisma";
import { getActiveBranding } from "@/lib/branding";

// Members see their own hub here. Admins are allowed in for demo / preview
// purposes (e.g., walking a prospect through the experience). When admins
// view, the sidebar still shows the member nav — that matches the demo intent.
export default async function MemberLayout({ children }: { children: React.ReactNode }) {
  const branding = await getActiveBranding();
  if (branding.mode === "unknown") redirect("/unknown-domain");

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // Last-resort fallback is a neutral label — members are shielded from
  // the underlying platform brand, so this must never read "Spectre".
  const clubName = branding.mode === "club"
    ? branding.wordmark
    : (user.club?.name ?? (await prisma.club.findFirst({ orderBy: { createdAt: "asc" } }))?.name ?? "Member Portal");

  // Look up the member number only when the signed-in user is an actual
  // member — admins previewing the hub keep their role subline. The
  // lookup is cheap (PK select of a single column).
  const memberNumber = user.memberId
    ? (await prisma.member.findUnique({
        where: { id: user.memberId },
        select: { memberNumber: true },
      }))?.memberNumber ?? null
    : null;

  return (
    <div className="min-h-screen flex bg-stone-50">
      <Sidebar kind="member" clubName={clubName} />
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar
          userName={user.name}
          userRole={user.role}
          memberNumber={memberNumber}
          settingsHref="/app/member/profile"
        />
        <main className="flex-1 px-8 py-8 overflow-x-auto">{children}</main>
        <Suspense fallback={null}><Toast /></Suspense>
      </div>
    </div>
  );
}
