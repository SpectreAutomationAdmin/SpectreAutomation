// HR-2B.2 (2026-08-18) — Employee-facing inline error card.
//
// Renders a single safe-message error (from a stashed cookie after a
// server-action redirect). Neutral copy; no stack traces; no field
// enumeration beyond what the underlying validation issue already
// carries.

export function OnboardingStepError({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="mb-6 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {message}
    </div>
  );
}
