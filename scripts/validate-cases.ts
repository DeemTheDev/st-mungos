// Validates every case JSON in cases/bank and cases/drafts against the Zod schema.
// Usage: pnpm validate:cases
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { OsceCaseSchema } from "../lib/case-schema";

let failures = 0;
let checked = 0;

for (const dir of ["cases/bank", "cases/drafts"]) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const path = join(dir, file);
    checked++;
    try {
      const parsed = OsceCaseSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) {
        console.log(`  OK    ${path} (${parsed.data.stationType}: ${parsed.data.diagnosis})`);
      } else {
        failures++;
        console.error(`  FAIL  ${path}`);
        for (const issue of parsed.error.issues) {
          console.error(`        ${issue.path.join(".")}: ${issue.message}`);
        }
      }
    } catch (err) {
      failures++;
      console.error(`  FAIL  ${path}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

console.log(`\n${checked} case(s) checked, ${failures} failure(s).`);
if (failures > 0) process.exit(1);
