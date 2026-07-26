import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";
import { SpectreGallery } from "./gallery-client";

// Spectre Design Language — Component Gallery (Phase 1).
//
// This page is NOT production. It exists only for founder review of
// the design language before any workflow is migrated to it. It:
//
//   • is guarded behind admin auth so it does not leak to the public
//   • renders every documented component variant in one page so the
//     founder can eyeball the whole vocabulary in one scroll
//   • uses ONLY `--spectre-*` tokens and `.spectre-*` classes — no
//     legacy `.card`, `.btn`, etc., so what the founder sees IS the
//     design language, not an accidental hybrid
//
// The AdminShell's SPECTRE_MODE_PREFIXES list matches on
// `/app/admin/design-system` so this page renders under the new
// SpectreShell + SpectreSidebar + SpectreTopBar. Every OTHER admin
// route continues to use the legacy chrome UNCHANGED.

export const dynamic = "force-dynamic";

export default async function DesignSystemGalleryPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // No fine-grained permission gating — this page is intentionally
  // available to any authenticated admin so founder-approved
  // reviewers can inspect it without a special role.
  return <SpectreGallery />;
}
