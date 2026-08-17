// Internal per-system diagnosis pool for Stage C clinical generation.
//
// The target diagnosis is picked IN CODE before the model is called (and pinned
// in the prompt), which removes dedupe-collision waste: the model can no longer
// "invent" a diagnosis that already exists in bank/drafts and burn a whole
// generation on it. Entries carry match keywords so a KB topic ("Approach to
// chronic cough") can be steered toward the diagnoses it actually teaches.
//
// Diagnoses are deliberately KZN-weighted (CLAUDE.md §1): HIV and its
// opportunistic infections, TB in all its forms, rheumatic heart disease,
// diabetes emergencies, CKD/HIVAN, hepatitis B.

import type { Discipline } from "../lib/case-schema";
import { normalizeDiagnosis, type ExistingCaseInfo } from "./gen-common";

export interface DiagnosisPoolEntry {
  dx: string;
  /** Keywords scored against the KB topic's title + keywords to pick the best fit. */
  match: string[];
}

export interface DisciplinePool {
  common: DiagnosisPoolEntry[];
  uncommon: DiagnosisPoolEntry[];
}

export const DIAGNOSIS_POOL: Record<Discipline, DisciplinePool> = {
  resp: {
    common: [
      { dx: "Pulmonary tuberculosis with newly diagnosed HIV", match: ["cough", "chronic", "tb", "tuberculosis", "haemoptysis", "night sweats"] },
      { dx: "Community-acquired pneumonia", match: ["cough", "fever", "breathless", "pneumonia", "chest"] },
      { dx: "Infective exacerbation of COPD", match: ["breathless", "dyspnoea", "copd", "smoker", "wheeze"] },
      { dx: "Acute severe asthma exacerbation", match: ["wheeze", "breathless", "asthma", "dyspnoea"] },
      { dx: "Tuberculous pleural effusion", match: ["effusion", "pleural", "breathless", "chest pain", "tb"] },
      { dx: "Pneumocystis jirovecii pneumonia in advanced HIV", match: ["breathless", "dyspnoea", "hiv", "hypoxia", "dry cough"] },
      { dx: "Bronchiectasis with secondary infection", match: ["cough", "sputum", "chronic", "haemoptysis"] },
      { dx: "Pulmonary embolism", match: ["chest pain", "pleuritic", "breathless", "dyspnoea", "leg swelling"] },
    ],
    uncommon: [
      { dx: "Bronchogenic carcinoma", match: ["haemoptysis", "weight loss", "cough", "smoker", "mass"] },
      { dx: "Sarcoidosis with pulmonary involvement", match: ["cough", "breathless", "lymphadenopathy", "erythema nodosum"] },
      { dx: "Pneumothorax (secondary, spontaneous)", match: ["chest pain", "sudden", "breathless", "pleuritic", "asthma", "copd", "wheeze"] },
      { dx: "Multidrug-resistant pulmonary tuberculosis", match: ["tb", "tuberculosis", "cough", "retreatment", "resistance"] },
    ],
  },
  cardio: {
    common: [
      { dx: "Congestive cardiac failure from hypertensive heart disease", match: ["breathless", "oedema", "orthopnoea", "heart failure", "hypertension"] },
      { dx: "Rheumatic mitral stenosis with atrial fibrillation", match: ["murmur", "palpitations", "breathless", "rheumatic", "valve"] },
      { dx: "Infective endocarditis on a rheumatic valve", match: ["fever", "murmur", "endocarditis", "valve", "embolic"] },
      { dx: "Acute coronary syndrome (STEMI)", match: ["chest pain", "crushing", "ischaemic", "acute", "sweating"] },
      { dx: "Tuberculous pericardial effusion", match: ["chest pain", "pericardial", "effusion", "tb", "breathless"] },
      { dx: "Hypertensive emergency with target-organ damage", match: ["headache", "hypertension", "blood pressure", "emergency"] },
      { dx: "Peripartum cardiomyopathy", match: ["breathless", "heart failure", "pregnancy", "postpartum", "oedema"] },
    ],
    uncommon: [
      { dx: "Constrictive pericarditis (post-tuberculous)", match: ["oedema", "ascites", "tb", "pericardial", "raised jvp"] },
      { dx: "Severe aortic stenosis with syncope", match: ["syncope", "murmur", "chest pain", "collapse", "valve"] },
      { dx: "Dilated cardiomyopathy (HIV-associated)", match: ["breathless", "heart failure", "hiv", "cardiomyopathy"] },
    ],
  },
  "gi-hep": {
    common: [
      { dx: "Decompensated cirrhosis from chronic hepatitis B", match: ["jaundice", "ascites", "hepatitis", "cirrhosis", "liver"] },
      { dx: "Upper gastrointestinal bleed from oesophageal varices", match: ["haematemesis", "melaena", "bleed", "varices", "liver"] },
      { dx: "Peptic ulcer disease with gastric outlet obstruction", match: ["vomiting", "epigastric", "ulcer", "dyspepsia"] },
      { dx: "Acute pancreatitis", match: ["abdominal pain", "epigastric", "vomiting", "pancreatitis", "alcohol"] },
      { dx: "Chronic diarrhoea in advanced HIV", match: ["diarrhoea", "weight loss", "hiv", "chronic", "wasting"] },
      { dx: "Alcoholic hepatitis", match: ["jaundice", "alcohol", "liver", "hepatitis", "tender"] },
      { dx: "Abdominal tuberculosis with ascites", match: ["ascites", "abdominal", "tb", "weight loss", "distension"] },
    ],
    uncommon: [
      { dx: "Hepatocellular carcinoma on chronic hepatitis B", match: ["mass", "liver", "weight loss", "hepatitis", "right upper quadrant"] },
      { dx: "Autoimmune hepatitis", match: ["jaundice", "young woman", "liver", "fatigue"] },
      { dx: "Inflammatory bowel disease (ulcerative colitis)", match: ["diarrhoea", "bloody", "colitis", "abdominal pain"] },
    ],
  },
  endo: {
    common: [
      { dx: "Diabetic ketoacidosis as first presentation of type 1 diabetes", match: ["polyuria", "polydipsia", "vomiting", "diabetes", "ketoacidosis"] },
      { dx: "Hyperosmolar hyperglycaemic state", match: ["confusion", "dehydration", "diabetes", "elderly", "hyperglycaemia"] },
      { dx: "Newly diagnosed type 2 diabetes with sepsis of the foot", match: ["foot", "ulcer", "diabetes", "sepsis", "neuropathy"] },
      { dx: "Graves' thyrotoxicosis", match: ["weight loss", "palpitations", "tremor", "thyroid", "heat intolerance", "goitre"] },
      { dx: "Primary hypothyroidism", match: ["fatigue", "weight gain", "cold", "thyroid", "constipation"] },
      { dx: "Hypoglycaemia on sulphonylurea therapy", match: ["collapse", "confusion", "sweating", "diabetes", "hypoglycaemia"] },
    ],
    uncommon: [
      { dx: "Addisonian crisis from tuberculous adrenalitis", match: ["hypotension", "pigmentation", "fatigue", "adrenal", "collapse", "tb"] },
      { dx: "Cushing's syndrome", match: ["weight gain", "striae", "hypertension", "cushing", "moon face"] },
      { dx: "Diabetes insipidus", match: ["polyuria", "polydipsia", "thirst", "sodium"] },
    ],
  },
  neuro: {
    common: [
      { dx: "Cryptococcal meningitis in advanced HIV", match: ["headache", "meningitis", "hiv", "confusion", "neck stiffness"] },
      { dx: "Tuberculous meningitis", match: ["headache", "meningitis", "tb", "confusion", "cranial nerve"] },
      { dx: "Ischaemic stroke with hemiplegia", match: ["weakness", "hemiplegia", "stroke", "sudden", "speech"] },
      { dx: "New-onset generalised tonic-clonic seizures (neurocysticercosis)", match: ["seizure", "fit", "convulsion", "collapse"] },
      { dx: "Bacterial meningitis", match: ["headache", "fever", "meningitis", "neck stiffness", "photophobia"] },
      { dx: "HIV-associated peripheral neuropathy", match: ["numbness", "burning", "feet", "neuropathy", "hiv"] },
    ],
    uncommon: [
      { dx: "Cerebral toxoplasmosis with focal seizures in advanced HIV", match: ["seizure", "fit", "convulsion", "hiv", "headache", "focal", "toxoplasmosis", "epilepsy"] },
      { dx: "Guillain-Barré syndrome", match: ["weakness", "ascending", "paralysis", "areflexia"] },
      { dx: "Spinal cord compression from tuberculosis of the spine", match: ["back pain", "weakness", "legs", "tb", "spine", "paraplegia"] },
      { dx: "Myasthenia gravis", match: ["weakness", "fatigable", "ptosis", "diplopia"] },
    ],
  },
  renal: {
    common: [
      { dx: "Acute kidney injury (pre-renal) from gastroenteritis", match: ["oliguria", "dehydration", "kidney", "creatinine", "diarrhoea"] },
      { dx: "HIV-associated nephropathy with nephrotic syndrome", match: ["oedema", "proteinuria", "nephrotic", "hiv", "kidney"] },
      { dx: "Chronic kidney disease from hypertension and diabetes", match: ["kidney", "chronic", "hypertension", "diabetes", "creatinine"] },
      { dx: "Post-infectious glomerulonephritis", match: ["haematuria", "oedema", "hypertension", "nephritic", "throat"] },
      { dx: "Emergency hyperkalaemia in missed dialysis", match: ["hyperkalaemia", "potassium", "dialysis", "weakness", "ecg"] },
    ],
    uncommon: [
      { dx: "Lupus nephritis", match: ["proteinuria", "rash", "joint", "lupus", "young woman"] },
      { dx: "Rapidly progressive glomerulonephritis", match: ["haematuria", "oliguria", "kidney", "crescentic"] },
      { dx: "Renal tubular acidosis", match: ["acidosis", "potassium", "stones", "tubular"] },
    ],
  },
  haem: {
    common: [
      { dx: "Symptomatic iron deficiency anaemia from menorrhagia", match: ["fatigue", "pallor", "anaemia", "bleeding", "menorrhagia"] },
      { dx: "Anaemia of chronic disease in HIV and TB", match: ["fatigue", "pallor", "anaemia", "hiv", "tb", "chronic"] },
      { dx: "HIV-associated lymphoma with B symptoms", match: ["lymphadenopathy", "night sweats", "weight loss", "lymphoma", "hiv"] },
      { dx: "Immune thrombocytopenic purpura", match: ["bruising", "petechiae", "bleeding", "platelets", "purpura"] },
      { dx: "Deep vein thrombosis with pulmonary embolism risk", match: ["leg swelling", "calf", "thrombosis", "swollen", "clot"] },
    ],
    uncommon: [
      { dx: "Thrombotic thrombocytopenic purpura (HIV-associated)", match: ["confusion", "fever", "purpura", "anaemia", "platelets", "hiv"] },
      { dx: "Multiple myeloma", match: ["back pain", "bone pain", "anaemia", "fractures", "elderly", "calcium"] },
      { dx: "Chronic myeloid leukaemia", match: ["splenomegaly", "fatigue", "weight loss", "white cells", "leukaemia"] },
    ],
  },
  id: {
    common: [
      { dx: "Acute HIV seroconversion illness", match: ["fever", "rash", "sore throat", "hiv", "lymphadenopathy", "flu"] },
      { dx: "Disseminated tuberculosis in advanced HIV", match: ["fever", "weight loss", "tb", "hiv", "night sweats", "disseminated"] },
      { dx: "Falciparum malaria after travel to an endemic area", match: ["fever", "travel", "malaria", "rigors", "headache"] },
      { dx: "Sepsis from a urinary source", match: ["fever", "confusion", "sepsis", "dysuria", "shock"] },
      { dx: "Tick bite fever (African rickettsiosis)", match: ["fever", "eschar", "rash", "tick", "headache", "rural"] },
      { dx: "Cryptococcal disease presenting with headache in HIV", match: ["headache", "hiv", "fever", "cryptococcal", "meningitis"] },
      { dx: "Oesophageal candidiasis in advanced HIV", match: ["hiv", "swallowing", "odynophagia", "candidiasis", "thrush", "staging", "opportunistic", "cd4", "weight loss"] },
    ],
    uncommon: [
      { dx: "Paradoxical tuberculosis-IRIS after starting antiretroviral therapy", match: ["hiv", "art", "iris", "immune reconstitution", "tb", "antiretroviral", "cd4", "staging"] },
      { dx: "Typhoid fever", match: ["fever", "abdominal", "diarrhoea", "travel", "prolonged"] },
      { dx: "Amoebic liver abscess", match: ["fever", "right upper quadrant", "liver", "abscess", "tender"] },
      { dx: "Measles in an unvaccinated adult", match: ["rash", "fever", "coryza", "conjunctivitis", "outbreak"] },
    ],
  },
  rheum: {
    common: [
      { dx: "Systemic lupus erythematosus", match: ["joint pain", "rash", "young woman", "lupus", "photosensitive", "fatigue"] },
      { dx: "Rheumatoid arthritis", match: ["joint pain", "stiffness", "hands", "symmetrical", "morning"] },
      { dx: "Acute gout", match: ["joint pain", "toe", "swollen", "gout", "acute", "red"] },
      { dx: "Septic arthritis of the knee", match: ["joint pain", "knee", "fever", "swollen", "septic", "acute"] },
      { dx: "Acute rheumatic fever", match: ["joint pain", "fever", "migratory", "sore throat", "murmur", "rheumatic"] },
    ],
    uncommon: [
      { dx: "Reactive arthritis in HIV", match: ["joint pain", "urethritis", "eye", "hiv", "reactive"] },
      { dx: "Systemic sclerosis", match: ["tight skin", "raynaud", "fingers", "swallowing", "sclerosis"] },
      { dx: "Dermatomyositis", match: ["weakness", "rash", "proximal", "muscle", "heliotrope"] },
    ],
  },
};

