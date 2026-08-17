// MCQ-aware question renderer shared by the review player and the browse list.
// The contract says a card's question "may include MCQ options" embedded in the
// text (docs/FLASHCARDS.md §8.2 keeps distractors on the front, like the real
// exam). We detect option lines conservatively — at least two consecutive
// "A. / B) / (C)" style lines with distinct labels — and render them as a clean
// list; anything that doesn't match renders as plain pre-wrapped text, so a
// false negative costs nothing.

export interface McqParts {
  stem: string;
  options: Array<{ label: string; text: string }>;
}

const OPTION_RE = /^\s*\(?([A-Ha-h]|[1-9])[).:\]]\s+(.+)$/;

export function parseMcq(question: string): McqParts | null {
  const lines = question.split(/\r?\n/);
  let firstOption = -1;
  for (let i = 0; i < lines.length; i++) {
    if (OPTION_RE.test(lines[i])) {
      firstOption = i;
      break;
    }
  }
  if (firstOption <= 0) return null; // no options, or no stem before them

  const options: Array<{ label: string; text: string }> = [];
  for (let i = firstOption; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(OPTION_RE);
    if (m) {
      options.push({ label: m[1].toUpperCase(), text: m[2].trim() });
    } else if (line.trim() && options.length > 0) {
      // continuation of the previous option (wrapped line)
      options[options.length - 1].text += ` ${line.trim()}`;
    }
  }
  const labels = new Set(options.map((o) => o.label));
  if (options.length < 2 || labels.size !== options.length) return null;

  const stem = lines.slice(0, firstOption).join("\n").trim();
  if (!stem) return null;
  return { stem, options };
}

export function QuestionBody({ question, compact = false }: { question: string; compact?: boolean }) {
  const mcq = parseMcq(question);
  const stemClass = compact
    ? "text-sm text-neutral-100 whitespace-pre-wrap"
    : "text-base sm:text-lg text-neutral-100 whitespace-pre-wrap";

  if (!mcq) return <p className={stemClass}>{question.trim()}</p>;

  return (
    <div>
      <p className={stemClass}>{mcq.stem}</p>
      <ol className={compact ? "mt-2 space-y-1" : "mt-4 space-y-2"}>
        {mcq.options.map((o) => (
          <li
            key={o.label}
            className={`flex items-baseline gap-2.5 rounded-lg border border-neutral-800 bg-neutral-950/40 ${
              compact ? "px-2.5 py-1.5 text-sm" : "px-3 py-2 text-sm sm:text-base"
            }`}
          >
            <span className="shrink-0 font-medium text-emerald-400">{o.label}</span>
            <span className="text-neutral-200">{o.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
