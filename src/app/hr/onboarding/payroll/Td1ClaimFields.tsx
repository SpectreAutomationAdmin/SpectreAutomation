// HR-2B.3 (2026-08-19) — TD1 claim fields with progressive disclosure.
//
// Two-step conversational shape:
//   1. Radio: "claim basic amount only" (default) vs "I have additional
//      claims".
//   2. When "additional" is selected, render a checkbox list of the
//      supplied additional-claim specs; each checked row exposes a
//      dollar amount input.
//
// The component also renders a live client-computed total (basic +
// checked-additional amounts) so the employee sees what they&apos;re
// declaring. The server re-computes the authoritative total on submit
// (see `_actions.ts`).

"use client";

import { useMemo, useState } from "react";

interface AdditionalClaimSpec {
  key: string;
  label: string;
  description: string;
}

interface Props {
  basicPersonalAmount: string;
  basicLabel: string;
  additionalClaims: ReadonlyArray<AdditionalClaimSpec>;
  testidPrefix: string;
}

export default function Td1ClaimFields({
  basicPersonalAmount,
  basicLabel,
  additionalClaims,
  testidPrefix,
}: Props) {
  const [mode, setMode] = useState<"basic" | "additional">("basic");
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const total = useMemo(() => {
    const basic = Number(basicPersonalAmount) || 0;
    if (mode !== "additional") return basic;
    let extra = 0;
    for (const c of additionalClaims) {
      if (!checked[c.key]) continue;
      const n = Number(amounts[c.key] ?? "");
      if (Number.isFinite(n) && n > 0) extra += n;
    }
    return basic + extra;
  }, [mode, checked, amounts, basicPersonalAmount, additionalClaims]);

  return (
    <div className="space-y-5">
      <div className="rounded-md border border-stone-200 bg-stone-50 px-4 py-3">
        <p className="text-xs uppercase tracking-[0.2em] text-stone-500">
          {basicLabel}
        </p>
        <p className="mt-1 font-mono text-lg text-stone-900">
          ${Number(basicPersonalAmount).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
        <p className="mt-1 text-xs text-stone-500">
          The current basic amount. This is applied automatically.
        </p>
      </div>

      <fieldset>
        <legend className="text-sm text-stone-700">
          Do you have additional claims?
        </legend>
        <div className="mt-3 space-y-2.5">
          <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
            <input
              type="radio"
              name="claim_mode"
              value="basic"
              checked={mode === "basic"}
              onChange={() => setMode("basic")}
              data-testid={`${testidPrefix}-mode-basic`}
              className="mt-1 text-emerald-700 focus:ring-emerald-700"
            />
            <span className="text-sm text-stone-800">
              That&apos;s me &mdash; claim the basic amount only.
            </span>
          </label>
          <label className="flex items-start gap-3 rounded-md border border-stone-200 px-3 py-2.5 hover:border-stone-300 cursor-pointer">
            <input
              type="radio"
              name="claim_mode"
              value="additional"
              checked={mode === "additional"}
              onChange={() => setMode("additional")}
              data-testid={`${testidPrefix}-mode-additional`}
              className="mt-1 text-emerald-700 focus:ring-emerald-700"
            />
            <span className="text-sm text-stone-800">
              I have additional claims.
            </span>
          </label>
        </div>
      </fieldset>

      {mode === "additional" && (
        <fieldset className="space-y-3">
          <legend className="text-sm text-stone-700">
            Check any that apply. Enter the amount you plan to claim for the year.
          </legend>
          {additionalClaims.map((c) => {
            const isChecked = Boolean(checked[c.key]);
            return (
              <div key={c.key} className="rounded-md border border-stone-200 px-3 py-2.5">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    name={`claim:${c.key}:enabled`}
                    value="1"
                    checked={isChecked}
                    onChange={(e) => setChecked((prev) => ({ ...prev, [c.key]: e.target.checked }))}
                    data-testid={`${testidPrefix}-claim-${c.key}-enabled`}
                    className="mt-1 text-emerald-700 focus:ring-emerald-700"
                  />
                  <span className="text-sm text-stone-800">
                    {c.label}
                    <span className="mt-0.5 block text-xs text-stone-500">
                      {c.description}
                    </span>
                  </span>
                </label>
                {isChecked && (
                  <label className="mt-3 flex items-center gap-2 pl-7">
                    <span className="text-xs text-stone-500">CAD $</span>
                    <input
                      type="text"
                      name={`claim:${c.key}:amount`}
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="0.00"
                      maxLength={12}
                      value={amounts[c.key] ?? ""}
                      onChange={(e) => setAmounts((prev) => ({ ...prev, [c.key]: e.target.value }))}
                      data-testid={`${testidPrefix}-claim-${c.key}-amount`}
                      className="block w-40 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-mono text-stone-900 focus:border-emerald-700 focus:ring-1 focus:ring-emerald-700"
                    />
                  </label>
                )}
              </div>
            );
          })}
        </fieldset>
      )}

      <div className="rounded-md border border-emerald-100 bg-emerald-50 px-4 py-3">
        <p className="text-xs uppercase tracking-[0.2em] text-emerald-900">
          Your total claim
        </p>
        <p
          className="mt-1 font-mono text-lg text-stone-900"
          data-testid={`${testidPrefix}-total`}
        >
          ${total.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </p>
      </div>
    </div>
  );
}
