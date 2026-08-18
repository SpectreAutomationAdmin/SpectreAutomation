// Phase 20 (Member Database, 2026-08-15) — member custom-field
// service. Two-table design: MemberCustomFieldDefinition (per-club
// catalog) + MemberCustomFieldValue (sparse, per-member value).
//
// A club can define fields like "Resignation" or "Interested in RC?"
// without a schema migration; each value is stored as `valueText` so
// the schema stays portable across SQLite (staging + dev) and
// Postgres (production). Kind is a UI hint, not a storage type.

import { z } from "zod";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { hasPermission, type Principal } from "../rbac";
import { assertTenantOwned } from "./tenant";
import { ForbiddenError, ValidationError } from "../errors";

export type CustomFieldKind = "TEXT" | "LONG_TEXT" | "BOOLEAN" | "DATE" | "NUMBER" | "SELECT";

function requireAdmin(principal: Principal, clubId: string) {
  if (!hasPermission(principal, clubId, "members:write")) {
    throw new ForbiddenError("Not permitted to modify member custom fields");
  }
}

const keySchema = z.string().trim().min(1).max(64).regex(/^[a-z0-9_]+$/, "key must be snake_case");
const labelSchema = z.string().trim().min(1).max(128);
const valueSchema = z.string().trim().max(2000).nullable();

/** List active custom-field definitions for a club (archived hidden). */
export async function listActiveDefinitions(clubId: string) {
  return prisma.memberCustomFieldDefinition.findMany({
    where: { clubId, archivedAt: null },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
  });
}

/** Get the (definition, value) tuples for one member, in display
 *  order. Definitions without a value join with `null` so the UI can
 *  render "Not provided" without a separate query. */
export async function getMemberFieldPayload(clubId: string, memberId: string) {
  const [definitions, values] = await Promise.all([
    listActiveDefinitions(clubId),
    prisma.memberCustomFieldValue.findMany({
      where: { memberId, clubId },
      select: { definitionId: true, valueText: true },
    }),
  ]);
  const valuesByDef = new Map(values.map((v) => [v.definitionId, v.valueText] as const));
  return definitions.map((d) => ({
    id: d.id,
    key: d.key,
    label: d.label,
    kind: d.kind as CustomFieldKind,
    helpText: d.helpText,
    optionsJson: d.optionsJson,
    valueText: valuesByDef.get(d.id) ?? null,
  }));
}

/** Idempotent: upsert a definition by (clubId, key). Used by seeds
 *  and by the eventual "manage custom fields" admin surface. */
export async function upsertDefinition(
  principal: Principal,
  clubId: string,
  input: { key: string; label: string; kind?: CustomFieldKind; helpText?: string | null; sortOrder?: number; optionsJson?: string | null },
) {
  requireAdmin(principal, clubId);
  const key = keySchema.parse(input.key);
  const label = labelSchema.parse(input.label);
  const kind: CustomFieldKind = (input.kind ?? "TEXT");
  return prisma.memberCustomFieldDefinition.upsert({
    where: { clubId_key: { clubId, key } },
    create: {
      clubId, key, label, kind,
      helpText: input.helpText ?? null,
      optionsJson: input.optionsJson ?? null,
      sortOrder: input.sortOrder ?? 100,
    },
    update: {
      label, kind,
      helpText: input.helpText ?? null,
      optionsJson: input.optionsJson ?? null,
      sortOrder: input.sortOrder ?? 100,
    },
  });
}

/** Set (or clear) a member's value for a definition. Null clears. */
export async function setMemberFieldValue(
  principal: Principal,
  memberId: string,
  definitionId: string,
  rawValue: string | null,
) {
  const member = await prisma.member.findUnique({ where: { id: memberId } });
  assertTenantOwned(member, principal);
  requireAdmin(principal, member.clubId);
  const definition = await prisma.memberCustomFieldDefinition.findUnique({ where: { id: definitionId } });
  if (!definition || definition.clubId !== member.clubId) {
    throw new ValidationError([{ path: "definitionId", message: "unknown definition" }]);
  }
  const value = valueSchema.parse(rawValue);
  if (value === null) {
    await prisma.memberCustomFieldValue.deleteMany({
      where: { memberId, definitionId },
    });
  } else {
    await prisma.memberCustomFieldValue.upsert({
      where: { memberId_definitionId: { memberId, definitionId } },
      create: {
        clubId: member.clubId, memberId, definitionId,
        valueText: value, updatedByUserId: principal.id,
      },
      update: { valueText: value, updatedByUserId: principal.id },
    });
  }
  await audit(principal, {
    action: "member.customField.set",
    entityType: "MemberCustomFieldValue",
    entityId: `${memberId}:${definitionId}`,
    clubId: member.clubId,
    after: { definitionKey: definition.key, valueText: value },
  });
}
