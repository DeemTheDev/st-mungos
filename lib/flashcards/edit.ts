// Manual card editing — the human end of the quality loop. Extraction is
// probabilistic and the repair passes are deterministic-only, so the last mile
// is Azra spotting a wrong answer mid-review and fixing it on the spot. An
// edit changes card CONTENT, never card identity: the id (and with it the
// FSRS scheduling history) survives, because fixing a typo in an answer does
// not mean she has to relearn the card from scratch.
import { qhashOf } from "./pipeline";
import { danglingReferentReason } from "./self-contained";
import type { FcStore } from "./store";
import type { FcCard, FcCardStatus } from "./types";

export interface CardEdit {
  question?: string;
  answer?: string;
  context?: string;
  options?: string[];
  status?: FcCardStatus;
}

export interface CardEditResult {
  card: FcCard;
  /** Non-null when the edited card STILL doesn't stand alone — shown as a
   *  notice, never a save-blocker: her judgment outranks the heuristic. */
  selfContainmentWarning: string | null;
}

export class CardEditError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CardEditError";
  }
}

const MAX_FIELD_CHARS = 8000;

function cleanText(value: unknown, field: string, allowEmpty: boolean): string {
  if (typeof value !== "string") throw new CardEditError(`${field} must be text.`, 400);
  const text = value.trim();
  if (!allowEmpty && text.length === 0) {
    throw new CardEditError(`A card needs a ${field} — clearing it would make the card unstudiable.`, 400);
  }
  if (text.length > MAX_FIELD_CHARS) {
    throw new CardEditError(`That ${field} is longer than ${MAX_FIELD_CHARS} characters — split the card instead.`, 400);
  }
  return text;
}

export async function applyCardEdit(store: FcStore, id: string, edit: CardEdit): Promise<CardEditResult> {
  const card = await store.getCard(id);
  if (!card) throw new CardEditError("That card no longer exists — it may have been rebuilt away.", 404);

  const patch: Partial<Omit<FcCard, "id" | "documentId" | "createdAt">> = {};

  if (edit.question !== undefined) patch.question = cleanText(edit.question, "question", false);
  if (edit.answer !== undefined) patch.answer = cleanText(edit.answer, "answer", false);
  // Context may legitimately be cleared — "this question stands alone".
  if (edit.context !== undefined) patch.context = cleanText(edit.context, "context", true);
  if (edit.options !== undefined) {
    if (!Array.isArray(edit.options) || edit.options.some((o) => typeof o !== "string")) {
      throw new CardEditError("options must be a list of text choices.", 400);
    }
    patch.options = edit.options.map((o) => o.trim()).filter((o) => o.length > 0);
  }
  if (edit.status !== undefined) {
    if (edit.status !== "auto" && edit.status !== "needs_review") {
      throw new CardEditError('status must be "auto" or "needs_review".', 400);
    }
    patch.status = edit.status;
  }
  if (Object.keys(patch).length === 0) throw new CardEditError("Nothing to change.", 400);

  const next: FcCard = { ...card, ...patch };

  // qhash is the per-document dedupe key over (context + question), so editing
  // either must rehash — otherwise a reworded card still blocks the slot its
  // old wording occupied, and a future re-extraction would dedupe against a
  // hash that no longer matches any visible text.
  if (patch.question !== undefined || patch.context !== undefined) {
    patch.qhash = qhashOf(next.question, next.context);
  }

  const warning = danglingReferentReason({
    context: next.context,
    question: next.question,
    options: next.options,
  });

  try {
    await store.updateCard(id, patch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The unique(document_id, qhash) index refusing the rehash means her new
    // wording collides with a card that already exists.
    if (/duplicate|unique|conflict|23505/i.test(message)) {
      throw new CardEditError("Another card in this document already asks exactly that — edit that one instead.", 409);
    }
    throw err;
  }

  return {
    card: next,
    selfContainmentWarning: warning
      ? "This card still doesn't stand alone (the question leans on a case that isn't attached). Saved anyway — add the case text if it needs one."
      : null,
  };
}
