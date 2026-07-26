import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

// Every /app/** route requires a session. Role-specific gating happens in
// /app/admin/layout.tsx and /app/member/layout.tsx.
export default async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <>{children}</>;
}
