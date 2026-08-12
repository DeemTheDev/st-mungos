// Manifest load/save + hashing helpers for the KB pipeline.
// The manifest (grounding/manifest.json) maps source sha256 → outputs so that
// re-runs are incremental (CLAUDE.md §5 Stage A).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Manifest } from "./types";

export const MANIFEST_FILE = "manifest.json";

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function emptyManifest(): Manifest {
  return { version: 1, sources: {}, sections: {}, distilled: {} };
}

export function loadManifest(groundingDir: string): Manifest {
  const file = join(groundingDir, MANIFEST_FILE);
  if (!existsSync(file)) return emptyManifest();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Manifest>;
    return {
      version: 1,
      sources: parsed.sources ?? {},
      sections: parsed.sections ?? {},
      distilled: parsed.distilled ?? {},
    };
  } catch {
    console.warn(`[manifest] ${file} unreadable — starting fresh`);
    return emptyManifest();
  }
}

export function saveManifest(groundingDir: string, manifest: Manifest): void {
  const file = join(groundingDir, MANIFEST_FILE);
  mkdirSync(dirname(file), { recursive: true });
  // Write-then-rename so an interrupted run never leaves a half-written manifest.
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
