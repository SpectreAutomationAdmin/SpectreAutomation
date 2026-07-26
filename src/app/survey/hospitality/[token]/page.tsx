// Public hospitality feedback survey — no login required.
//
// Path:        /survey/hospitality/[token]
// Query:       ?rating=N pre-selects the rating clicked in the email
// Branding:    shows the club's name only. NO Spectre wordmark
//              (members never see the platform brand).

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies, headers } from "next/headers";
import {
  resolveSurveyInvitation,
  submitSurveyResponse,
  markSurveyInvitationOpened,
  hashIp,
} from "@/lib/hospitality/surveys";
import { isAppError } from "@/lib/errors";
import { RatingPicker } from "./RatingPicker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Action-error cookie. Single-use, httpOnly, 30-second TTL. Matches the
// project pattern used by /admin/compliance and /admin/hospitality/feedback —
// no shared helper yet, pattern is inlined per surface. The page reads
// the cookie on the next render and immediately deletes it so a back-
// button refresh doesn't replay the banner.
const ERROR_COOKIE = "spectre_survey_error";

async function submitAction(token: string, formData: FormData) {
  "use server";
  const ratingRaw = Number(formData.get("rating"));
  const comment = String(formData.get("comment") ?? "");
  const h = headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() ?? h.get("x-real-ip") ?? null;
  const userAgent = h.get("user-agent") ?? null;
  try {
    await submitSurveyResponse({
      token,
      rating: ratingRaw,
      comment,
      ipHash: ip ? hashIp(ip) : null,
      userAgent,
    });
  } catch (err) {
    if (isAppError(err)) {
      cookies().set(ERROR_COOKIE, err.safeMessage, {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30,
      });
      redirect(`/survey/hospitality/${encodeURIComponent(token)}`);
    }
    // Unexpected non-AppError: rethrow so the runtime + monitoring see
    // the real exception. We deliberately don't swallow these into a
    // generic message.
    throw err;
  }
  revalidatePath(`/survey/hospitality/${token}`);
  redirect(`/survey/hospitality/${encodeURIComponent(token)}?submitted=1`);
}

export default async function HospitalitySurveyPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { rating?: string; submitted?: string };
}) {
  // Already-submitted view is a separate render path so a member who
  // re-opens the link sees a polite confirmation rather than an error.
  if (searchParams.submitted === "1") {
    return <SubmittedPage />;
  }

  // Pull + consume the action-error cookie. Read once, delete once.
  const cookieStore = cookies();
  const actionError = cookieStore.get(ERROR_COOKIE)?.value ?? null;
  if (actionError) cookieStore.delete(ERROR_COOKIE);

  let invitation: Awaited<ReturnType<typeof resolveSurveyInvitation>>;
  try {
    invitation = await resolveSurveyInvitation(params.token);
  } catch {
    // Generic message — do not disclose "unknown token" vs "expired"
    // vs "consumed". All paths get the same neutral copy.
    return <InvalidPage />;
  }

  // Mark OPENED on first view. Best-effort; never fail the page render.
  try { await markSurveyInvitationOpened(params.token); } catch { /* ignore */ }

  const preselected = (() => {
    const n = Number(searchParams.rating);
    return Number.isInteger(n) && n >= 1 && n <= 5 ? n : undefined;
  })();

  const action = submitAction.bind(null, params.token);
  const greeting = invitation.memberFirstName ? `Hi ${invitation.memberFirstName},` : `Hi,`;

  return (
    <main className="min-h-screen bg-stone-50 flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-xl">
        <header className="text-center">
          <p className="text-[11px] uppercase tracking-[0.25em] text-stone-500">
            {invitation.clubName}
          </p>
          <h1 className="mt-2 font-serif text-3xl text-stone-900">
            How was your experience today?
          </h1>
          {invitation.posCheckNumber && (
            <p className="mt-1 text-xs text-stone-500">
              Check {invitation.posCheckNumber}
            </p>
          )}
        </header>

        {actionError && (
          <div className="mt-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </div>
        )}

        <form action={action} className="mt-8 rounded-lg bg-white border border-stone-200 p-6 space-y-6">
          <div>
            <p className="text-sm text-stone-700">{greeting}</p>
            <p className="mt-2 text-sm text-stone-600">
              Please let us know how today&rsquo;s visit went. Your feedback is shared
              only with our team and helps us improve the member experience.
            </p>
          </div>

          {/* Rating + comment + submit live in the client component so
              the user gets immediate visual feedback when they click a
              star, the submit button stays disabled until a rating is
              picked, and the form value reflects the user's FINAL
              selection (not the stale URL preselection). */}
          <RatingPicker initialRating={preselected ?? null} />
        </form>

        <p className="mt-6 text-center text-[11px] text-stone-400">
          Survey link expires {invitation.expiresAt.toISOString().slice(0, 10)}.
        </p>
      </div>
    </main>
  );
}

function SubmittedPage() {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-lg bg-white border border-stone-200 p-8 text-center">
        <div className="mx-auto h-12 w-12 rounded-full bg-stone-900 text-white flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </div>
        <h1 className="mt-4 font-serif text-2xl text-stone-900">
          Thank you for sharing your feedback.
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          Your comments help us improve the member experience. If you raised a
          concern, a member of our team may be in touch to follow up directly.
        </p>
      </div>
    </main>
  );
}

function InvalidPage() {
  return (
    <main className="min-h-screen bg-stone-50 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md rounded-lg bg-white border border-stone-200 p-8 text-center">
        <h1 className="font-serif text-2xl text-stone-900">
          This survey link is no longer available.
        </h1>
        <p className="mt-2 text-sm text-stone-600">
          The link may have expired, already been used, or been deactivated.
          If you&rsquo;d like to share feedback about a recent visit, please
          reach out to your club directly.
        </p>
      </div>
    </main>
  );
}
