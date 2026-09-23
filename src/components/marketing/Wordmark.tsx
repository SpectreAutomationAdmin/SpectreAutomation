// SPECTRE / AUTOMATION restrained wordmark. Used in nav + footer + eyebrows.
// Deliberately typographic — no logo mark. The dividing slash comes from a
// span so it can be visually softened without touching the letters.

interface WordmarkProps {
  className?: string;
  variant?: "default" | "eyebrow";
}

export function Wordmark({ className = "", variant = "default" }: WordmarkProps) {
  const size = variant === "eyebrow" ? "mkt-eyebrow" : "mkt-wordmark";
  return (
    <span className={`${size} ${className}`.trim()} aria-label="Spectre Automation">
      SPECTRE
      <span className="mkt-wordmark-divider" aria-hidden="true">/</span>
      AUTOMATION
    </span>
  );
}
