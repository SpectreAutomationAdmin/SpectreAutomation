import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSession, setSession, getCurrentUser } from "@/lib/session";
import { login } from "@/lib/services/auth";
import { isAppError } from "@/lib/errors";
import { getActiveBranding } from "@/lib/branding";

// Production login: validation, lockout, audit-trail-aware, encrypted cookie.
// Any failure renders a generic message — we never reveal whether the email
// exists.
async function loginAction(formData: FormData) {
  "use server";
  const next = String(formData.get("next") ?? "").trim();
  try {
    const { userId } = await login({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
    });
    await setSession({ userId });
  } catch (err) {
    const message = isAppError(err) ? err.safeMessage : "Invalid email or password";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }
  // Route by role.
  const u = await getCurrentUser();
  if (next && next.startsWith("/app/")) redirect(next);
  if (u?.role === "MEMBER") redirect("/app/member");
  redirect("/app/admin");
}

// Demo quick-access shortcut. We deliberately do not bypass lockout — if
// someone has hammered the account in a previous session, the lockout still
// applies. We just skip typing the password.
async function demoLoginAction(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "").toLowerCase();
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) redirect("/login?error=Demo+user+missing");
  // For demo accounts we know the password. In production this entire route
  // would not exist.
  try {
    const { userId } = await login({ email, password: "password" });
    await setSession({ userId });
  } catch (err) {
    const message = isAppError(err) ? err.safeMessage : "Could not sign in demo user";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }
  if (user.role === "MEMBER") redirect("/app/member");
  redirect("/app/admin");
}

export default async function LoginPage({ searchParams }: { searchParams: { error?: string; next?: string } }) {
  const branding = await getActiveBranding();
  if (branding.mode === "unknown") redirect("/unknown-domain");

  // Already signed in? Route straight to the app.
  const session = await getSession();
  if (session.userId) {
    const u = await getCurrentUser();
    if (u) redirect(u.role === "MEMBER" ? "/app/member" : "/app/admin");
  }

  // Demo quick-access is shown on the platform host only. Club domains never
  // see Spectre demo accounts.
  const demos = branding.mode === "platform"
    ? await prisma.user.findMany({
        where: {
          email: { in: ["super@spectre.app", "admin@silversprings.club", "finance@silversprings.club", "member@silversprings.club"] },
          status: "ACTIVE",
        },
        orderBy: { role: "asc" },
      })
    : [];

  const showSpectreBrand = branding.mode === "platform" || !branding.hidePlatformBrand;

  return (
    <main className="min-h-screen flex">
      <div className="flex-1 flex items-center justify-center bg-club-cream px-6 py-12">
        <div className="w-full max-w-md">
          <Link href="/" className="text-xs uppercase tracking-[0.3em] text-club-green-700">{branding.wordmark}</Link>
          <h1 className="mt-2 page-title">Sign in</h1>
          <p className="mt-2 text-sm text-stone-600">
            {branding.mode === "club"
              ? `Welcome back. Sign in to the ${branding.displayName} member portal.`
              : "Welcome back. Sign in to your club workspace."}
          </p>

          {searchParams?.error && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {searchParams.error}
            </div>
          )}

          <form action={loginAction} className="mt-8 space-y-4">
            <input type="hidden" name="next" value={searchParams?.next ?? ""} />
            <div>
              <label className="label">Email</label>
              <input className="input" type="email" name="email" required autoComplete="email" maxLength={254} />
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" name="password" required autoComplete="current-password" maxLength={256} />
            </div>
            <button type="submit" className="btn btn-primary w-full py-2.5">Sign in</button>
          </form>

          {demos.length > 0 && (
            <div className="mt-10 border-t border-stone-200 pt-6">
              <div className="text-xs uppercase tracking-widest text-stone-500 mb-3">Demo quick-access</div>
              <div className="space-y-2">
                {demos.map((d) => (
                  <form key={d.id} action={demoLoginAction}>
                    <input type="hidden" name="email" value={d.email} />
                    <button type="submit" className="w-full text-left rounded-md border border-stone-200 px-3 py-2 hover:bg-white">
                      <div className="text-sm font-medium text-club-ink">{d.name}</div>
                      <div className="text-xs text-stone-500">{d.email} · {d.role.replace(/_/g, " ")}</div>
                    </button>
                  </form>
                ))}
              </div>
              <div className="mt-4 text-xs text-stone-500">All demo accounts use password <code className="font-mono">password</code>.</div>
            </div>
          )}
        </div>
      </div>

      {showSpectreBrand && (
        <div className="hidden md:flex flex-1 bg-club-green-800 text-white items-center justify-center p-12">
          <div className="max-w-md">
            <div className="text-xs uppercase tracking-[0.3em] text-club-green-200">
              {branding.mode === "club" ? branding.displayName : "Spectre Automation"}
            </div>
            <h2 className="mt-4 font-serif text-4xl leading-tight">
              {branding.mode === "club"
                ? `Welcome to the ${branding.displayName} member portal.`
                : "A quietly powerful platform behind your club’s most memorable experiences."}
            </h2>
            {branding.mode === "platform" && (
              <p className="mt-6 text-club-green-100">
                Onboarding. Accounts. Collections. Financing. Events. One operating system, crafted for premium private clubs.
              </p>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
