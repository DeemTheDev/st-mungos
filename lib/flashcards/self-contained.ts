// The self-containment invariant (docs/FLASHCARDS.md §5.5).
//
// A flashcard must be answerable from what is ON the card. Retrieval practice
// only works if the prompt is complete: "How do you manage the patient?" with
// the vignette stripped off is not a hard card, it is an impossible one, and
// she hit exactly that in production.
//
// The extraction prompt is the primary defence (it copies the governing
// vignette into `context` on every sub-question). This module is the SAFETY
// NET underneath it: a cheap, deterministic, model-free check that runs at
// insert time AND again when the review queue is built, so a future prompt
// regression can never put a dangling card in front of her. Cards that fail it
// become `needs_review` and surface in the tray instead.
//
// Design bias: PRECISION over recall. A false positive pulls a good card out of
// study; a false negative just leaves a card the repair script or a human will
// catch later. So a card is only flagged when BOTH halves of the rule hold —
// it leans on an anaphor AND names nothing specific of its own.

/** Question openings that mark a card front as an actual question/instruction. */
const QUESTION_FRAME_RE =
  /^\s*(?:\d+[.)]\s*)?(?:how|what|why|when|where|which|who|whose|list|name|describe|give|explain|state|outline|discuss|mention|define|identify|classify|interpret|comment|elaborate|is|are|was|were|do|does|did|can|could|would|should|will|has|have)\b/i;

/**
 * Anaphors — references that can only resolve against a stem the card no longer
 * carries. Third-person pronouns, plus determiner + generic clinical noun
 * ("the patient", "this condition", "the diagnosis"), plus discourse pointers.
 */
const ANAPHOR_RE = new RegExp(
  [
    // bare third-person pronouns used as subject/object/possessive
    String.raw`\b(?:he|she|it|they|him|her|his|hers|them|their|theirs|its)\b`,
    // the/this/that/these/those + a generic clinical noun
    String.raw`\b(?:the|this|that|these|those)\s+(?:above\s+)?(?:${[
      "patient",
      "patients",
      "case",
      "cases",
      "scenario",
      "vignette",
      "condition",
      "conditions",
      "disease",
      "diseases",
      "disorder",
      "illness",
      "diagnosis",
      "diagnoses",
      "differential",
      "differentials",
      "management",
      "treatment",
      "therapy",
      "investigation",
      "investigations",
      "complication",
      "complications",
      "aetiology",
      "etiology",
      "pathophysiology",
      "pathogenesis",
      "lesion",
      "lesions",
      "rash",
      "murmur",
      "organism",
      "organisms",
      "drug",
      "drugs",
      "condition's",
      "prognosis",
      "presentation",
      "syndrome",
      "infection",
      "tumour",
      "tumor",
      "mass",
      "picture",
      "result",
      "results",
      "finding",
      "findings",
    ].join("|")})\b`,
    // discourse pointers back to something off-card
    String.raw`\b(?:the|as)\s+(?:above|below|following|previous|mentioned|described|shown|given)\b`,
    String.raw`\bmentioned\s+above\b`,
  ].join("|"),
  "i",
);

/** Function words — never evidence that a card names its own subject. */
const STOPWORDS = new Set(
  (
    "a an and any are as at be been being between both but by can could did do does during each " +
    "for from further had has have here how i if in into is it its just least like may might more " +
    "most must no nor not of off on once only or other others another out over own per please same " +
    "should so some such than that the their them then there these they this those through to too " +
    "under up us use used using very was were what when where which while who whom whose why will " +
    "with within would you your about above after again against all almost also always am among " +
    "because before below down even ever every few first second third fourth fifth last next new old " +
    "young one two three four five six seven eight nine ten many much several main major minor best " +
    "worst good bad high low long short big small likely possible probable common rare typical classic " +
    "specific general initial definitive immediate supportive early late acute chronic mild moderate " +
    "severe following mentioned said seen found expected given get got make made take taken put " +
    "list name describe give explain state outline discuss mention define identify classify interpret " +
    "comment elaborate tell show write draw"
  ).split(/\s+/),
);

/**
 * Domain-generic vocabulary: the scaffolding of a clinical question. These
 * words appear on every card, so they can never be the thing that makes a
 * particular card answerable.
 */
