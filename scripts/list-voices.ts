// Lists the neural voices the configured Azure Speech region actually offers,
// so voice choices are made from the real catalogue instead of guesswork
// (CLAUDE.md §12 — verify against reality). Read-only: one GET against
// https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list.
//
// Prints ONLY voice names, locales, genders and counts. The subscription key is
// read from .env.local and never printed, logged or echoed.
//
// Usage: pnpm voices:list [locale-prefix ...]      (default: en)

interface AzureVoice {
  Name: string;
  DisplayName: string;
  ShortName: string;
  Gender: "Male" | "Female" | "Neutral";
  Locale: string;
  LocaleName?: string;
  VoiceType?: string;
  Status?: string;
  StyleList?: string[];
  RolePlayList?: string[];
  SecondaryLocaleList?: string[];
  WordsPerMinute?: string;
}

/** The voices the app ships with — the script must confirm they still exist. */
const CURRENT = ["en-ZA-LeahNeural", "en-ZA-LukeNeural"];

/** Newer-generation families worth auditing as upgrades. */
const NEWER_GENERATION = /Multilingual|HD|Neural2|Dragon|Turbo/i;

function loadEnv(): { region: string; key: string } {
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Already-exported env vars are fine; only a missing file lands here.
  }
  const region = process.env.AZURE_SPEECH_REGION?.trim();
  const key = process.env.AZURE_SPEECH_KEY?.trim();
  if (!region || !key) {
    console.error("AZURE_SPEECH_REGION / AZURE_SPEECH_KEY are not set — run from the repo root with .env.local present.");
    process.exit(1);
  }
  return { region, key };
}

function describe(v: AzureVoice): string {
  const styles = v.StyleList?.length ? ` styles:${v.StyleList.length}` : " styles:none";
  const roles = v.RolePlayList?.length ? ` roles:${v.RolePlayList.length}` : "";
  const secondary = v.SecondaryLocaleList?.length ? ` secondaryLocales:${v.SecondaryLocaleList.length}` : "";
  const wpm = v.WordsPerMinute ? ` wpm:${v.WordsPerMinute}` : "";
  return `${v.ShortName.padEnd(34)} ${v.Locale.padEnd(7)} ${v.Gender.padEnd(6)} ${(v.VoiceType ?? "?").padEnd(12)}${styles}${roles}${secondary}${wpm}`;
}

async function main(): Promise<void> {
  const { region, key } = loadEnv();
  const prefixes = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const wanted = prefixes.length > 0 ? prefixes : ["en"];

  const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
  console.log(`GET voices/list  (region: ${region})\n`);

  const res = await fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": key },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    // Status only — Azure error bodies are never echoed (they can carry headers).
    console.error(`voices/list refused the request (HTTP ${res.status}).`);
    process.exit(1);
  }
  const voices = (await res.json()) as AzureVoice[];

  // ---- counts -------------------------------------------------------------
  const locales = new Set(voices.map((v) => v.Locale));
  const byType = new Map<string, number>();
  for (const v of voices) byType.set(v.VoiceType ?? "?", (byType.get(v.VoiceType ?? "?") ?? 0) + 1);
  console.log(`total voices: ${voices.length}   locales: ${locales.size}`);
  console.log(`by VoiceType: ${[...byType].map(([t, n]) => `${t}=${n}`).join("  ")}`);

  const inScope = voices.filter((v) => wanted.some((p) => v.Locale.toLowerCase().startsWith(p.toLowerCase())));
  const scopeLocales = [...new Set(inScope.map((v) => v.Locale))].sort();
  console.log(`\nlocale filter [${wanted.join(", ")}]: ${inScope.length} voices across ${scopeLocales.length} locales`);
  console.log(`locales: ${scopeLocales.join(", ")}`);

  // ---- the voices the app currently ships --------------------------------
  console.log(`\n--- currently configured voices ---`);
  for (const name of CURRENT) {
    const found = voices.find((v) => v.ShortName === name);
    console.log(found ? `PRESENT  ${describe(found)}` : `MISSING  ${name}`);
  }

  // ---- every en-ZA voice in the region -----------------------------------
  const za = voices.filter((v) => v.Locale === "en-ZA").sort((a, b) => a.ShortName.localeCompare(b.ShortName));
  console.log(`\n--- en-ZA voices in ${region} (${za.length}) ---`);
  for (const v of za) console.log(`  ${describe(v)}`);

  // ---- the full in-scope list, when the filter is narrow enough to read ---
  if (inScope.length <= 60) {
    console.log(`\n--- all voices in scope (${inScope.length}) ---`);
    for (const v of [...inScope].sort((a, b) => a.ShortName.localeCompare(b.ShortName))) {
      console.log(`  ${describe(v)}`);
    }
  }

  // ---- newer-generation candidates ---------------------------------------
  const candidates = inScope
    .filter((v) => NEWER_GENERATION.test(v.ShortName) || /HD|Neural2/i.test(v.VoiceType ?? ""))
    .sort((a, b) => a.ShortName.localeCompare(b.ShortName));
  console.log(`\n--- newer-generation candidates in scope (${candidates.length}) ---`);
  for (const v of candidates) console.log(`  ${describe(v)}`);

  // ---- style/role-capable voices (SSML express-as is only legal on these) --
  const styled = inScope.filter((v) => (v.StyleList?.length ?? 0) > 0)
    .sort((a, b) => a.ShortName.localeCompare(b.ShortName));
  console.log(`\n--- style-capable voices in scope (${styled.length}) ---`);
  for (const v of styled) console.log(`  ${v.ShortName.padEnd(34)} ${v.Locale.padEnd(7)} ${(v.StyleList ?? []).join(", ")}`);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