const tokenize = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );

/**
 * Pick the pool diagnosis best matching a KB topic, excluding anything already
 * used (bank + drafts + earlier in this run). Returns null when the pool for
 * this system/commonness is exhausted.
 */
export function pickDiagnosis(
  system: Discipline,
  commonness: "common" | "uncommon",
  topic: { title: string; keywords: string[] },
  usedNormalized: ReadonlySet<string>,
): string | null {
  const pool = DIAGNOSIS_POOL[system][commonness];
  const topicTokens = tokenize(`${topic.title} ${topic.keywords.join(" ")}`);

  // A pool diagnosis counts as used when an existing case's normalized
  // diagnosis contains it (or vice versa): "acute severe asthma exacerbation"
  // must not be re-picked because an existing case is titled "acute severe
  // asthma exacerbation on a background of poorly controlled asthma".
  const isUsed = (dxNorm: string): boolean => {
    if (usedNormalized.has(dxNorm)) return true;
    for (const used of usedNormalized) {
      if (used.includes(dxNorm) || dxNorm.includes(used)) return true;
    }
    return false;
  };

  let best: DiagnosisPoolEntry | null = null;
  let bestScore = -1;
  for (const entry of pool) {
    if (isUsed(normalizeDiagnosis(entry.dx))) continue;
    let score = 0;
    for (const kw of entry.match) {
      const kwTokens = tokenize(kw);
      if ([...kwTokens].some((t) => topicTokens.has(t))) score++;
    }
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best ? best.dx : null;
}

/** Normalized diagnoses of every existing case — the exclusion set for picking. */
export function usedDiagnoses(existing: ExistingCaseInfo[]): Set<string> {
  return new Set(existing.map((c) => normalizeDiagnosis(c.diagnosis)).filter(Boolean));
}
