"use client";

// /flashcards/browse — search + topic/document/status filters over GET
// /api/flashcards/cards, with expandable answers. needs_review cards are
// flagged amber with an explanation (docs/FLASHCARDS.md §3: orphans that
// survived reconciliation are stored rather than silently dropped).
//
// Print bonus: printing this page yields a clean black-on-white Q&A study
// sheet — answers are always in the DOM (hidden, `print:block`), and the
// filter chrome is `no-print`. "Expand all" doubles as print prep.

import { useEffect, useState } from "react";
import {
  FlashcardsUnavailableError,
  formatPages,
  getCards,
  getDecks,
  type CardInfo,
  type CardStatus,
  type DeckTopic,
  type DocumentInfo,
} from "./api";
import { CaseContext, QuestionBody } from "./question-body";

const TILE = "rounded-xl border border-neutral-800/60 bg-neutral-900/40";
const SELECT =
  "rounded-lg border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-300 focus:border-neutral-500 focus:outline-none";

const PRINT_CSS = `
@media print {
  body { background: #fff !important; }
  .no-print { display: none !important; }
  .fc-browse, .fc-browse * { color: #111 !important; background: transparent !important; border-color: #bbb !important; }
  .fc-card { break-inside: avoid; }
}
`;

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export function BrowseClient({ initialQuery, initialTopic }: { initialQuery: string; initialTopic: string }) {
  const [query, setQuery] = useState(initialQuery);
  const [debouncedQuery, setDebouncedQuery] = useState(initialQuery);
  const [topic, setTopic] = useState(initialTopic);
  const [documentId, setDocumentId] = useState("");
  const [status, setStatus] = useState<CardStatus | "">("");

  const [cards, setCards] = useState<CardInfo[]>([]);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const [topics, setTopics] = useState<DeckTopic[]>([]);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const allExpanded = cards.length > 0 && cards.every((c) => expanded.has(c.id));

  // debounce the free-text query
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(t);
  }, [query]);

  // filter options — best-effort; the card list works without them
  useEffect(() => {
    const ctl = new AbortController();
    getDecks(ctl.signal)
      .then((decks) => {
        setTopics(decks.topics);
        setDocuments(decks.documents.filter((d) => d.status === "ready"));
      })
      .catch(() => {
        /* options stay empty — search alone still works */
      });
    return () => ctl.abort();
  }, []);

  // the card fetch — re-runs on any filter change, cancelling stale requests.
  // Stale results stay visible while the next page loads (no flash of spinner).
  useEffect(() => {
    const ctl = new AbortController();
    getCards({ query: debouncedQuery.trim(), topic, documentId, status }, ctl.signal)
      .then((res) => {
        setCards(res.cards);
        setTotal(res.total);
        setState({ kind: "ready" });
      })
      .catch((err) => {
        if (ctl.signal.aborted) return;
        if (err instanceof FlashcardsUnavailableError) setState({ kind: "unavailable" });
        else setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      });
    return () => ctl.abort();
  }, [debouncedQuery, topic, documentId, status]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="fc-browse">
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      {/* filter bar */}
      <div className={`no-print ${TILE} p-3`}>
        <label className="sr-only" htmlFor="fc-browse-search">
          Search cards
        </label>
        <input
          id="fc-browse-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search questions, answers or topics…"
          className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-500 focus:outline-none"
        />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select aria-label="Filter by topic" value={topic} onChange={(e) => setTopic(e.target.value)} className={SELECT}>
            <option value="">All topics</option>
            {topics.map((t) => (
              <option key={t.topic} value={t.topic}>
                {t.topic} ({t.count})
              </option>
            ))}
            {topic && !topics.some((t) => t.topic === topic) && <option value={topic}>{topic}</option>}
          </select>
          <select
            aria-label="Filter by document"
            value={documentId}
            onChange={(e) => setDocumentId(e.target.value)}
            className={SELECT}
          >
            <option value="">All documents</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.filename}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by card status"
            value={status}
            onChange={(e) => setStatus(e.target.value as CardStatus | "")}
            className={SELECT}
          >
            <option value="">All cards</option>
            <option value="auto">Clean</option>
            <option value="needs_review">Needs a look</option>
          </select>
          <span className="ml-auto text-xs tabular-nums text-neutral-500" aria-live="polite">
            {state.kind === "ready" ? `${total} card${total === 1 ? "" : "s"}` : "…"}
          </span>
          <button
            type="button"
            onClick={() => setExpanded(allExpanded ? new Set() : new Set(cards.map((c) => c.id)))}
            disabled={cards.length === 0}
            className="rounded-lg border border-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 transition-colors hover:border-neutral-600 hover:text-neutral-100 disabled:opacity-40"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </div>

      {/* results */}
      <div className="mt-4">
        {state.kind === "loading" && <p className="text-sm text-neutral-600">Leafing through the cards…</p>}

        {state.kind === "unavailable" && (
          <div className={`${TILE} p-8 text-center`}>
            <p className="text-sm text-neutral-200">The card store isn&apos;t connected yet.</p>
            <p className="mx-auto mt-2 max-w-sm text-sm text-neutral-500">
              The backend is still being wired in — once it lands, every extracted card becomes searchable here.
            </p>
          </div>
        )}

        {state.kind === "error" && (
          <p className="rounded-lg bg-amber-950 p-3 text-sm text-amber-300">Couldn&apos;t search: {state.message}</p>
        )}

        {state.kind === "ready" && cards.length === 0 && (
          <div className={`${TILE} p-8 text-center`}>
            <p className="text-sm text-neutral-300">No cards match.</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-500">
              {debouncedQuery || topic || documentId || status
                ? "Loosen a filter or try different words — full-text search covers questions, answers and topics."
                : "Upload a document on the flashcards page and its cards will show up here."}
            </p>
          </div>
        )}

        {state.kind === "ready" && cards.length > 0 && (
          <ul className="space-y-2">
            {cards.map((card) => {
              const needs = card.status === "needs_review";
              const isOpen = expanded.has(card.id);
              const pages = formatPages(card.sourcePages);
              return (
                <li
                  key={card.id}
                  className={`fc-card rounded-xl border p-4 ${
                    needs ? "border-amber-900/60 bg-amber-950/15" : "border-neutral-800/60 bg-neutral-900/40"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300">{card.topic}</span>
                    {pages && <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-500">{pages}</span>}
                    {needs && (
                      <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs text-amber-300">needs a look</span>
                    )}
                  </div>
                  <div className="mt-2.5">
                    {/* Front-of-card, so it prints above the question on the
                        study sheet too — never inside the answer block. */}
                    <CaseContext context={card.context ?? ""} compact />
                    <QuestionBody question={card.question} compact />
                  </div>
                  <button
                    type="button"
                    onClick={() => toggle(card.id)}
                    aria-expanded={isOpen}
                    className="no-print mt-2.5 rounded-lg border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:outline-none"
                  >
                    {isOpen ? "Hide answer" : "Show answer"}
                  </button>
                  <div className={`${isOpen ? "block" : "hidden"} print:block mt-2.5`}>
                    <p className="text-xs font-semibold tracking-widest text-emerald-400 uppercase">Answer</p>
                    <p className="mt-1 text-sm whitespace-pre-wrap text-neutral-200">
                      {card.answer || "(no answer text)"}
                    </p>
                    {needs && (
                      <p className="mt-2 text-xs text-amber-300/90">
                        The extractor couldn&apos;t confidently pair this question with its answer — check it against{" "}
                        {pages ? `the original (${pages})` : "the source document"} before trusting it.
                      </p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
