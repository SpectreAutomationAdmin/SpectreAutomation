"use server";

// Phase 20 (Member Database, 2026-08-15) — server actions for the
// admin Member Profile. Wraps existing services so every mutation
// is club-scoped + permission-gated + audited by the underlying
// service layer.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { updateProfile, addHouseholdMember, removeHouseholdMember } from "@/lib/services/member-profile";
import { assignGroupByName, removeGroupAssignment } from "@/lib/services/member-groups";
import { setMemberFieldValue } from "@/lib/services/member-custom-fields";
import { isAppError } from "@/lib/errors";

function bounce(memberId: string, err: unknown): never {
  if (isAppError(err)) {
    redirect(`/app/admin/members/${memberId}?error=${encodeURIComponent(err.safeMessage)}`);
  }
  throw err;
}

export async function editPrimaryDetailsAction(memberId: string, formData: FormData) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await updateProfile(principal, memberId, {
      firstName: String(formData.get("firstName") ?? ""),
      middleName: String(formData.get("middleName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      nickname: String(formData.get("nickname") ?? ""),
      salutation: String(formData.get("salutation") ?? ""),
      gender: String(formData.get("gender") ?? ""),
      email: String(formData.get("email") ?? "") || undefined,
      phone: String(formData.get("phone") ?? ""),
      homePhone: String(formData.get("homePhone") ?? ""),
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    });
  } catch (err) { bounce(memberId, err); }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=basic`);
}

export async function addAssociatedPersonAction(memberId: string, formData: FormData) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  try {
    await addHouseholdMember(principal, memberId, {
      firstName: String(formData.get("firstName") ?? ""),
      lastName: String(formData.get("lastName") ?? ""),
      relationship: String(formData.get("relationship") ?? "OTHER"),
      email: String(formData.get("email") ?? ""),
      phone: String(formData.get("phone") ?? ""),
      dateOfBirth: String(formData.get("dateOfBirth") ?? ""),
    });
  } catch (err) { bounce(memberId, err); }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=person-added`);
}

export async function removeAssociatedPersonAction(memberId: string, formData: FormData) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const householdId = String(formData.get("householdId") ?? "");
  try {
    await removeHouseholdMember(principal, memberId, householdId);
  } catch (err) { bounce(memberId, err); }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=person-removed`);
}

export async function addGroupAction(memberId: string, formData: FormData) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const name = String(formData.get("name") ?? "");
  try {
    await assignGroupByName(principal, memberId, name);
  } catch (err) { bounce(memberId, err); }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=group-added`);
}

export async function removeGroupAction(memberId: string, formData: FormData) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const groupId = String(formData.get("groupId") ?? "");
  try {
    await removeGroupAssignment(principal, memberId, groupId);
  } catch (err) { bounce(memberId, err); }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=group-removed`);
}

export async function setCustomFieldAction(memberId: string, formData: FormData) {
  const principal = await getCurrentPrincipal();
  if (!principal) redirect("/login");
  const definitionId = String(formData.get("definitionId") ?? "");
  const raw = formData.get("valueText");
  const value = raw == null ? null : String(raw);
  try {
    await setMemberFieldValue(principal, memberId, definitionId, value === "" ? null : value);
  } catch (err) { bounce(memberId, err); }
  revalidatePath(`/app/admin/members/${memberId}`);
  redirect(`/app/admin/members/${memberId}?saved=custom`);
}
