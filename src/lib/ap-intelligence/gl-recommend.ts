// Sprint 3 Checkpoint 15E (2026-07-24) — GL-account recommendation.
//
// Deterministic. Given a capital/operating classification + the
// extracted invoice + the club's chart of accounts, return the
// recommended GL account number (a string like "1540" or "6020")
// with a short reason. The recommendation is ALWAYS explainable.
//
// Falls back to the vendor's `defaultExpenseAccountId` when
// classification is OPERATING and no keyword-based match applies.

import { prisma } from "@/lib/prisma";
import type { CapitalClass, CapitalVsOperatingState } from "./types";

const RULE_VERSION = 1;

// Canonical mapping from capital-class → GL account number (matches
// src/lib/accounting/coa-template.ts). Every club is seeded from that
// template, so the account numbers are stable across clubs.
const CAPITAL_CLASS_TO_GL: Record<CapitalClass, { accountNumber: string; label: string }> = {
  COURSE_EQUIPMENT:      { accountNumber: "1540", label: "Equipment & Vehicles" },
  KITCHEN_EQUIPMENT:     { accountNumber: "1540", label: "Equipment & Vehicles" },
  GOLF_EQUIPMENT:        { accountNumber: "1540", label: "Equipment & Vehicles" },
  BUILDING_IMPROVEMENTS: { accountNumber: "1530", label: "Course Improvements" },
  FURNITURE:             { accountNumber: "1540", label: "Equipment & Vehicles" },
  COMPUTER_EQUIPMENT:    { accountNumber: "1540", label: "Equipment & Vehicles" },
  VEHICLES:              { accountNumber: "1540", label: "Equipment & Vehicles" },
  IRRIGATION:            { accountNumber: "1530", label: "Course Improvements" },
  OTHER_CAPITAL:         { accountNumber: "1500", label: "Property & Equipment" },
};

export interface GlRecommendationArgs {
  clubId: string;
  vendorId: string | null;
  capitalState: CapitalVsOperatingState;
  capitalClass: CapitalClass | null;
}

export interface GlRecommendation {
  ruleVersion: number;
  accountNumber: string | null;
  accountName: string | null;
  reason: string;
  source: "CAPITAL_CLASS_MAP" | "VENDOR_DEFAULT" | "NONE";
}

export async function recommendGlAccount(args: GlRecommendationArgs): Promise<GlRecommendation> {
  if (args.capitalState === "CAPITAL" && args.capitalClass) {
    const map = CAPITAL_CLASS_TO_GL[args.capitalClass];
    const account = await prisma.account.findFirst({
      where: { clubId: args.clubId, accountNumber: map.accountNumber, isActive: true },
      select: { accountNumber: true, name: true },
    });
    if (account) {
      return {
        ruleVersion: RULE_VERSION,
        accountNumber: account.accountNumber,
        accountName: account.name,
        reason: `Capital class ${args.capitalClass} maps to GL ${account.accountNumber} — ${account.name}.`,
        source: "CAPITAL_CLASS_MAP",
      };
    }
    return {
      ruleVersion: RULE_VERSION,
      accountNumber: map.accountNumber,
      accountName: map.label,
      reason: `Capital class ${args.capitalClass} maps to GL ${map.accountNumber} (${map.label}) but no matching Account row exists on this club — reviewer must seed or select an alternate.`,
      source: "CAPITAL_CLASS_MAP",
    };
  }

  if (args.capitalState === "OPERATING" && args.vendorId) {
    const vendor = await prisma.vendor.findFirst({
      where: { id: args.vendorId, clubId: args.clubId },
      select: {
        defaultExpenseAccount: {
          select: { accountNumber: true, name: true },
        },
        legalName: true,
      },
    });
    if (vendor?.defaultExpenseAccount) {
      return {
        ruleVersion: RULE_VERSION,
        accountNumber: vendor.defaultExpenseAccount.accountNumber,
        accountName: vendor.defaultExpenseAccount.name,
        reason: `Operating expense; using vendor ${vendor.legalName}'s default GL account (${vendor.defaultExpenseAccount.accountNumber} — ${vendor.defaultExpenseAccount.name}).`,
        source: "VENDOR_DEFAULT",
      };
    }
  }

  return {
    ruleVersion: RULE_VERSION,
    accountNumber: null,
    accountName: null,
    reason:
      args.capitalState === "AMBIGUOUS"
        ? "Capital vs operating is ambiguous — reviewer must decide before a GL account can be recommended."
        : args.capitalState === "INSUFFICIENT_EVIDENCE"
          ? "Insufficient evidence to recommend a GL account."
          : args.vendorId
            ? "No vendor default GL account is configured for the matched vendor."
            : "No vendor matched — cannot recommend a GL account.",
    source: "NONE",
  };
}
