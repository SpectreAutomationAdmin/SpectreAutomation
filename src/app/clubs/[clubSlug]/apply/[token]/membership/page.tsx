import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getDraftByToken, saveDraft } from "@/lib/services/applications";
import { isAppError } from "@/lib/errors";
import { StepIndicator } from "@/components/StepIndicator";

const STEPS = ["Profile", "Membership", "Household", "Review & Submit"];

async function saveAction(clubSlug: string, token: string, formData: FormData) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    await saveDraft(club.id, token, {
      sponsorName: String(formData.get("sponsorName") ?? ""),
      membershipCategory: String(formData.get("membershipCategory") ?? ""),
      employmentInfo: String(formData.get("employmentInfo") ?? ""),
      referralSource: String(formData.get("referralSource") ?? ""),
    });
  } catch (err) {
    if (isAppError(err)) redirect(`/clubs/${clubSlug}/apply/${token}/membership?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  redirect(`/clubs/${clubSlug}/apply/${token}/household`);
}

export default async function MembershipStep({
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

  return (
    <>
      <StepIndicator steps={STEPS} current={1} />
      <h1 className="mt-6 page-title">Membership preferences</h1>
      <p className="mt-2 text-stone-600">Help us understand your interest in {club.name}.</p>

      {searchParams.error && (
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <form action={action} className="mt-8 card card-body space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Membership category *</label>
            <select className="select" name="membershipCategory" defaultValue={a.membershipCategory ?? "Full Golf"} required>
              <option>Full Golf</option>
              <option>Intermediate</option>
              <option>Senior Golf</option>
              <option>Social</option>
              <option>Corporate</option>
            </select>
          </div>
          <div>
            <label className="label">Sponsor (member name)</label>
            <input className="input" name="sponsorName" defaultValue={a.sponsorName ?? ""} maxLength={120} />
          </div>
        </div>
        <div>
          <label className="label">Employment information</label>
          <textarea className="textarea" name="employmentInfo" defaultValue={a.employmentInfo ?? ""} rows={3} maxLength={2000} placeholder="Title, employer, industry" />
        </div>
        <div>
          <label className="label">How did you hear about us?</label>
          <input className="input" name="referralSource" defaultValue={a.referralSource ?? ""} maxLength={200} placeholder="Member referral, event, search…" />
        </div>
        <div className="pt-3 flex justify-between">
          <a href={`/clubs/${params.clubSlug}/apply/${params.token}`} className="btn btn-secondary">← Back</a>
          <button type="submit" className="btn btn-primary">Save and continue →</button>
        </div>
      </form>
    </>
  );
}
