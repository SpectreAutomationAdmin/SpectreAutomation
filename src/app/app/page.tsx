import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

// Simple router: route logged-in user to admin or member home.
export default async function AppEntry() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(user.role === "MEMBER" ? "/app/member" : "/app/admin");
}
