import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getDraftByToken, submitDraft, withdrawDraft } from "@/lib/services/applications";
import { isAppError } from "@/lib/errors";
import { StepIndicator } from "@/components/StepIndicator";
import { formatDate } from "@/lib/finance";

const STEPS = ["Profile", "Membership", "Household", "Review & Submit"];

async function submitAction(clubSlug: string, token: string, formData: FormData) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    const applicant = await submitDraft(club.id, token, {
      consentCreditCheck: formData.get("consentCreditCheck") === "on",
      consentBackgroundCheck: formData.get("consentBackgroundCheck") === "on",
    });
    redirect(`/clubs/${clubSlug}/apply/confirmation?ref=${applicant.id}`);
  } catch (err) {
    if (isAppError(err)) redirect(`/clubs/${clubSlug}/apply/${token}/review?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
}

async function withdrawAction(clubSlug: string, token: string, formData: FormData) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    await withdrawDraft(club.id, token, String(formData.get("reason") ?? ""));
  } catch (err) {
    if (isAppError(err)) redirect(`/clubs/${clubSlug}/apply/${token}/review?error=${encodeURIComponent(err.safeMessage)}`);
    throw err;
  }
  redirect("/");
}

export default async function ReviewStep({
  params,
  searchParams,
}: {
  params: { clubSlug: string; token: string };
  searchParams: { error?: string };
}) {
  const club = await prisma.club.findUnique({ where: { slug: params.clubSlug } });
  if (!club) notFound();
  const row = await getDraftByToken(club.id, params.token);
  if (!row) notFound();
  const a = row.applicant;
  const submit = submitAction.bind(null, params.clubSlug, params.token);
  const withdraw = withdrawAction.bind(null, params.clubSlug, params.token);

  return (
    <>
      <StepIndicator steps={STEPS} current={3} />
      <h1 className="mt-6 page-title">Review &amp; submit</h1>
      <p className="mt-2 text-stone-600">Please review your application carefully before submitting.</p>

      {searchParams.error && (
        <div className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
      )}

      <div className="mt-8 space-y-6">
        <Section title="Profile" editHref={`/clubs/${params.clubSlug}/apply/${params.token}`}>
          <Field label="Name">{a.firstName} {a.lastName}</Field>
          <Field label="Email">{a.email}</Field>
          <Field label="Phone">{a.phone ?? "—"}</Field>
          <Field label="Date of birth">{formatDate(a.dateOfBirth)}</Field>
          <Field label="Address">
            {[a.address1, a.address2, [a.city, a.provinceState].filter(Boolean).join(", "), [a.postalCode, a.country].filter(Boolean).join(" · ")].filter(Boolean).join(" · ") || "—"}
          </Field>
        </Section>

        <Section title="Membership" editHref={`/clubs/${params.clubSlug}/apply/${params.token}/membership`}>
          <Field label="Category">{a.membershipCategory ?? "—"}</Field>
          <Field label="Sponsor">{a.sponsorName ?? "—"}</Field>
          <Field label="Referral source">{a.referralSource ?? "—"}</Field>
          <Field label="Employment">{a.employmentInfo ?? "—"}</Field>
        </Section>

        <Section title="Household" editHref={`/clubs/${params.clubSlug}/apply/${params.token}/household`}>
          {a.household.length === 0 ? (
            <p className="text-sm text-stone-500">No household members.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {a.household.map((h) => (
                <li key={h.id}>
                  <span className="font-medium">{h.firstName} {h.lastName}</span>
                  <span className="text-stone-500"> · {h.relationship.toLowerCase()}{h.email ? ` · ${h.email}` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <form action={submit} className="mt-8 card card-body space-y-3">
        <h3 className="font-medium">Consents</h3>
        <label className="flex items-start gap-3 text-sm text-stone-700">
          <input type="checkbox" name="consentCreditCheck" className="mt-1" required />
          <span>I consent to a credit check as part of this application.</span>
        </label>
        <label className="flex items-start gap-3 text-sm text-stone-700">
          <input type="checkbox" name="consentBackgroundCheck" className="mt-1" required />
          <span>I consent to a background check as part of this application.</span>
        </label>
        <p className="text-xs text-stone-500">
          By submitting you confirm the information provided is accurate to the best of your knowledge. Your IP address and
          browser will be recorded for our records.
        </p>
        <div className="flex justify-between items-center pt-2">
          <a className="text-sm text-stone-500 hover:underline" href={`/clubs/${params.clubSlug}/apply/${params.token}/household`}>← Back to household</a>
          <button type="submit" className="btn btn-primary px-6">Submit application</button>
        </div>
      </form>

      <details className="mt-10 text-sm">
        <summary className="text-stone-500 cursor-pointer">Withdraw this application</summary>
        <form action={withdraw} className="mt-3 card card-body space-y-3">
          <p className="text-sm text-stone-600">If you no longer wish to apply, you can withdraw. The club will keep this on file but will not proceed with review.</p>
          <textarea name="reason" className="textarea" rows={2} placeholder="Reason (optional)" maxLength={2000} />
          <button className="btn btn-secondary">Withdraw application</button>
        </form>
      </details>
    </>
  );
}

function Section({ title, editHref, children }: { title: string; editHref: string; children: React.ReactNode }) {
  return (
    <div className="card card-body">
      <div className="flex items-center justify-between">
        <h2 className="section-title text-lg">{title}</h2>
        <a href={editHref} className="text-xs text-club-green-700 hover:underline">Edit</a>
      </div>
      <dl className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">{children}</dl>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-stone-500">{label}</dt>
      <dd className="mt-0.5 text-club-ink">{children}</dd>
    </div>
  );
}
