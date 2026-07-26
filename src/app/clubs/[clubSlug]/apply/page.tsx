import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { createDraft } from "@/lib/services/applications";
import { isAppError } from "@/lib/errors";

// Public step-1 entry point. Captures the minimum to create a DRAFT
// applicant and returns a resume token (we redirect to /apply/[token]/...).
async function startAction(clubSlug: string, formData: FormData) {
  "use server";
  const club = await prisma.club.findUnique({ where: { slug: clubSlug }, select: { id: true } });
  if (!club) redirect(`/`);
  try {
    const { token } = await createDraft(club.id, {
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
    redirect(`/clubs/${clubSlug}/apply/${token}/membership`);
  } catch (err) {
    if (isAppError(err)) {
      redirect(`/clubs/${clubSlug}/apply?error=${encodeURIComponent(err.safeMessage)}`);
    }
    throw err;
  }
}

export default async function ApplyStartPage({
  params,
  searchParams,
}: {
  params: { clubSlug: string };
  searchParams: { error?: string };
}) {
  const club = await prisma.club.findUnique({ where: { slug: params.clubSlug } });
  if (!club) notFound();
  const action = startAction.bind(null, params.clubSlug);

  return (
    <main className="min-h-screen bg-club-cream">
      <header className="px-8 py-6 border-b border-stone-200 bg-white">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link href="/" className="text-xs uppercase tracking-[0.3em] text-club-green-700">Spectre</Link>
          <div className="text-sm text-stone-500">{club.name}</div>
        </div>
      </header>

      <section className="max-w-3xl mx-auto px-8 py-14">
        <div className="text-xs uppercase tracking-[0.3em] text-club-green-700">Membership Application · Step 1 of 4</div>
        <h1 className="mt-3 page-title">Apply to {club.name}</h1>
        <p className="mt-3 text-stone-600 max-w-2xl">
          We are honoured by your interest. Let&rsquo;s begin with how to reach you. You&rsquo;ll be able to save your progress
          and continue later from any device.
        </p>

        {searchParams.error && (
          <div className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{searchParams.error}</div>
        )}

        <form action={action} className="mt-10 card card-body space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="label">First name *</label><input className="input" name="firstName" required maxLength={100} /></div>
            <div><label className="label">Last name *</label><input className="input" name="lastName" required maxLength={100} /></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><label className="label">Email *</label><input type="email" className="input" name="email" required maxLength={254} /></div>
            <div><label className="label">Phone</label><input className="input" name="phone" maxLength={40} /></div>
          </div>
          <div>
            <label className="label">Date of birth</label>
            <input type="date" className="input" name="dateOfBirth" />
          </div>
          <div>
            <label className="label">Address line 1</label>
            <input className="input" name="address1" maxLength={200} />
          </div>
          <div>
            <label className="label">Address line 2</label>
            <input className="input" name="address2" maxLength={200} />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div><label className="label">City</label><input className="input" name="city" maxLength={100} /></div>
            <div><label className="label">Province / State</label><input className="input" name="provinceState" maxLength={100} /></div>
            <div><label className="label">Postal / Zip</label><input className="input" name="postalCode" maxLength={20} /></div>
          </div>
          <div>
            <label className="label">Country</label>
            <input className="input" name="country" defaultValue="Canada" maxLength={80} />
          </div>
          <div className="pt-2 flex items-center justify-between">
            <p className="text-xs text-stone-500 max-w-md">
              By continuing, you acknowledge that the information you provide will be reviewed by our membership committee.
            </p>
            <button type="submit" className="btn btn-primary px-6 py-2.5">Save and continue →</button>
          </div>
        </form>
      </section>
    </main>
  );
}
