import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

// The welcome flow (onboarding timeline + preferences) is rendered full-bleed
// for an intentionally cinematic feel — no sidebar or top bar. Any authenticated
// user can view it; the page resolves which member to feature.
export default async function WelcomeLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <div className="min-h-screen bg-club-green-900">{children}</div>;
}
