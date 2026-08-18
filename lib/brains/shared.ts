// Fixed examiner lines shared by both brains. Bank questions are delivered
// VERBATIM (CLAUDE.md §6 — "asks from examinerBank") and timer/nudge lines are
// scripted, so no brain needs an LLM for them; the AnthropicBrain only spends
// tokens where judgment is required (the one-spontaneous-follow-up decision
// and the marking pass).

import type { HistoryFact } from "../case-schema";
import { matchesAnyTrigger, normalizeText } from "../text-match";
import type { ExaminerDirective } from "../ports";

/**
 * Would saying `text` give away a fact the student has not earned yet? Used to
 * decide whether the case's written `presentingComplaint` is safe to restate:
 * it is a clinical summary, so it routinely names topics that are deliberately
 * gated behind `onAsk` triggers ("...with weight loss and night sweats").
 *
 * Shared by both brains — the MockBrain checks it against the facts still
 * hidden right now, the AnthropicBrain against every onAsk fact (so the cached
 * persona block stays identical for the whole session).
 */
export function leaksHiddenTopic(text: string, hidden: readonly HistoryFact[]): boolean {
  const norm = normalizeText(text);
  return hidden.some((f) => matchesAnyTrigger(norm, f.triggers));
}

export function examinerCannedLine(directive: ExaminerDirective): string {
  switch (directive.type) {
    case "bank-question":
      return directive.question;
    case "followup-or-continue":
      return "Thank you, doctor. Carry on.";
    case "reply":
      return "Thank you, doctor. Carry on.";
    case "nudge":
      return `In the interest of time, doctor, let's move on to your ${directive.toPhase}.`;
    case "timer-warning":
      return `Doctor, you have ${directive.minutesLeft} minute${directive.minutesLeft === 1 ? "" : "s"} remaining.`;
    case "time-up":
      return "Thank you doctor, time's up — we'll go to marking.";
    case "acknowledge":
      return "Noted, doctor — continue.";
  }
}
