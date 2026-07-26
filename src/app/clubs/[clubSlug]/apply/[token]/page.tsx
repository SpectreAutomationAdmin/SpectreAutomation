import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getDraftByToken, saveDraft } from "@/lib/services/applications";
import { isAppError } from "@/lib/errors";
import { StepIndicator } from "@/components/StepIndicator";

// Step 0 (Profile) — resume entry point: GET /clubs/[slug]/apply/[token]
// Shows the profile form pre-filled with whatever the draft already has.

const STEPS = ["Profile", "Membership", "Household", "Review & Submit"];

async function saveAction(clubSlug: string, token: string, formData: FormData) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    await saveDraft(club.id, token, {
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      address1: String(formData.get("address1") ?? ""),
      address2: String(formData.get("address2") ?? ""),
      city: String(formData.get("city") ?? ""),
      provinceState: String(formData.get("provinceState") ?? ""),
      postalCode: String(formData.get("postalCode") ?? ""),
      country: String(formData.get("country") ?? "Canada"),
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    });
  } catch (err) {
    if (isAppError(err)) redirect(`/clubs/${clubSlug}/apply/${token}?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  redirect(`/clubs/${clubSlug}/apply/${token}/membership`);
}

export default async function ApplyResumePage({
  params,
  searchParams,
}: {
  params: { clubSlug: string; token: string };
  searchParams: { error?: string };
}) {
  const club = await prisma.club.findUnique({ where: { slug: params.clubSlug }, select: { id: true, name: true } });
  if (!club) notFound();
  const row = await getDraftByToken(club.id, params.token);
  if (!row) notFound();
  const a = row.applicant;
  const action = saveAction.bind(null, params.clubSlug, params.token);
  const dob = a.dateOfBirth ? a.dateOfBirth.toISOString().slice(0, 10) : "";

  return (
    <>
      <StepIndicator steps={STEPS} current={0} />
      <h1 className="mt-6 page-title">Welcome back, {a.firstName}.</h1>
      <p className="mt-2 text-stone-600">
        Your application has been saved. Continue where you left off — you can leave and return at any time.
      </p>

      {a.applicationStatus === "PENDING_INFORMATION" && a.pendingInfoNote && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-medium">We&rsquo;ve asked for a little more information:</div>
          <p className="mt-1">{a.pendingInfoNote}</p>
        </div>
      )}

      {searchParams.error && (
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={action} className="mt-8 card card-body space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">First name *</label><input className="input" name="firstName" required defaultValue={a.firstName} maxLength={100} /></div>
          <div><label className="label">Last name *</label><input className="input" name="lastName" required defaultValue={a.lastName} maxLength={100} /></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">Email *</label><input type="email" className="input" name="email" required defaultValue={a.email} maxLength={254} /></div>
          <div><label className="label">Phone</label><input className="input" name="phone" defaultValue={a.phone ?? ""} maxLength={40} /></div>
        </div>
        <div><label className="label">Date of birth</label><input type="date" className="input" name="dateOfBirth" defaultValue={dob} /></div>
        <div><label className="label">Address line 1</label><input className="input" name="address1" defaultValue={a.address1 ?? ""} maxLength={200} /></div>
        <div><label className="label">Address line 2</label><input className="input" name="address2" defaultValue={a.address2 ?? ""} maxLength={200} /></div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div><label className="label">City</label><input className="input" name="city" defaultValue={a.city ?? ""} maxLength={100} /></div>
          <div><label className="label">Province / State</label><input className="input" name="provinceState" defaultValue={a.provinceState ?? ""} maxLength={100} /></div>
          <div><label className="label">Postal / Zip</label><input className="input" name="postalCode" defaultValue={a.postalCode ?? ""} maxLength={20} /></div>
        </div>
        <div><label className="label">Country</label><input className="input" name="country" defaultValue={a.country ?? "Canada"} maxLength={80} /></div>
        <div className="pt-3 flex justify-end">
          <button type="submit" className="btn btn-primary">Save and continue →</button>
        </div>
      </form>
    </>
  );
}
