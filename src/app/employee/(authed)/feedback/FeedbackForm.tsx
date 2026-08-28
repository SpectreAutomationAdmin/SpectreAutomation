"use client";

import { useState } from "react";

const CATEGORIES = [
  { value: "",           label: "— Select a category (optional) —" },
  { value: "Workplace",  label: "Workplace" },
  { value: "Safety",     label: "Safety" },
  { value: "Management", label: "Management" },
  { value: "Facilities", label: "Facilities" },
  { value: "Suggestion", label: "Suggestion" },
  { value: "Other",      label: "Other" },
];

export default function FeedbackForm() {
  const [category, setCategory] = useState("");
  const [message, setMessage] = useState("");
  const [state, setState] = useState<{ tone: "idle" | "busy" | "ok" | "err"; text: string }>({
    tone: "idle", text: "",
  });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) return;
    setState({ tone: "busy", text: "" });
    try {
      const res = await fetch("/api/anonymous-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), category: category || null }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMessage("");
      setCategory("");
      setState({
        tone: "ok",
        text: "Your feedback has been submitted anonymously. Thank you.",
      });
    } catch (err) {
      setState({ tone: "err", text: (err as Error).message || "Something went wrong." });
    }
  };

  const disabled = state.tone === "busy" || !message.trim();

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl bg-white border border-stone-200/70 p-5 space-y-4"
      data-testid="feedback-form"
    >
      <label className="block text-sm">
        <span className="text-club-ink font-medium">Category (optional)</span>
        <select
          className="spectre-input w-full mt-1"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          data-testid="feedback-category"
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>{c.label}</option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-club-ink font-medium">Feedback</span>
        <textarea
          className="spectre-input w-full mt-1 min-h-[140px]"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Write your feedback here…"
          maxLength={4000}
          required
          data-testid="feedback-message"
        />
        <span className="text-[11px] text-stone-500">{message.length}/4000</span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={disabled}
          className="spectre-btn spectre-btn-primary disabled:opacity-50"
          data-testid="feedback-submit"
        >
          {state.tone === "busy" ? "Submitting…" : "Submit anonymously"}
        </button>
        {state.text && (
          <p
            role={state.tone === "err" ? "alert" : "status"}
            className={"text-sm " + (state.tone === "ok" ? "text-emerald-700" : state.tone === "err" ? "text-red-700" : "text-stone-600")}
            data-testid="feedback-status"
          >
            {state.text}
          </p>
        )}
      </div>
    </form>
  );
}
