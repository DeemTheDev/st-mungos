// Deterministic ABG generation + physiology validation (CLAUDE.md §4b).
//
// Values are computed IN CODE, never by the LLM. Validation is deterministic —
// Henderson-Hasselbalch consistency, expected-compensation rules, anion gap —
// "validate with physiology, not vibes". The generator rejects any internally
// inconsistent gas before it ever reaches a prompt.

import type { z } from "zod";
import { AbgValuesSchema, type Discipline } from "./case-schema";

export type AbgValues = z.infer<typeof AbgValuesSchema>;

export const KPA_TO_MMHG = 7.50062;
/** Max allowed |measured pH − Henderson-Hasselbalch predicted pH|. */
export const HH_TOLERANCE = 0.03;

export type Rng = () => number;

export type AcidBasePattern =
  | { kind: "metabolic-acidosis"; anionGap: "high" | "normal" }
  // e.g. salicylate: metabolic acidosis PLUS a primary respiratory alkalosis
  | { kind: "metabolic-acidosis-mixed-resp-alkalosis"; anionGap: "high" }
  | { kind: "metabolic-alkalosis" }
  | { kind: "respiratory-acidosis"; tempo: "acute" | "chronic" | "acute-on-chronic" }
  | { kind: "respiratory-alkalosis"; tempo: "acute" };

export interface AbgIssue {
  check: string;
  detail: string;
}

export interface AbgFinding {
  finding: string;
  critical: boolean;
}

export interface AbgArchetype {
  id: string;
  /** Human label, e.g. "Diabetic ketoacidosis". */
  label: string;
  /** The station's final diagnosis line (used verbatim; drives dedupe). */
  diagnosis: string;
  discipline: Discipline;
  commonness: "common" | "uncommon";
  difficulty: 1 | 2 | 3;
  pattern: AcidBasePattern;
  /** Clinical context the LLM should build the vignette around. */
  vignetteSeed: string;
  /** One-line synthesis — the model interpretation the student should reach. */
  interpretation: string;
  sample(rng: Rng): AbgValues;
}

export interface GeneratedAbg {
  archetype: AbgArchetype;
  values: AbgValues;
  findings: AbgFinding[];
}

// ---------------------------------------------------------------------------
// helpers

const round = (x: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
};

const uniform = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();

/** pH predicted by Henderson-Hasselbalch from HCO3 (mmol/L) + pCO2 (kPa). */
export function hendersonHasselbalchPh(hco3: number, pCO2_kPa: number): number {
  return 6.1 + Math.log10(hco3 / (0.03 * pCO2_kPa * KPA_TO_MMHG));
}

export function anionGap(v: AbgValues): number | null {
  if (v.Na == null || v.Cl == null) return null;
  return round(v.Na - v.Cl - v.HCO3, 1);
}

interface BuildOpts {
  hco3: number;
  pco2mmHg: number;
  po2kPa: number;
  na: number;
  /** Either give a target anion gap (Cl is derived) or an explicit Cl. */
  agTarget?: number;
  cl?: number;
  k: number;
  lactate: number;
}

/**
 * Assemble a rounded value set whose pH is computed from the ROUNDED HCO3 and
 * pCO2 — so Henderson-Hasselbalch consistency survives rounding by construction.
 */
function buildValues(o: BuildOpts): AbgValues {
  const HCO3 = round(o.hco3, 1);
  const pCO2_kPa = round(o.pco2mmHg / KPA_TO_MMHG, 1);
  const pH = round(hendersonHasselbalchPh(HCO3, pCO2_kPa), 2);
  const Na = Math.round(o.na);
  const Cl = o.cl != null ? Math.round(o.cl) : Math.round(Na - HCO3 - (o.agTarget ?? 10));
  // Van Slyke-style approximation of base excess from pH + HCO3.
  const BE = round(0.9287 * HCO3 + 13.77 * pH - 124.58, 1);
  return {
    pH,
    pCO2_kPa,
    pO2_kPa: round(o.po2kPa, 1),
    HCO3,
    BE,
    Na,
    Cl,
    K: round(o.k, 1),
    lactate: round(o.lactate, 1),
  };
}

