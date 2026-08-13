// Server-side proof that /api/speech/token works: loads .env.local and calls
// the SAME issueSpeechToken() the route uses, against the real Azure endpoint.
// Prints ONLY acquisition status + token length — never the token or the key.
//
// Usage: pnpm verify:speech-token
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueSpeechToken } from "../lib/speech/token-server";

function loadEnvLocal(): void {
  let raw: string;
  try {
    raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
  } catch {
    console.error("No .env.local found — run from the repo root.");
    process.exit(1);
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
    }
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const result = await issueSpeechToken();
  if (result.ok) {
    console.log(
      `token acquired: true, length: ${result.token.length} (region: ${result.region}, expiresInSec: ${result.expiresInSec})`,
    );
  } else {
    console.log(`token acquired: false (HTTP ${result.status}: ${result.message})`);
    process.exitCode = 1;
  }
}

void main();
