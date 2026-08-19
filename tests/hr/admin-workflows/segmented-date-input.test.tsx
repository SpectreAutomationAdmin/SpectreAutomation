// HR-2B.3.6 (2026-08-19) — SegmentedDateInput component tests.
//
// Founder invariants:
//   * Typing `20260915` continuously produces canonical `2026-09-15`.
//   * Year stops after 4 digits, month after 2, day after 2 (auto-
//     advance to next segment).
//   * Paste accepts both `20260915` and `2026-09-15`.
//   * Invalid calendar dates (e.g. `2026-02-31`) surface an inline
//     error and the hidden canonical input stays empty.
//   * Backspace on an empty segment jumps to the previous segment.

/* @vitest-environment jsdom */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import SegmentedDateInput from "@/components/hr/SegmentedDateInput";

afterEach(() => cleanup());

/** Simulate typing a sequence of digits into whichever segment is
 *  currently focused. The component's onChange handlers auto-advance
 *  focus to the next segment when the current one fills, so consecutive
 *  `fireEvent.change` calls against the ACTIVE element mirror what a
 *  real keystroke stream produces. */
function typeDigits(digits: string) {
  for (const ch of digits) {
    const el = document.activeElement as HTMLInputElement | null;
    if (!el || el.tagName !== "INPUT") break;
    // React sees the change event as the new full value — append to
    // whatever's already there, respecting the maxLength cap.
    const next = (el.value + ch).slice(0, el.maxLength);
    fireEvent.change(el, { target: { value: next } });
  }
}

function renderIt() {
  return render(<SegmentedDateInput name="expectedStartDate" testIdPrefix="d" />);
}

describe("HR-2B.3.6 · SegmentedDateInput", () => {
  it("typing 20260915 continuously → hidden canonical is 2026-09-15", () => {
    renderIt();
    (screen.getByTestId("d-year") as HTMLInputElement).focus();
    typeDigits("20260915");

    const canonical = screen.getByTestId("d-canonical") as HTMLInputElement;
    expect(canonical.value).toBe("2026-09-15");
    expect((screen.getByTestId("d-day") as HTMLInputElement).value).toBe("15");
  });

  it("year auto-advances to month after 4 digits", () => {
    renderIt();
    (screen.getByTestId("d-year") as HTMLInputElement).focus();
    typeDigits("2026");
    expect(document.activeElement).toBe(screen.getByTestId("d-month"));
  });

  it("month auto-advances to day after 2 digits", () => {
    renderIt();
    (screen.getByTestId("d-year") as HTMLInputElement).focus();
    typeDigits("202609");
    expect(document.activeElement).toBe(screen.getByTestId("d-day"));
  });

  it("day stops after 2 digits (maxLength clamps overflow)", () => {
    renderIt();
    (screen.getByTestId("d-year") as HTMLInputElement).focus();
    typeDigits("20260915");
    const day = screen.getByTestId("d-day") as HTMLInputElement;
    // Further digits at day should be discarded.
    typeDigits("99");
    expect(day.value).toBe("15");
  });

  it("paste `2026-09-15` fills all three segments", () => {
    renderIt();
    const year = screen.getByTestId("d-year") as HTMLInputElement;
    fireEvent.paste(year, {
      clipboardData: {
        getData: () => "2026-09-15",
      },
    });
    const canonical = screen.getByTestId("d-canonical") as HTMLInputElement;
    expect(canonical.value).toBe("2026-09-15");
  });

  it("paste `20260915` (no dashes) also fills all three segments", () => {
    renderIt();
    const year = screen.getByTestId("d-year") as HTMLInputElement;
    fireEvent.paste(year, {
      clipboardData: {
        getData: () => "20260915",
      },
    });
    const canonical = screen.getByTestId("d-canonical") as HTMLInputElement;
    expect(canonical.value).toBe("2026-09-15");
  });

  it("invalid calendar date (2026-02-31) surfaces inline error + canonical stays empty", async () => {
    renderIt();
    (screen.getByTestId("d-year") as HTMLInputElement).focus();
    typeDigits("20260231");
    const err = await screen.findByTestId("d-error");
    expect(err.textContent ?? "").toMatch(/real calendar date/i);
    const canonical = screen.getByTestId("d-canonical") as HTMLInputElement;
    expect(canonical.value).toBe("");
  });

  it("backspace on empty month hops back to year", () => {
    renderIt();
    (screen.getByTestId("d-year") as HTMLInputElement).focus();
    typeDigits("2026");
    // Focus is now on month (auto-advanced). Empty-month backspace
    // must jump back to year.
    fireEvent.keyDown(screen.getByTestId("d-month") as HTMLInputElement, { key: "Backspace" });
    expect(document.activeElement).toBe(screen.getByTestId("d-year"));
  });
});
