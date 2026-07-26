import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getActiveBranding } from "@/lib/branding";
import { PublicClubLayout } from "@/components/club-public/PublicClubLayout";
import { MarketingEyebrow } from "@/components/club-public/sections";

// Inquiry POST handler. Persists the inquiry as a ClubAnnouncement of kind
// "EVENT_INQUIRY" — the simplest existing audit-friendly table for an
// inbound message. Phase 16 should give event inquiries their own model.
async function submitInquiryAction(formData: FormData) {
  "use server";
  const branding = await getActiveBranding();
  if (branding.mode !== "club" || !branding.clubId) {
    redirect("/events/request?error=Club+not+resolved");
  }

  const name = String(formData.get("name") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();
  const eventType = String(formData.get("eventType") ?? "").trim();
  const eventDate = String(formData.get("eventDate") ?? "").trim();
  const guestCount = parseInt(String(formData.get("guestCount") ?? "0"), 10) || 0;
  const message = String(formData.get("message") ?? "").trim();

  if (!name || !email || !eventType) {
    redirect("/events/request?error=Please+provide+your+name%2C+email%2C+and+event+type");
  }
  if (!email.includes("@")) {
    redirect("/events/request?error=Please+provide+a+valid+email");
  }

  // Persist. ClubAnnouncement has clubId + title + body + kind; we use it as
  // a simple inbox while a real EventInquiry model is on the backlog.
  const inquiryBody = [
    `From: ${name} <${email}>`,
    phone ? `Phone: ${phone}` : null,
    `Event type: ${eventType}`,
    eventDate ? `Event date: ${eventDate}` : null,
    guestCount ? `Guest count: ${guestCount}` : null,
    "",
    "Message:",
    message || "(no message provided)",
  ].filter(Boolean).join("\n");
  await prisma.clubAnnouncement.create({
    data: {
      clubId: branding.clubId!,
      title: `[Event Inquiry] ${eventType} — ${name}`,
      body: inquiryBody,
      audience: "INTERNAL_STAFF",
    },
  });

  cookies().set("ss_event_request_ok", "1", { httpOnly: false, sameSite: "lax", maxAge: 30 });
  revalidatePath("/events/request");
  redirect("/events/request?ok=1");
}

export default async function EventRequestPage({ searchParams }: { searchParams: { ok?: string; error?: string } }) {
  return (
    <PublicClubLayout>
      <section className="bg-club-cream">
        <div className="max-w-3xl mx-auto px-6 md:px-10 py-20">
          <MarketingEyebrow>Event request</MarketingEyebrow>
          <h1 className="mt-3 font-serif text-4xl md:text-5xl leading-tight">Tell us about your event.</h1>
          <p className="mt-5 text-stone-600 leading-relaxed text-lg">
            Fill out the form below and our events team will be in touch within
            two business days to arrange a tour and a walk-through of menus
            and dates. There&rsquo;s no obligation.
          </p>

          {searchParams.ok ? (
            <div className="mt-8 rounded-md border border-club-green-200 bg-club-green-50 px-4 py-3 text-sm text-club-green-800">
              Thank you — we&rsquo;ve received your inquiry. Our events team will
              be in touch within two business days. A copy is logged in the
              club&rsquo;s admin inbox.
            </div>
          ) : null}
          {searchParams.error ? (
            <div className="mt-8 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {searchParams.error}
            </div>
          ) : null}

          <form action={submitInquiryAction} className="mt-10 bg-white border border-club-stone rounded-2xl p-8 shadow-card space-y-5">
            <div className="grid md:grid-cols-2 gap-5">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="name">Your name</label>
                <input id="name" name="name" required maxLength={120} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="email">Email</label>
                <input id="email" name="email" type="email" required maxLength={254} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="phone">Phone (optional)</label>
                <input id="phone" name="phone" type="tel" maxLength={40} className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="eventType">Event type</label>
                <select id="eventType" name="eventType" required className="input">
                  <option value="">Select…</option>
                  <option>Wedding</option>
                  <option>Rehearsal dinner</option>
                  <option>Corporate event</option>
                  <option>Anniversary / milestone</option>
                  <option>Golf tournament</option>
                  <option>Memorial / celebration of life</option>
                  <option>Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="eventDate">Target date</label>
                <input id="eventDate" name="eventDate" type="date" className="input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="guestCount">Approximate guest count</label>
                <input id="guestCount" name="guestCount" type="number" min={1} max={500} className="input" />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1" htmlFor="message">Notes</label>
              <textarea id="message" name="message" rows={5} maxLength={4000} className="input" placeholder="Anything we should know about the event, dietary needs, decor, etc."></textarea>
            </div>
            <div className="pt-2">
              <button type="submit" className="inline-flex items-center justify-center rounded-md bg-club-green-700 text-white px-6 py-3 text-sm font-medium tracking-wide hover:bg-club-green-800">
                Send inquiry
              </button>
              <p className="mt-3 text-xs text-stone-500">
                Your inquiry will be logged for our events team. We respond
                within two business days.
              </p>
            </div>
          </form>
        </div>
      </section>
    </PublicClubLayout>
  );
}
