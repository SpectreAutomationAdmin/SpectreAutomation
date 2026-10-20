"use client";

// SIGNUP-1 — Admin position input (shown after Microsoft identity
// is verified).  Native form submit → /api/signup/admin-position.

import { useState, type FormEvent } from "react";

interface Props {
  token: string;
  existingPosition: string | null;
}

const COMMON_POSITIONS = [
  "General Manager",
  "Director of Finance / CFO",
  "Controller",
  "Head Golf Professional / Director of Golf",
  "Food & Beverage Director",
  "President / Chair of the Board",
  "Treasurer",
  "Other",
];

export function AdminPositionForm({ token, existingPosition }: Props) {
  const [pending, setPending] = useState(false);
  const [choice, setChoice] = useState(existingPosition ?? "");
  const [other, setOther] = useState("");

  function handleSubmit(_e: FormEvent<HTMLFormElement>) {
    setPending(true);
  }

  return (
    <form
      className="signup-form"
      method="POST"
      action="/api/signup/admin-position"
      onSubmit={handleSubmit}
      data-testid="signup-position-form"
      style={{ marginTop: 24 }}
    >
      <input type="hidden" name="token" value={token} />
      <div className="signup-field span-2">
        <label htmlFor="position">Your role at the Club</label>
        <select
          id="position"
          name="position"
          required
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          data-testid="signup-select-position"
        >
          <option value="" disabled>Select a role</option>
          {COMMON_POSITIONS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>
      {choice === "Other" ? (
        <div className="signup-field span-2">
          <label htmlFor="positionOther">Please specify</label>
          <input
            id="positionOther"
            name="positionOther"
            type="text"
            maxLength={120}
            value={other}
            onChange={(e) => setOther(e.target.value)}
            data-testid="signup-input-position-other"
            required
          />
        </div>
      ) : null}
      <div className="signup-submit">
        <button
          type="submit"
          className="w1b-pill-cta"
          disabled={pending}
          aria-busy={pending}
          data-testid="signup-position-submit"
        >
          {pending ? "Continuing…" : "Confirm and continue"}
        </button>
      </div>
    </form>
  );
}
