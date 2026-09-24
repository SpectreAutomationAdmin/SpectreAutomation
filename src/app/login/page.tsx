import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getSession, setSession, getCurrentUser } from "@/lib/session";
import { login } from "@/lib/services/auth";
import { isAppError } from "@/lib/errors";
import { getActiveBranding } from "@/lib/branding";
import { HeroPicture } from "@/components/marketing/AuthPhoto";
import "@/components/marketing/auth.css";

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
  try {
    const { userId } = await login({ email, password: "password" });
    await setSession({ userId });
  } catch (err) {
    const message = isAppError(err) ? err.safeMessage : "Could not sign in demo user";
    redirect(`/login?error=${encodeURIComponent(message)}`);
  }
  if (user!.role === "MEMBER") redirect("/app/member");
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
  const wordmark = branding.wordmark;
  const isPlatform = branding.mode === "platform";

  return (
    <main className="spectre-auth" data-auth="admin">
      <div className="auth-shell">
        {/* Photographic field ------------------------------------------- */}
        <div className="auth-photo">
          <HeroPicture />
          <div className="auth-photo-scrim" aria-hidden="true" />
          <div className="auth-photo-inner">
            <Link href="/" className="auth-photo-brand" aria-label={`${wordmark} home`}>
              {showSpectreBrand ? "SPECTRE / AUTOMATION" : wordmark.toUpperCase()}
            </Link>
            <div>
              <h1 className="auth-photo-heading">
                {isPlatform
                  ? "A quietly powerful platform behind your club’s most memorable experiences."
                  : `Welcome back to the ${branding.displayName} workspace.`}
              </h1>
              {isPlatform && (
                <p className="auth-photo-tag">
                  Onboarding. Accounts. Collections. Financing. Events. One operating system,
                  crafted for premium private clubs.
                </p>
              )}
            </div>
            <Link href="/" className="auth-photo-back">&larr; Back to Spectre</Link>
          </div>
        </div>

        {/* Form field --------------------------------------------------- */}
        <div className="auth-form-field">
          <div className="auth-form-inner">
            <div className="auth-eyebrow">Sign in</div>
            <h2 className="auth-heading">
              {isPlatform
                ? "Welcome back."
                : `Sign in to ${branding.displayName}.`}
            </h2>
            <p className="auth-lead">
              {isPlatform
                ? "Enter the email and password associated with your Spectre workspace."
                : `Enter the email and password associated with your ${branding.displayName} workspace.`}
            </p>

            {searchParams?.error && (
              <div className="auth-error" role="alert">
                {searchParams.error}
              </div>
            )}

            <form action={loginAction} className="auth-form">
              <input type="hidden" name="next" value={searchParams?.next ?? ""} />
              <div className="auth-field">
                <label className="auth-label" htmlFor="admin-login-email">Email</label>
                <input
                  id="admin-login-email"
                  className="auth-input"
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  maxLength={254}
                />
              </div>
              <div className="auth-field">
                <label className="auth-label" htmlFor="admin-login-password">Password</label>
                <input
                  id="admin-login-password"
                  className="auth-input"
                  type="password"
                  name="password"
                  required
                  autoComplete="current-password"
                  maxLength={256}
                />
              </div>
              <button type="submit" className="auth-submit">Sign in to Spectre</button>
            </form>

            <div className="auth-utility">
              <Link href="/employee/login">Employee Portal</Link>
              <span className="auth-utility-muted">
                Need access? <a href="mailto:hello@spectreautomation.com?subject=Spectre%20access">Contact us</a>
              </span>
            </div>

            {demos.length > 0 && (
              <div className="auth-demos">
                <div className="auth-demos-title">Demo quick-access</div>
                <div>
                  {demos.map((d) => (
                    <form key={d.id} action={demoLoginAction}>
                      <input type="hidden" name="email" value={d.email} />
                      <button type="submit" className="auth-demo">
                        <div className="auth-demo-name">{d.name}</div>
                        <div className="auth-demo-meta">{d.email} &middot; {d.role.replace(/_/g, " ")}</div>
                      </button>
                    </form>
                  ))}
                </div>
                <div className="auth-demos-note">
                  All demo accounts use password <code>password</code>.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
