// HR-2B.3.1 (2026-08-18) — Client-side error banner reader.
//
// The onboarding step layouts previously stashed one-shot error
// messages via a server-set httpOnly cookie + a layout-render-time
// `cookieStore.delete(...)` call. Next.js 14+ FORBIDS mutating
// cookies inside a server-component render — the `.delete()` throws
// `Cookies can only be modified in a Server Action or Route Handler`
// and 500s the page (this crashed the founder's SIN entry on staging).
//
// New idiom: server actions redirect with `?err=<safeMessage>`; this
// client component reads the search param via `useSearchParams()`
// and renders the shared `<OnboardingStepError>` banner. The param
// clears naturally on the next navigation — no cookie state to
// manage, no server-component mutation.

"use client";

import { useSearchParams } from "next/navigation";
import { OnboardingStepError } from "./OnboardingStepError";

export function OnboardingStepErrorFromSearchParam() {
  const sp = useSearchParams();
  const err = sp.get("err");
  if (!err) return null;
  return <OnboardingStepError message={err} />;
}
