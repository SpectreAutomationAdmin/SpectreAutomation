import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  getDraftByToken,
  addHouseholdMemberToDraft,
  removeHouseholdMemberFromDraft,
} from "@/lib/services/applications";
import { isAppError } from "@/lib/errors";
import { StepIndicator } from "@/components/StepIndicator";

const STEPS = ["Profile", "Membership", "Household", "Review & Submit"];

async function addAction(clubSlug: string, token: string, formData: FormData) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    await addHouseholdMemberToDraft(club.id, token, {
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      relationship: String(formData.get("relationship") ?? "SPOUSE"),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
      notes: String(formData.get("notes") ?? ""),
    });
  } catch (err) {
    if (isAppError(err)) redirect(`/clubs/${clubSlug}/apply/${token}/household?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  revalidatePath(`/clubs/${clubSlug}/apply/${token}/household`);
  redirect(`/clubs/${clubSlug}/apply/${token}/household`);
}

async function removeAction(clubSlug: string, token: string, memberId: string) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    await removeHouseholdMemberFromDraft(club.id, token, memberId);
  } catch (err) {
    if (isAppError(err)) redirect(`/clubs/${clubSlug}/apply/${token}/household?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  redirect(`/clubs/${clubSlug}/apply/${token}/household`);
}

export default async function HouseholdStep({
  params,
  searchParams,
}: {
  params: { clubSlug: string; token: string };
  searchParams: { error?: string };
}) {
  const club = await prisma.club.findUnique({ where: { slug: params.clubSlug }, select: { id: true } });
  if (!club) notFound();
  const row = await getDraftByToken(club.id, params.token);
  if (!row) notFound();
  const add = addAction.bind(null, params.clubSlug, params.token);

  return (
    <>
      <StepIndicator steps={STEPS} current={2} />
      <h1 className="mt-6 page-title">Household</h1>
      <p className="mt-2 text-stone-600">Please share immediate family members who will share your membership privileges.</p>

      {searchParams.error && (
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-8 card overflow-hidden">
        <table className="table-base">
          <thead><tr><th>Name</th><th>Relationship</th><th>Contact</th><th></th></tr></thead>
          <tbody>
            {row.applicant.household.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No household members added yet.</td></tr>
            )}
            {row.applicant.household.map((h) => (
              <tr key={h.id}>
                <td>{h.firstName} {h.lastName}</td>
                <td className="capitalize">{h.relationship.toLowerCase()}</td>
                <td className="text-stone-600 text-xs">{h.email ?? "—"} {h.phone ? `· ${h.phone}` : ""}</td>
                <td className="text-right">
                  <form action={removeAction.bind(null, params.clubSlug, params.token, h.id)} className="inline">
                    <button className="text-xs text-red-600 hover:underline">Remove</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form action={add} className="mt-6 card card-body space-y-4">
        <h2 className="section-title text-lg">Add a household member</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">First name *</label><input className="input" name="firstName" required maxLength={100} /></div>
          <div><label className="label">Last name *</label><input className="input" name="lastName" required maxLength={100} /></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Relationship *</label>
            <select className="select" name="relationship" defaultValue="SPOUSE">
              <option value="SPOUSE">Spouse</option>
              <option value="PARTNER">Partner</option>
              <option value="CHILD">Child</option>
              <option value="OTHER">Other</option>
            </select>
          </div>
          <div><label className="label">Date of birth</label><input type="date" className="input" name="dateOfBirth" /></div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div><label className="label">Email</label><input className="input" type="email" name="email" maxLength={254} /></div>
          <div><label className="label">Phone</label><input className="input" name="phone" maxLength={40} /></div>
        </div>
        <div><label className="label">Notes</label><textarea className="textarea" name="notes" rows={2} maxLength={2000} /></div>
        <div className="flex justify-end">
          <button className="btn btn-secondary">Add to household</button>
        </div>
      </form>

      <div className="mt-8 flex justify-between">
        <a className="btn btn-secondary" href={`/clubs/${params.clubSlug}/apply/${params.token}/membership`}>← Back</a>
        <a className="btn btn-primary" href={`/clubs/${params.clubSlug}/apply/${params.token}/review`}>Continue to review →</a>
      </div>
    </>
  );
}
