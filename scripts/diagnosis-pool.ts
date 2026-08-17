// The per-system diagnosis pool moved to lib/library/generate-job.ts when case
// generation went server-side — the API route and this CLI must pick from the
// SAME pool, or the two would generate overlapping cases. This shim keeps the
// old import path working; edit the pool there.
export {
  DIAGNOSIS_POOL,
  pickDiagnosis,
  usedDiagnoses,
} from "../lib/library/generate-job";
export type { DiagnosisPoolEntry, DisciplinePool } from "../lib/library/generate-job";