const GENERIC_CLINICAL = new Set(
  (
    "patient patients case cases scenario scenarios vignette condition conditions disease diseases " +
    "disorder disorders illness illnesses diagnosis diagnoses diagnose diagnosed diagnosing diagnostic " +
    "differential differentials ddx management manage managed managing treat treated treating treatment " +
    "treatments therapy therapies investigation investigations investigate test tests testing " +
    "complication complications aetiology aetiologies aetiological etiology etiologies cause causes " +
    "caused causing causative pathophysiology pathogenesis mechanism mechanisms sign signs symptom " +
    "symptoms feature features finding findings presentation present presents presented presenting " +
    "risk risks factor factors prognosis criteria criterion phenomena phenomenon lesion lesions drug " +
    "drugs medication medications dose doses dosage organism organisms pathogen pathogens score scores " +
    "scoring classification classify stage stages staging grade grades definition define approach " +
    "approaches step steps stepwise option options answer answers question questions type types class " +
    "classes category categories difference differences result results value values level levels " +
    "examination exam history prevention prevent prophylaxis follow followup referral indication " +
    "indications contraindication contraindications side effect effects outcome outcome outcomes " +
    "line gold standard reason reasons explanation prescribe prescribed advise advice counsel " +
    "assessment assess evaluate evaluation workup work up plan"
  ).split(/\s+/),
);

/** The card fields the check reads. Deliberately structural, not the full FcCard. */
export interface SelfContainmentInput {
  /** The governing vignette/stem; "" when the question stands alone. */
  context: string;
  question: string;
  /** MCQ options — they are on the card front, so they count as content. */
  options?: string[];
}

export type DanglingReason = "dangling-referent" | null;

/**
 * Tokens that could anchor recall: everything left after function words,
 * domain-generic scaffolding, numbers and short fragments are removed.
 */
/**
 * Uppercase clinical abbreviations are among the MOST specific things a question
 * can name — "What is the management of TB?" needs no vignette — but they are
 * two or three letters, so a plain length filter throws them away and the card
 * gets pulled from study as if it were dangling. Collected before lowercasing,
 * minus the shouty MCQ scaffolding that carries no meaning.
 */
const SHOUTY_NON_CLINICAL = new Set([
  "EXCEPT", "TRUE", "FALSE", "ALL", "NOT", "AND", "OR", "THE", "NONE", "BEST", "MOST", "LEAST", "NB",
]);

function abbreviations(text: string): string[] {
  return (text.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? []).filter((t) => !SHOUTY_NON_CLINICAL.has(t));
}

function specificTokens(text: string): string[] {
  const abbrevs = abbreviations(text);
  if (abbrevs.length > 0) return abbrevs;
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter((t) => t.length >= 3)
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !STOPWORDS.has(t))
    .filter((t) => !GENERIC_CLINICAL.has(t))
    // "45-year-old", "3-day": age/duration fragments are vignette detail, not subject
    .filter((t) => !/^\d+-?(?:year|yr|month|week|day|hour)s?(?:-old)?$/.test(t));
}

/**
 * THE RULE. A card fails self-containment when all three hold:
 *   1. it carries no `context` (nothing supplies the missing stem), and
 *   2. its front reads as a question/instruction, and
 *   3. it leans on an anaphor ("the patient", "it", "this condition", "the
 *      above") while naming nothing specific of its own.
 *
 * Returns the reason it failed, or null when the card is fine — so callers can
 * log WHY a card was pulled rather than just that it was.
 */
export function danglingReferentReason(card: SelfContainmentInput): DanglingReason {
  if (card.context.trim().length > 0) return null;

  const question = card.question.trim();
  if (question.length === 0) return null; // empty questions are a different defect
  if (!QUESTION_FRAME_RE.test(question) && !question.endsWith("?")) return null;

  if (!ANAPHOR_RE.test(question)) return null;

  // MCQ options sit on the front, so a question whose options name real drugs
  // or diagnoses is answerable even if the stem is terse.
  const front = [question, ...(card.options ?? [])].join(" ");
  if (specificTokens(front).length > 0) return null;

  return "dangling-referent";
}

/** Convenience wrapper — the shape most call sites want. */
export function isSelfContained(card: SelfContainmentInput): boolean {
  return danglingReferentReason(card) === null;
}