// ---------------------------------------------------------------------------
// validation — deterministic physiology checks

const AG_NORMAL: [number, number] = [5, 15];
const AG_HIGH: [number, number] = [16, 32];

/**
 * Validate a gas against physiology for the intended acid-base pattern.
 * Empty array = physiologically consistent. Checks:
 *  - plausible ranges
 *  - Henderson-Hasselbalch consistency (±HH_TOLERANCE)
 *  - expected compensation (Winter's ±2 mmHg for metabolic acidosis;
 *    ΔHCO3 ≈ 1 per 10 mmHg ΔpCO2 acute resp, ≈ 3.5–4 per 10 chronic;
 *    pCO2 ≈ 40 + 0.7×ΔHCO3 ± 5 for metabolic alkalosis)
 *  - anion gap in the range the pattern demands
 */
export function validateAbg(v: AbgValues, pattern: AcidBasePattern): AbgIssue[] {
  const issues: AbgIssue[] = [];
  const pco2 = v.pCO2_kPa * KPA_TO_MMHG; // mmHg

  // -- plausibility ranges
  if (v.pH < 6.8 || v.pH > 7.75) issues.push({ check: "range", detail: `pH ${v.pH} outside survivable range` });
  if (v.pCO2_kPa < 1.5 || v.pCO2_kPa > 16) issues.push({ check: "range", detail: `pCO2 ${v.pCO2_kPa} kPa implausible` });
  if (v.HCO3 < 4 || v.HCO3 > 50) issues.push({ check: "range", detail: `HCO3 ${v.HCO3} implausible` });
  if (v.pO2_kPa < 3 || v.pO2_kPa > 60) issues.push({ check: "range", detail: `pO2 ${v.pO2_kPa} kPa implausible` });

  // -- Henderson-Hasselbalch consistency
  const predicted = hendersonHasselbalchPh(v.HCO3, v.pCO2_kPa);
  if (Math.abs(predicted - v.pH) > HH_TOLERANCE) {
    issues.push({
      check: "henderson-hasselbalch",
      detail: `pH ${v.pH} vs predicted ${round(predicted, 3)} (Δ ${round(Math.abs(predicted - v.pH), 3)} > ${HH_TOLERANCE})`,
    });
  }

  // -- anion gap
  const ag = anionGap(v);
  if (ag != null) {
    const wantsHighAg =
      pattern.kind === "metabolic-acidosis-mixed-resp-alkalosis" ||
      (pattern.kind === "metabolic-acidosis" && pattern.anionGap === "high");
    const [lo, hi] = wantsHighAg ? AG_HIGH : AG_NORMAL;
    if (ag < lo || ag > hi) {
      issues.push({
        check: "anion-gap",
        detail: `AG ${ag} outside expected ${wantsHighAg ? "high" : "normal"} range [${lo}, ${hi}]`,
      });
    }
  }

  // -- expected compensation
  switch (pattern.kind) {
    case "metabolic-acidosis": {
      const winters = 1.5 * v.HCO3 + 8;
      if (Math.abs(pco2 - winters) > 2) {
        issues.push({
          check: "winters-formula",
          detail: `pCO2 ${round(pco2, 1)} mmHg vs Winter's expected ${round(winters, 1)} ± 2`,
        });
      }
      break;
    }
    case "metabolic-acidosis-mixed-resp-alkalosis": {
      // Signature of the mix: pCO2 clearly BELOW Winter's prediction.
      const winters = 1.5 * v.HCO3 + 8;
      if (pco2 > winters - 3) {
        issues.push({
          check: "mixed-disorder",
          detail: `pCO2 ${round(pco2, 1)} mmHg not clearly below Winter's ${round(winters, 1)} — no superimposed respiratory alkalosis`,
        });
      }
      if (pco2 < 10) issues.push({ check: "mixed-disorder", detail: `pCO2 ${round(pco2, 1)} mmHg implausibly low` });
      break;
    }
    case "metabolic-alkalosis": {
      if (v.HCO3 < 30) issues.push({ check: "compensation", detail: `HCO3 ${v.HCO3} too low for a primary metabolic alkalosis stimulus` });
      const expected = 40 + 0.7 * (v.HCO3 - 24);
      if (Math.abs(pco2 - expected) > 5) {
        issues.push({
          check: "compensation",
          detail: `pCO2 ${round(pco2, 1)} mmHg vs expected hypoventilatory compensation ${round(expected, 1)} ± 5`,
        });
      }
      if (pco2 > 57) issues.push({ check: "compensation", detail: "compensatory hypoventilation rarely exceeds ~55 mmHg" });
      break;
    }
    case "respiratory-acidosis": {
      const dp = pco2 - 40;
      if (dp < 5) {
        issues.push({ check: "compensation", detail: `pCO2 ${round(pco2, 1)} mmHg barely raised — not a respiratory acidosis` });
        break;
      }
      const acute = 24 + 1.0 * (dp / 10);
      const chronicLo = 24 + 3.2 * (dp / 10);
      const chronicHi = 24 + 4.5 * (dp / 10);
      if (pattern.tempo === "acute" && Math.abs(v.HCO3 - acute) > 2) {
        issues.push({ check: "compensation", detail: `HCO3 ${v.HCO3} vs acute expected ${round(acute, 1)} ± 2 (≈1 per 10 mmHg)` });
      }
      if (pattern.tempo === "chronic" && (v.HCO3 < chronicLo || v.HCO3 > chronicHi)) {
        issues.push({ check: "compensation", detail: `HCO3 ${v.HCO3} vs chronic expected [${round(chronicLo, 1)}, ${round(chronicHi, 1)}] (≈3.5–4 per 10 mmHg)` });
      }
      if (pattern.tempo === "acute-on-chronic") {
        // Between the acute and chronic predictions — raised, but pH still acidaemic.
        const lo = 24 + 1.5 * (dp / 10);
        const hi = 24 + 3.5 * (dp / 10);
        if (v.HCO3 <= lo || v.HCO3 >= hi) {
          issues.push({ check: "compensation", detail: `HCO3 ${v.HCO3} not between acute and chronic predictions (${round(lo, 1)}–${round(hi, 1)}) for acute-on-chronic` });
        }
        if (v.pH >= 7.35) issues.push({ check: "compensation", detail: `pH ${v.pH} not acidaemic — looks fully compensated (chronic), not acute-on-chronic` });
      }
      break;
    }
    case "respiratory-alkalosis": {
      const dp = 40 - pco2;
      if (dp < 5) {
        issues.push({ check: "compensation", detail: `pCO2 ${round(pco2, 1)} mmHg barely low — not a respiratory alkalosis` });
        break;
      }
      const acute = 24 - 2.0 * (dp / 10);
      if (Math.abs(v.HCO3 - acute) > 2) {
        issues.push({ check: "compensation", detail: `HCO3 ${v.HCO3} vs acute expected ${round(acute, 1)} ± 2 (≈2 per 10 mmHg fall)` });
      }
      if (v.HCO3 < 16) issues.push({ check: "compensation", detail: `HCO3 ${v.HCO3} too low for an acute respiratory alkalosis alone` });
      break;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// deterministic findings — seeds the case's findingsKey

export function deriveAbgFindings(v: AbgValues, pattern: AcidBasePattern): AbgFinding[] {
  const findings: AbgFinding[] = [];
  const pco2 = round(v.pCO2_kPa * KPA_TO_MMHG, 0);

  if (v.pH < 7.35) findings.push({ finding: `Acidaemia (pH ${v.pH})`, critical: true });
  else if (v.pH > 7.45) findings.push({ finding: `Alkalaemia (pH ${v.pH})`, critical: true });
  else findings.push({ finding: `pH in normal range (${v.pH}) — fully compensated or mixed picture`, critical: true });

  switch (pattern.kind) {
    case "metabolic-acidosis":
      findings.push({ finding: `Low HCO3 (${v.HCO3}) → primary metabolic acidosis`, critical: true });
      findings.push({ finding: `pCO2 ${v.pCO2_kPa} kPa (~${pco2} mmHg) matches Winter's prediction → appropriate respiratory compensation`, critical: true });
      break;
    case "metabolic-acidosis-mixed-resp-alkalosis":
      findings.push({ finding: `Low HCO3 (${v.HCO3}) → metabolic acidosis component`, critical: true });
      findings.push({ finding: `pCO2 lower than Winter's formula predicts → co-existing primary respiratory alkalosis (mixed disorder)`, critical: true });
      break;
    case "metabolic-alkalosis":
      findings.push({ finding: `Raised HCO3 (${v.HCO3}) → primary metabolic alkalosis`, critical: true });
      findings.push({ finding: `Raised pCO2 (${v.pCO2_kPa} kPa) → appropriate hypoventilatory compensation`, critical: true });
      break;
    case "respiratory-acidosis": {
      findings.push({ finding: `Raised pCO2 (${v.pCO2_kPa} kPa) → primary respiratory acidosis`, critical: true });
      if (pattern.tempo === "acute") findings.push({ finding: `HCO3 near normal (${v.HCO3}) → acute — no time for renal compensation`, critical: true });
      if (pattern.tempo === "chronic") findings.push({ finding: `HCO3 raised ≈3.5–4 per 10 mmHg pCO2 (${v.HCO3}) → chronic, metabolically compensated`, critical: true });
      if (pattern.tempo === "acute-on-chronic") findings.push({ finding: `HCO3 raised (${v.HCO3}) but pH still acidaemic → acute deterioration on a chronic respiratory acidosis`, critical: true });
      break;
    }
    case "respiratory-alkalosis":
      findings.push({ finding: `Low pCO2 (${v.pCO2_kPa} kPa) → primary respiratory alkalosis`, critical: true });
      findings.push({ finding: `HCO3 only mildly reduced (${v.HCO3}) → acute process`, critical: true });
      break;
  }

  const ag = anionGap(v);
  if (ag != null) {
    if (ag >= 16) findings.push({ finding: `Raised anion gap (~${Math.round(ag)})`, critical: true });
    else findings.push({ finding: `Normal anion gap (~${Math.round(ag)})`, critical: false });
  }

  if (v.pO2_kPa < 8 && v.pCO2_kPa > 6) {
    findings.push({ finding: `Type 2 respiratory failure (pO2 ${v.pO2_kPa} kPa with pCO2 ${v.pCO2_kPa} kPa)`, critical: true });
  } else if (v.pO2_kPa < 8) {
    findings.push({ finding: `Type 1 respiratory failure (pO2 ${v.pO2_kPa} kPa, pCO2 not raised)`, critical: true });
  } else {
    findings.push({ finding: `No significant hypoxaemia (pO2 ${v.pO2_kPa} kPa)`, critical: false });
  }

  if (v.lactate != null && v.lactate > 2) {
    findings.push({ finding: `Raised lactate (${v.lactate} mmol/L)`, critical: v.lactate > 4 });
  }
  if (v.K != null && v.K < 3.3) findings.push({ finding: `Hypokalaemia (K ${v.K})`, critical: v.K < 3.0 });
  if (v.K != null && v.K > 5.5) findings.push({ finding: `Hyperkalaemia (K ${v.K})`, critical: true });

  return findings;
}

// ---------------------------------------------------------------------------
// scenario archetypes

export const ABG_ARCHETYPES: AbgArchetype[] = [
  {
    id: "dka",
    label: "Diabetic ketoacidosis",
    diagnosis: "Diabetic ketoacidosis (high anion gap metabolic acidosis with appropriate respiratory compensation)",
    discipline: "endo",
    commonness: "common",
    difficulty: 2,
    pattern: { kind: "metabolic-acidosis", anionGap: "high" },
    vignetteSeed:
      "Young adult, known or newly diagnosed type 1 diabetes, 2 days of vomiting, polyuria, polydipsia and abdominal pain; Kussmaul breathing; fingerprick glucose high (>20 mmol/L); ketones positive. ABG on room air.",
    interpretation:
      "High anion gap metabolic acidosis with appropriate respiratory compensation (Winter's) — diabetic ketoacidosis",
    sample(rng) {
      const hco3 = uniform(rng, 6, 14);
      const pco2 = 1.5 * hco3 + 8 + uniform(rng, -1.5, 1.5);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 12, 14),
        na: uniform(rng, 130, 137),
        agTarget: uniform(rng, 22, 30),
        k: uniform(rng, 4.9, 5.9),
        lactate: uniform(rng, 1.0, 2.4),
      });
    },
  },
  {
    id: "sepsis-lactic",
    label: "Septic shock with lactic acidosis",
    diagnosis: "Sepsis with lactic acidosis (high anion gap metabolic acidosis, raised lactate)",
    discipline: "id",
    commonness: "common",
    difficulty: 2,
    pattern: { kind: "metabolic-acidosis", anionGap: "high" },
    vignetteSeed:
      "Middle-aged patient, 3 days of productive cough and fevers, now confused and hypotensive (BP ~85/50) with cool peripheries; known HIV on ART is a plausible KZN backdrop. ABG on 40% face mask oxygen.",
    interpretation:
      "High anion gap metabolic acidosis driven by lactate, appropriate respiratory compensation — septic shock with tissue hypoperfusion",
    sample(rng) {
      const hco3 = uniform(rng, 9, 16);
      const pco2 = 1.5 * hco3 + 8 + uniform(rng, -1.5, 1.5);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 8.5, 11.5),
        na: uniform(rng, 133, 140),
        agTarget: uniform(rng, 19, 26),
        k: uniform(rng, 3.8, 5.2),
        lactate: uniform(rng, 4.5, 9.0),
      });
    },
  },
  {
    id: "salicylate",
    label: "Salicylate overdose",
    diagnosis: "Salicylate toxicity (mixed high anion gap metabolic acidosis and primary respiratory alkalosis)",
    discipline: "renal",
    commonness: "uncommon",
    difficulty: 3,
    pattern: { kind: "metabolic-acidosis-mixed-resp-alkalosis", anionGap: "high" },
    vignetteSeed:
      "Young adult found with an empty aspirin packet after a deliberate ingestion ~6 hours earlier; tinnitus, nausea, sweating, hyperventilating. ABG on room air.",
    interpretation:
      "Mixed disorder: high anion gap metabolic acidosis PLUS a primary respiratory alkalosis (pCO2 below Winter's prediction) — classic salicylate poisoning",
    sample(rng) {
      const hco3 = uniform(rng, 12, 18);
      const winters = 1.5 * hco3 + 8;
      const pco2 = Math.max(14, winters - uniform(rng, 5, 12));
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 12, 14.5),
        na: uniform(rng, 135, 141),
        agTarget: uniform(rng, 18, 24),
        k: uniform(rng, 3.2, 4.2),
        lactate: uniform(rng, 1.5, 3.0),
      });
    },
  },
  {
    id: "vomiting-alkalosis",
    label: "Hypochloraemic metabolic alkalosis from protracted vomiting",
    diagnosis: "Hypochloraemic hypokalaemic metabolic alkalosis secondary to protracted vomiting (gastric outlet obstruction)",
    discipline: "gi-hep",
    commonness: "common",
    difficulty: 2,
    pattern: { kind: "metabolic-alkalosis" },
    vignetteSeed:
      "Adult with a week of persistent non-bilious vomiting and epigastric fullness (peptic ulcer disease with gastric outlet obstruction is the classic KZN ward story); dehydrated with dry mucous membranes. ABG on room air.",
    interpretation:
      "Hypochloraemic, hypokalaemic metabolic alkalosis with appropriate hypoventilatory compensation — protracted vomiting with loss of gastric HCl",
    sample(rng) {
      const hco3 = uniform(rng, 34, 42);
      const pco2 = 40 + 0.7 * (hco3 - 24) + uniform(rng, -3.5, 3.5);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 10.5, 13),
        na: uniform(rng, 133, 139),
        agTarget: uniform(rng, 8, 12), // Cl derived → automatically hypochloraemic
        k: uniform(rng, 2.5, 3.2),
        lactate: uniform(rng, 0.7, 1.6),
      });
    },
  },
  {
    id: "copd-acute-on-chronic",
    label: "Infective exacerbation of COPD",
    diagnosis: "Acute-on-chronic type 2 respiratory failure (infective exacerbation of COPD)",
    discipline: "resp",
    commonness: "common",
    difficulty: 2,
    pattern: { kind: "respiratory-acidosis", tempo: "acute-on-chronic" },
    vignetteSeed:
      "Older long-term smoker with known COPD, 3 days of worsening breathlessness, increased sputum volume and purulence; drowsy, using accessory muscles, audible wheeze. ABG on room air.",
    interpretation:
      "Respiratory acidosis with HCO3 raised between acute and chronic predictions and persistent acidaemia — acute-on-chronic type 2 respiratory failure",
    sample(rng) {
      const pco2 = uniform(rng, 62, 78);
      const slope = uniform(rng, 2.0, 3.2);
      const hco3 = 24 + slope * ((pco2 - 40) / 10);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 6.0, 7.8),
        na: uniform(rng, 137, 142),
        agTarget: uniform(rng, 8, 13),
        k: uniform(rng, 3.8, 4.8),
        lactate: uniform(rng, 0.8, 2.0),
      });
    },
  },
  {
    id: "copd-chronic-stable",
    label: "Stable chronic type 2 respiratory failure",
    diagnosis: "Compensated chronic type 2 respiratory failure (stable severe COPD)",
    discipline: "resp",
    commonness: "common",
    difficulty: 1,
    pattern: { kind: "respiratory-acidosis", tempo: "chronic" },
    vignetteSeed:
      "Older patient with severe COPD reviewed at a routine clinic visit — chronically breathless on exertion but at their usual baseline, not acutely unwell. ABG on room air.",
    interpretation:
      "Chronic respiratory acidosis with full metabolic compensation (HCO3 up ≈4 per 10 mmHg pCO2, pH near normal) — compensated chronic type 2 respiratory failure",
    sample(rng) {
      const pco2 = uniform(rng, 50, 62);
      const slope = uniform(rng, 3.5, 4.2);
      const hco3 = 24 + slope * ((pco2 - 40) / 10);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 7.2, 8.6),
        na: uniform(rng, 137, 142),
        agTarget: uniform(rng, 8, 13),
        k: uniform(rng, 3.8, 4.8),
        lactate: uniform(rng, 0.7, 1.6),
      });
    },
  },
  {
    id: "opioid-hypoventilation",
    label: "Opioid-induced hypoventilation",
    diagnosis: "Acute type 2 respiratory failure from opioid-induced hypoventilation",
    discipline: "resp",
    commonness: "uncommon",
    difficulty: 1,
    pattern: { kind: "respiratory-acidosis", tempo: "acute" },
    vignetteSeed:
      "Adult brought in drowsy with pinpoint pupils and a respiratory rate of 6 after an opioid overdose (post-operative morphine or recreational); GCS 10. ABG on room air.",
    interpretation:
      "Acute respiratory acidosis with near-normal HCO3 (no renal compensation yet) and type 2 respiratory failure — acute hypoventilation, here opioid-induced",
    sample(rng) {
      const pco2 = uniform(rng, 56, 74);
      const hco3 = 24 + 1.0 * ((pco2 - 40) / 10) + uniform(rng, -1, 1);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 6.5, 8.5),
        na: uniform(rng, 136, 142),
        agTarget: uniform(rng, 8, 13),
        k: uniform(rng, 3.7, 4.7),
        lactate: uniform(rng, 0.8, 2.0),
      });
    },
  },
  {
    id: "diarrhoea-nagma",
    label: "Severe diarrhoea with normal anion gap metabolic acidosis",
    diagnosis: "Normal anion gap (hyperchloraemic) metabolic acidosis from severe diarrhoea",
    discipline: "gi-hep",
    commonness: "common",
    difficulty: 2,
    pattern: { kind: "metabolic-acidosis", anionGap: "normal" },
    vignetteSeed:
      "Adult with 5 days of profuse watery diarrhoea and dehydration; in KZN consider HIV-associated chronic diarrhoea or acute gastroenteritis. ABG on room air.",
    interpretation:
      "Normal anion gap (hyperchloraemic) metabolic acidosis with appropriate respiratory compensation — GI bicarbonate loss from diarrhoea",
    sample(rng) {
      const hco3 = uniform(rng, 11, 17);
      const pco2 = 1.5 * hco3 + 8 + uniform(rng, -1.5, 1.5);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 11.5, 13.5),
        na: uniform(rng, 134, 140),
        agTarget: uniform(rng, 8, 13), // Cl derived → automatically hyperchloraemic
        k: uniform(rng, 2.7, 3.4),
        lactate: uniform(rng, 0.8, 1.8),
      });
    },
  },
  {
    id: "hyperventilation",
    label: "Acute hyperventilation",
    diagnosis: "Acute respiratory alkalosis from anxiety-driven hyperventilation",
    discipline: "resp",
    commonness: "common",
    difficulty: 1,
    pattern: { kind: "respiratory-alkalosis", tempo: "acute" },
    vignetteSeed:
      "Young adult brought in acutely anxious after a panic episode: breathless, perioral tingling and carpopedal spasm, chest clear, saturating well. ABG on room air. (Teaching point: exclude PE/sepsis/salicylates before settling on anxiety.)",
    interpretation:
      "Acute respiratory alkalosis with minimal metabolic compensation and normal oxygenation — hyperventilation; organic causes must be excluded",
    sample(rng) {
      const pco2 = uniform(rng, 23, 30);
      const hco3 = 24 - 2.0 * ((40 - pco2) / 10) + uniform(rng, -1, 1);
      return buildValues({
        hco3,
        pco2mmHg: pco2,
        po2kPa: uniform(rng, 13, 14.6),
        na: uniform(rng, 136, 142),
        agTarget: uniform(rng, 8, 13),
        k: uniform(rng, 3.5, 4.3),
        lactate: uniform(rng, 0.8, 1.9),
      });
    },
  },
];

