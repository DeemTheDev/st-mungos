"use client";

// Inline card correction — the human end of the extraction quality loop.
// Extraction is probabilistic and the repair passes deterministic-only, so the
// last mile is her spotting a wrong answer mid-study and fixing it right there,
// without leaving for an admin screen. One component serves both surfaces
// (browse list, review player) so the two can never drift.
import { useState } from "react";
import { FlashcardsApiError, updateCard, type CardInfo, type CardStatus } from "./api";

const FIELD =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none";

export interface CardEditorProps {
  cardId: string;
  initial: { context: string; question: string; answer: string };
  status: CardStatus;
  onSaved: (card: CardInfo, warning: string | null) => void;
  onCancel: () => void;
}

export function CardEditor({ cardId, initial, status, onSaved, onCancel }: CardEditorProps) {
  const [context, setContext] = useState(initial.context);
  const [question, setQuestion] = useState(initial.question);
  const [answer, setAnswer] = useState(initial.answer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(markOk: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Send only what changed — the server rehashes the dedupe key when the
      // front of the card moves, so a no-op field shouldn't trigger that.
      const patch: Parameters<typeof updateCard>[1] = {};
      if (context.trim() !== initial.context.trim()) patch.context = context;
      if (question.trim() !== initial.question.trim()) patch.question = question;
      if (answer.trim() !== initial.answer.trim()) patch.answer = answer;
      if (markOk && status === "needs_review") patch.status = "auto";
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      const result = await updateCard(cardId, patch);
      onSaved(result.card, result.warning);
    } catch (err) {
      setError(
        err instanceof FlashcardsApiError
          ? err.message
          : "Couldn't save the change — check the connection and try again.",
      );
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={`ce-context-${cardId}`} className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">
          The case <span className="font-normal normal-case">(optional — leave empty if the question stands alone)</span>
        </label>
        <textarea
          id={`ce-context-${cardId}`}
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={Math.min(6, Math.max(2, Math.ceil(context.length / 80)))}
          disabled={busy}
          className={`${FIELD} mt-1`}
        />
      </div>
      <div>
        <label htmlFor={`ce-question-${cardId}`} className="text-xs font-semibold tracking-widest text-neutral-500 uppercase">
          Question
        </label>
        <textarea
          id={`ce-question-${cardId}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={Math.min(8, Math.max(2, Math.ceil(question.length / 80)))}
          disabled={busy}
          className={`${FIELD} mt-1`}
        />
      </div>
      <div>
        <label htmlFor={`ce-answer-${cardId}`} className="text-xs font-semibold tracking-widest text-emerald-500 uppercase">
          Answer
        </label>
        <textarea
          id={`ce-answer-${cardId}`}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={Math.min(8, Math.max(2, Math.ceil(answer.length / 80)))}
          disabled={busy}
          className={`${FIELD} mt-1`}
        />
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void save(false)}
          disabled={busy}
          className="rounded-lg bg-neutral-200 px-3.5 py-2 text-xs font-medium text-neutral-900 transition-colors hover:bg-white disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {status === "needs_review" && (
          <button
            type="button"
            onClick={() => void save(true)}
            disabled={busy}
            title="Save the fix and move this card out of the needs-a-look tray, back into study"
            className="rounded-lg border border-emerald-800 bg-emerald-950 px-3.5 py-2 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-900 disabled:opacity-50"
          >
            Save &amp; mark OK
          </button>
        )}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-lg border border-neutral-800 px-3.5 py-2 text-xs text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
