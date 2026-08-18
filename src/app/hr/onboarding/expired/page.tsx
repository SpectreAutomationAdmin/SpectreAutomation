// HR-2B.1 (2026-08-18) — Fallback for stale / cleared employee-
// onboarding sessions. Kept intentionally generic so we don't leak
// "your session expired" vs "your invitation was revoked" vs "cookie
// was cleared" — all paths land here.

export default function OnboardingExpiredPage() {
  return (
    <main className="flex items-center justify-center px-4 py-20">
      <div className="w-full max-w-md rounded-lg bg-white border border-stone-200 px-8 py-10 text-center">
        <h1 className="font-serif text-2xl text-stone-900">
          Your onboarding session is no longer active.
        </h1>
        <p className="mt-3 text-sm text-stone-600 leading-relaxed">
          Please open the most recent invitation link from your Club. If you
          don't have it, contact your Club and we'll issue a new one.
        </p>
      </div>
    </main>
  );
}