export function getArchetype(id: string): AbgArchetype {
  const found = ABG_ARCHETYPES.find((a) => a.id === id);
  if (!found) {
    throw new Error(`Unknown ABG archetype "${id}". Known: ${ABG_ARCHETYPES.map((a) => a.id).join(", ")}`);
  }
  return found;
}

/**
 * Generate one physiologically consistent gas for an archetype (random if
 * unspecified). Samples are validated deterministically and rejected until a
 * consistent set emerges — with the constructive sampling above this converges
 * almost immediately; the loop is a hard guarantee, not a hope.
 */
export function generateAbg(archetypeId?: string, rng: Rng = Math.random): GeneratedAbg {
  const archetype = archetypeId
    ? getArchetype(archetypeId)
    : ABG_ARCHETYPES[Math.floor(rng() * ABG_ARCHETYPES.length)];

  for (let attempt = 0; attempt < 50; attempt++) {
    const values = archetype.sample(rng);
    if (validateAbg(values, archetype.pattern).length === 0) {
      return { archetype, values, findings: deriveAbgFindings(values, archetype.pattern) };
    }
  }
  throw new Error(`Could not generate a physiologically consistent gas for "${archetype.id}" in 50 attempts — sampling ranges and validation rules disagree; fix lib/abg.ts`);
}
