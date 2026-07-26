import Link from "next/link";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { isAppError } from "@/lib/errors";
import { startEnrollment, completeEnrollment } from "@/lib/mfa";
import { prisma } from "@/lib/prisma";
import { Badge } from "@/components/Badge";

async function startEnrollAction() {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    const result = await startEnrollment(p);
    cookies().set("spectre_mfa_enroll_secret", result.secret, { httpOnly: true, sameSite: "strict", maxAge: 600 });
    cookies().set("spectre_mfa_enroll_otpauth", result.otpauth, { httpOnly: true, sameSite: "strict", maxAge: 600 });
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/mfa?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/mfa");
}

async function confirmAction(formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    const result = await completeEnrollment(p, String(formData.get("code") ?? ""));
    cookies().set("spectre_mfa_recovery_codes", result.recoveryCodes.join("\n"), { httpOnly: true, sameSite: "strict", maxAge: 600 });
    cookies().delete("spectre_mfa_enroll_secret");
    cookies().delete("spectre_mfa_enroll_otpauth");
  } catch (err) { if (isAppError(err)) redirect(`/app/admin/mfa?error=${encodeURIComponent(err.safeMessage)}`); throw err; }
  revalidatePath("/app/admin/mfa");
}

export default async function MfaPage({ searchParams }: { searchParams: { error?: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  const user = await prisma.user.findUnique({ where: { id: p.id }, include: { mfaFactors: true } });
  const totpFactor = user?.mfaFactors.find((f) => f.kind === "TOTP");

  const enrollSecret = cookies().get("spectre_mfa_enroll_secret")?.value;
  const enrollOtpauth = cookies().get("spectre_mfa_enroll_otpauth")?.value;
  const recoveryCodes = cookies().get("spectre_mfa_recovery_codes")?.value;
  if (recoveryCodes) cookies().delete("spectre_mfa_recovery_codes");

  return (
    <div className="max-w-2xl">
      <h1 className="page-title">Multi-Factor Authentication</h1>
      <p className="mt-1 text-stone-500">Protect your account with a TOTP authenticator (Google Authenticator, 1Password, Authy, etc.).</p>

      {searchParams.error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-6 card card-body">
        <h2 className="section-title text-lg">Current status</h2>
        <div className="mt-2 flex items-center gap-2 text-sm">
          <Badge status={totpFactor?.status ?? "NOT_ENROLLED"} />
          <span>{totpFactor?.status === "ACTIVE" ? "MFA is enabled for your account." : totpFactor?.status === "PENDING" ? "Pending — complete the enrollment below." : "Not enrolled."}</span>
        </div>
      </div>

      {!enrollSecret && totpFactor?.status !== "ACTIVE" && (
        <form action={startEnrollAction} className="mt-6 card card-body">
          <h2 className="section-title text-lg">Enroll TOTP</h2>
          <p className="mt-2 text-sm text-stone-600">Click <em>Start enrollment</em> to generate a secret. Scan the resulting otpauth:// URI into your authenticator app.</p>
          <button className="btn btn-primary mt-3">Start enrollment</button>
        </form>
      )}

      {enrollSecret && enrollOtpauth && (
        <form action={confirmAction} className="mt-6 card card-body space-y-3">
          <h2 className="section-title text-lg">Confirm enrollment</h2>
          <div>
            <div className="text-xs text-stone-500">Secret (base32)</div>
            <code className="block font-mono text-xs break-all bg-stone-50 px-3 py-2 rounded mt-1">{enrollSecret}</code>
          </div>
          <div>
            <div className="text-xs text-stone-500">otpauth URI</div>
            <code className="block font-mono text-xs break-all bg-stone-50 px-3 py-2 rounded mt-1">{enrollOtpauth}</code>
          </div>
          <div><label className="label">Enter the 6-digit code from your app</label><input className="input font-mono" name="code" pattern="\d{6}" required /></div>
          <button className="btn btn-primary">Confirm</button>
        </form>
      )}

      {recoveryCodes && (
        <div className="mt-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm">
          <div className="font-medium text-amber-900">Recovery codes</div>
          <pre className="mt-2 font-mono text-xs bg-white px-3 py-2 rounded border border-amber-200">{recoveryCodes}</pre>
          <div className="mt-2 text-xs text-amber-900">Save these somewhere safe. Each code can be used once if you lose access to your authenticator. They will not be shown again.</div>
        </div>
      )}
    </div>
  );
}

void Link;
