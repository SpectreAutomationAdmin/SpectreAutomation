// EP-BRAND-1A (2026-10-29) -- READ-ONLY search for an already-
// provisioned test employee on staging that has an active portal
// credential.  Used to decide whether we can reuse an existing
// identity for authenticated Playwright or whether a short-TTL
// synthetic one must be created.

import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

function mask(e) {
  if (!e) return "<null>";
  const [l, d] = e.split("@");
  return (l && l.length > 4 ? l.slice(0, 2) + "***" + l.slice(-2) : "***") + "@" + (d || "");
}

try {
  // 1. Employees that have a portal credential AND are ACTIVE in both
  //    status + employeeLifecycle (login requires both).
  const rows = await p.employee.findMany({
    where: {
      status: "ACTIVE",
      employeeLifecycle: "ACTIVE",
      employeePortalCredential: { isNot: null },
    },
    include: {
      club: { select: { name: true, id: true } },
      employeePortalCredential: {
        select: { id: true, passwordUpdatedAt: true, lastLoginAt: true, lockedUntil: true },
      },
    },
    take: 20,
  });
  const summary = rows.map((e) => ({
    employeeIdTail: e.id.slice(-6),
    workEmailMasked: mask(e.workEmail),
    personalEmailMasked: mask(e.personalEmail),
    legalName: `${e.firstName ?? ""} ${e.lastName ?? ""}`.trim(),
    clubIdTail: e.clubId.slice(-6),
    clubName: e.club?.name ?? null,
    hasPortalCredential: !!e.employeePortalCredential,
    passwordUpdatedAt: e.employeePortalCredential?.passwordUpdatedAt ?? null,
    lastLoginAt: e.employeePortalCredential?.lastLoginAt ?? null,
    lockedUntil: e.employeePortalCredential?.lockedUntil ?? null,
    syntheticMarker: (e.firstName ?? "").toLowerCase().includes("test")
      || (e.lastName ?? "").toLowerCase().includes("test")
      || (e.lastName ?? "").toLowerCase().includes("fixture")
      || (e.firstName ?? "").toLowerCase().includes("fixture"),
  }));
  console.log(JSON.stringify({
    total: summary.length,
    rows: summary,
  }, null, 2));
} finally {
  await p.$disconnect();
}
