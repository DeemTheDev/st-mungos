"use client";

// The whole "PDF export" — the browser's own print-to-PDF, driven by the
// @media print stylesheet on the page. No jsPDF, no new dependency, and the
// output tracks the real markup instead of a second hand-maintained layout.
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded bg-emerald-700 px-4 py-2 text-sm font-medium text-emerald-50 hover:bg-emerald-600"
    >
      Download PDF
    </button>
  );
}
