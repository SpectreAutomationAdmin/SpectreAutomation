// COA-MAP-3 (2026-10-07) — the standalone Financial Statement Mapping
// workspace has been retired.  Every capability it provided
// (create FS group, drag/drop reassignment, effective-dated preview,
// reporting-impact + apply, mapping history) now lives on the
// unified Chart of Accounts page.
//
// Any bookmarked or in-flight link to /app/admin/coa-mapping now
// redirects to /app/admin/coa.  The redirect is server-side so
// Controllers never see a dead-end 404 page.

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function CoaMappingRedirect(props: {
  searchParams?: Promise<{ statement?: string; [k: string]: string | undefined }>;
}) {
  // Preserve any query params that make sense on the destination.
  // The old Mapping Studio supported `?statement=is|bs|cf` to deep-
  // link to a specific statement; Chart of Accounts is single-view,
  // so the parameter is dropped silently.  No other query params
  // need to carry over.
  await props.searchParams;
  redirect("/app/admin/coa");
}
