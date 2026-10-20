// SIGNUP-1 — Server-rendered step indicator (3-step dot row).
// Pure visual; no state.  Uses the signup.css classes.

interface Props {
  current: "IDENTITY" | "ADMIN" | "STATUS";
}

const STEPS = [
  { key: "IDENTITY", label: "Club identity" },
  { key: "ADMIN", label: "Founding administrator" },
  { key: "STATUS", label: "Registration status" },
] as const;

export function StepIndicator({ current }: Props) {
  const currentIndex = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="signup-steps" aria-label="Registration progress">
      {STEPS.map((s, i) => {
        const state =
          i < currentIndex ? "done" : i === currentIndex ? "current" : "pending";
        return (
          <li
            key={s.key}
            className="signup-step"
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="signup-step-dot" aria-hidden="true">
              {i + 1}
            </span>
            <span>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
