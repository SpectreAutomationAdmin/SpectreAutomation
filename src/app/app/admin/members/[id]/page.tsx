// Phase 20 (Member Database, 2026-08-15) — admin Member Profile.
//
// Renders the reference-matching identity header, the primary tab
// row (Member / Plan / Billing / E-signatures / Notes / Documents /
// overflow), and the Member tab content (person switcher +
// Basic Details + Member Picture + Groups + Other Info + Additional
// Info). Server-side loader; interactivity delegated to a client
// component (`MemberProfileClient.tsx`) that owns tab state + the
// person-switcher URL param.
//
// The existing rich member-detail experience (charges, payments,
// dining, financing, collections, etc.) previously lived here.
// It is intentionally deferred to a subsequent phase per founder
// scope discipline — the tabs for Plan / Billing / E-signatures /
// Notes / Documents are placeholder shells in this phase.

import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getActiveClubId } from "@/lib/active-club";
import { listMemberGroups } from "@/lib/services/member-groups";
import { getMemberFieldPayload } from "@/lib/services/member-custom-fields";
import { RegisterBreadcrumbLabel } from "@/components/spectre/breadcrumb-labels";
import MemberProfileView from "@/components/members/MemberProfileView";
import {
  editPrimaryDetailsAction,
  addAssociatedPersonAction,
  removeAssociatedPersonAction,
  addGroupAction,
  removeGroupAction,
  setCustomFieldAction,
} from "./_actions";

export const dynamic = "force-dynamic";

interface PageProps {
  params: { id: string };
  searchParams: { person?: string; tab?: string; saved?: string; error?: string };
}

export default async function MemberProfilePage({ params, searchParams }: PageProps) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const clubId = await getActiveClubId(user);

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId },
    include: {
      household: { orderBy: [{ relationship: "asc" }, { firstName: "asc" }] },
      groupAssignments: {
        include: { group: true },
        orderBy: [{ group: { sortOrder: "asc" } }, { group: { name: "asc" } }],
      },
    },
  });
  if (!member) notFound();

  const [allGroups, customFields] = await Promise.all([
    listMemberGroups(clubId),
    getMemberFieldPayload(clubId, member.id),
  ]);

  const displayName = member.nickname
    ? `${member.firstName} ${member.lastName}`
    : `${member.firstName} ${member.lastName}`;

  return (
    <>
      {/* Phase 4R rev-5 breadcrumb — the shell reads the display name
          from the shared BreadcrumbLabelsProvider so the crumb reads
          "App > Membership > Members > James Whitfield" instead of
          leaking the cuid. */}
      <RegisterBreadcrumbLabel id={member.id} label={displayName} />
      <MemberProfileView
        member={{
          id: member.id,
          memberNumber: member.memberNumber,
          status: member.status,
          membershipCategory: member.membershipCategory,
          joinDate: member.joinDate?.toISOString() ?? null,
          firstName: member.firstName,
          middleName: member.middleName,
          lastName: member.lastName,
          nickname: member.nickname,
          salutation: member.salutation,
          gender: member.gender,
          email: member.email,
          phone: member.phone,
          homePhone: member.homePhone,
          dateOfBirth: member.dateOfBirth?.toISOString() ?? null,
          profileImageUrl: member.profileImageUrl,
        }}
        household={member.household.map((h) => ({
          id: h.id,
          firstName: h.firstName,
          middleName: h.middleName,
          lastName: h.lastName,
          nickname: h.nickname,
          salutation: h.salutation,
          gender: h.gender,
          relationship: h.relationship,
          email: h.email,
          phone: h.phone,
          homePhone: h.homePhone,
          dateOfBirth: h.dateOfBirth?.toISOString() ?? null,
          profileImageUrl: h.profileImageUrl,
        }))}
        assignedGroups={member.groupAssignments.map((a) => ({
          groupId: a.group.id,
          name: a.group.name,
        }))}
        allGroups={allGroups.map((g) => ({ id: g.id, name: g.name }))}
        customFields={customFields}
        activePersonParam={searchParams.person ?? null}
        activeTab={searchParams.tab ?? "member"}
        savedFlash={searchParams.saved ?? null}
        errorFlash={searchParams.error ?? null}
        actions={{
          editPrimaryDetails: editPrimaryDetailsAction.bind(null, member.id),
          addAssociatedPerson: addAssociatedPersonAction.bind(null, member.id),
          removeAssociatedPerson: removeAssociatedPersonAction.bind(null, member.id),
          addGroup: addGroupAction.bind(null, member.id),
          removeGroup: removeGroupAction.bind(null, member.id),
          setCustomField: setCustomFieldAction.bind(null, member.id),
        }}
      />
    </>
  );
}
