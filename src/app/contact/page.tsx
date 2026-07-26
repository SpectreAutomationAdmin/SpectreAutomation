import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getActiveBranding } from "@/lib/branding";
import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow } from "@/components/club-public/sections";

async function submitContactAction(formData: FormData) {
  "use server";
  const branding = await getActiveBranding();
  if (branding.mode !== "club" || !branding.clubId) {
    redirect("/contact?error=Club+not+resolved");
  }
  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const subject = String(formData.get("subject") ?? "").trim() || "General inquiry";
  const message = String(formData.get("message") ?? "").trim();
  if (!name || !email || !message) {
    redirect("/contact?error=Please+provide+your+name%2C+email%2C+and+message");
  }
  if (!email.includes("@")) redirect("/contact?error=Please+provide+a+valid+email");
  await prisma.clubAnnouncement.create({
    data: {
      clubId: branding.clubId!,
      title: `[Contact] ${subject} — ${name}`,
      body: `From: ${name} <${email}>\n\n${message}`,
      audience: "INTERNAL_STAFF",
    },
  });
  revalidatePath("/contact");
  redirect("/contact?ok=1");
}

export default async function ContactPage({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  const branding = await getActiveBranding();
  const club = branding.clubId
    ? await prisma.club.findUnique({
        where: { id: branding.clubId },
        select: { name: true, wordmark: true, address: true, region: true },
      })
    : null;
  const wordmark = club?.wordmark ?? club?.name ?? "Silver Springs";

  return (
    <PublicClubLayout>
      <section className="bg-club-cream">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-24">
          <MarketingEyebrow>Contact</MarketingEyebrow>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight max-w-3xl">
            Get in touch with {wordmark}.
          </h1>
          <p className="mt-5 max-w-2xl text-stone-600 leading-relaxed text-lg">
            Whether you&rsquo;re thinking about membership, planning an event, or
            simply have a question, we&rsquo;d be glad to hear from you.
          </p>
        </div>
      </section>

      <section className="bg-white border-y border-club-stone">
        <div className="max-w-7xl mx-auto px-6 md:px-10 py-16 grid md:grid-cols-3 gap-10">
          <div>
            <MarketingEyebrow>Visit</MarketingEyebrow>
            {club?.address ? (
              <address className="not-italic mt-3 text-stone-700 leading-relaxed">
                {club.address.split(",").map((line, i) => <div key={i}>{line.trim()}</div>)}
              </address>
            ) : null}
          </div>
          <div>
            <MarketingEyebrow>Hours</MarketingEyebrow>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
              <dt className="text-stone-500">Course</dt><dd className="text-club-ink text-right">Dawn – Dusk (in season)</dd>
              <dt className="text-stone-500">Pro Shop</dt><dd className="text-club-ink text-right">7am – 7pm</dd>
              <dt className="text-stone-500">Clubhouse</dt><dd className="text-club-ink text-right">9am – 11pm</dd>
              <dt className="text-stone-500">Trackman</dt><dd className="text-club-ink text-right">7am – 11pm daily</dd>
            </dl>
          </div>
          <div>
            <MarketingEyebrow>Reach us</MarketingEyebrow>
            <p className="mt-3 text-stone-700 text-sm leading-relaxed">
              For specific departments — membership, events, the Pro Shop —
              please use the form opposite and we&rsquo;ll route your note to the
              right team.
            </p>
          </div>
        </div>
      </section>

      <section>
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-20">
          {searchParams.ok ? (
            <div className="mb-8 rounded-md border border-club-green-200 bg-club-green-50 px-4 py-3 text-sm text-club-green-800">
              Thank you — your note is on its way to the right team. We typically
              respond within two business days.
            </div>
          ) : null}
          {searchParams.error ? (
            <div className="mb-8 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {searchParams.error}
            </div>
          ) : null}

          <form action={submitContactAction} className="bg-white border border-club-stone rounded-2xl p-8 shadow-card space-y-5">
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="name">Your name</label>
                <input id="name" name="name" required maxLength={120} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="email">Email</label>
                <input id="email" name="email" type="email" required maxLength={254} className="input" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="subject">Subject</label>
              <select id="subject" name="subject" className="input">
                <option>General inquiry</option>
                <option>Membership</option>
                <option>Events &amp; catering</option>
                <option>Pro Shop</option>
                <option>Lost &amp; found</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="message">Your note</label>
              <textarea id="message" name="message" required rows={6} maxLength={4000} className="input"></textarea>
            </div>
            <div className="pt-1">
              <button type="submit" className="inline-flex items-center justify-center rounded-md bg-club-green-700 text-white px-6 py-3 text-sm font-medium tracking-wide hover:bg-club-green-800">
                Send message
              </button>
            </div>
          </form>
        </div>
      </section>
    </PublicClubLayout>
  );
}
