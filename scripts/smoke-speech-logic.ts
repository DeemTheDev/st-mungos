// $0 Node-side smoke of the voice layer's pure logic (no SDK, no audio):
//   1. voice selection — F patient → Leah + Luke examiner, M → the reverse,
//      null (interpretation station) → the female-patient default;
//   2. env-driven voice config — VOICE_PATIENT_F / VOICE_PATIENT_M /
//      VOICE_EXAMINER override the defaults, and a pinned examiner always wins;
//   3. SSML construction — right voice name, XML-escaped text, locale from the
//      voice name, prosody + sentence breaks on classic voices, and NO
//      style/express-as on voices that don't support it (Leah and Luke report
//      StyleList: none — see `pnpm voices:list`);
//   4. SerialQueue — strictly sequential (concurrency never exceeds 1,
//      completion order preserved even when later tasks are faster), and
//      clear() skips pending tasks without killing the running one.
//
// Usage: pnpm smoke:speech
import { SerialQueue } from "../lib/speech/serial-queue";
import {
  buildSsml,
  normalizeVoiceConfig,
  voiceConfigFromEnv,
  voicesForPatientSex,
  VOICE_FEMALE,
  VOICE_MALE,
} from "../lib/speech/voices";

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  console.log("=== voice selection ===");
  const female = voicesForPatientSex("F");
  check("F patient speaks Leah", female.patient === VOICE_FEMALE, female.patient);
  check("F patient's examiner speaks Luke", female.examiner === VOICE_MALE, female.examiner);
  const male = voicesForPatientSex("M");
  check("M patient speaks Luke", male.patient === VOICE_MALE, male.patient);
  check("M patient's examiner speaks Leah", male.examiner === VOICE_FEMALE, male.examiner);
  const none = voicesForPatientSex(null);
  check("no patient (interpretation) defaults to Leah/Luke", none.patient === VOICE_FEMALE && none.examiner === VOICE_MALE);
  check("patient and examiner never share a voice", female.patient !== female.examiner && male.patient !== male.examiner);

  console.log("\n=== env-driven voice config ===");
  const defaults = voiceConfigFromEnv({});
  check("no env → the shipped en-ZA pair, examiner unpinned",
    defaults.patientF === VOICE_FEMALE && defaults.patientM === VOICE_MALE && defaults.examiner === null);
  check("blank env values are ignored, not treated as a voice name",
    voiceConfigFromEnv({ VOICE_PATIENT_F: "   ", VOICE_EXAMINER: "" }).patientF === VOICE_FEMALE);

  const overridden = voiceConfigFromEnv({
    VOICE_PATIENT_F: "en-GB-Sonia:DragonHDLatestNeural",
    VOICE_PATIENT_M: "en-GB-Ollie:DragonHDLatestNeural",
  });
  const fOverride = voicesForPatientSex("F", overridden);
  const mOverride = voicesForPatientSex("M", overridden);
  check("VOICE_PATIENT_F/M swap both slots without a code change",
    fOverride.patient === "en-GB-Sonia:DragonHDLatestNeural" && mOverride.patient === "en-GB-Ollie:DragonHDLatestNeural",
    `${fOverride.patient} / ${mOverride.patient}`);
  check("unpinned examiner still takes the OTHER patient voice",
    fOverride.examiner === "en-GB-Ollie:DragonHDLatestNeural" && mOverride.examiner === "en-GB-Sonia:DragonHDLatestNeural",
    `${fOverride.examiner} / ${mOverride.examiner}`);

  const pinned = voiceConfigFromEnv({ VOICE_EXAMINER: "en-GB-RyanNeural" });
  check("a pinned VOICE_EXAMINER always wins, for both patient sexes",
    voicesForPatientSex("F", pinned).examiner === "en-GB-RyanNeural"
      && voicesForPatientSex("M", pinned).examiner === "en-GB-RyanNeural");
  check("a token payload without voices falls back to the shipped pair",
    normalizeVoiceConfig(undefined).patientF === VOICE_FEMALE && normalizeVoiceConfig({ patientM: 7 }).patientM === VOICE_MALE);

  console.log("\n=== SSML ===");
  const ssml = buildSsml(`BP is 108/68 — "low <normal> & falling"`, female.examiner, { role: "examiner" });
  check("SSML carries the chosen voice", ssml.includes(`<voice name="${VOICE_MALE}">`), ssml);
  check("SSML escapes XML metacharacters", ssml.includes("&quot;low &lt;normal&gt; &amp; falling&quot;"), ssml);
  check("SSML declares the voice's own locale", ssml.includes(`xml:lang="en-ZA"`));
  check("classic voices get the mild prosody slow-down", ssml.includes(`<prosody rate="-5%">`), ssml);
  check("Leah/Luke never get style attributes (their StyleList is empty)",
    !ssml.includes("express-as") && !ssml.includes("mstts") && !buildSsml("Hello.", VOICE_FEMALE, { role: "patient" }).includes("express-as"),
    ssml);

  const multi = buildSsml("Good morning, doctor. How are you feeling? Much better.", VOICE_FEMALE, { role: "patient" });
  check("sentence boundaries get a short break", (multi.match(/<break time="250ms"\/>/g) ?? []).length === 2, multi);
  const decimals = buildSsml("Temperature 37.9 and BP 108/68.", VOICE_FEMALE, { role: "patient" });
  check("decimals and ratios are never split into sentences", !decimals.includes("<break"), decimals);

  const styled = buildSsml("Talk me through your interpretation.", "en-US-AriaNeural", { role: "examiner" });
  check("a style-capable voice gets a role-appropriate style + the mstts namespace",
    styled.includes(`<mstts:express-as style="narration-professional">`)
      && styled.includes(`xmlns:mstts="https://www.w3.org/2001/mstts"`)
      && styled.includes(`xml:lang="en-US"`),
    styled);

  const hd = buildSsml("Doctor, this cough won't go away. It's been six weeks.", "en-GB-Ada:DragonHDLatestNeural", { role: "patient" });
  check("HD voices get plain text — no prosody, breaks or express-as they can't accept",
    !hd.includes("<prosody") && !hd.includes("<break") && !hd.includes("express-as") && hd.includes(`xml:lang="en-GB"`),
    hd);

  console.log("\n=== serial queue ===");
  const queue = new SerialQueue();
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const task = (id: string, ms: number) => async (): Promise<void> => {
    active++;
    maxActive = Math.max(maxActive, active);
    events.push(`start:${id}`);
    await sleep(ms);
    events.push(`end:${id}`);
    active--;
  };
  // Later tasks are FASTER — parallel execution would finish them first.
  await Promise.all([
    queue.enqueue(task("patient-1", 60)),
    queue.enqueue(task("examiner-1", 20)),
    queue.enqueue(task("patient-2", 5)),
  ]);
  check("tasks never overlap (max concurrency 1)", maxActive === 1, `maxActive=${maxActive}`);
  check(
    "utterances play strictly in enqueue order",
    events.join(",") === "start:patient-1,end:patient-1,start:examiner-1,end:examiner-1,start:patient-2,end:patient-2",
    events.join(","),
  );

  const events2: string[] = [];
  const queue2 = new SerialQueue();
  const p1 = queue2.enqueue(async () => {
    events2.push("start:a");
    await sleep(30);
    events2.push("end:a");
  });
  await sleep(5); // let "a" actually start running
  const p2 = queue2.enqueue(async () => {
    events2.push("start:b");
  });
  queue2.clear(); // stop() drops everything not yet started
  await Promise.all([p1, p2]);
  await sleep(10);
  check("clear() lets the running task finish", events2.includes("end:a"), events2.join(","));
  check("clear() skips tasks not yet started", !events2.includes("start:b"), events2.join(","));

  const queue3 = new SerialQueue();
  const order: string[] = [];
  await Promise.all([
    queue3
      .enqueue(async () => {
        throw new Error("boom");
      })
      .catch(() => order.push("rejected:a")),
    queue3.enqueue(async () => {
      order.push("ran:b");
    }),
  ]);
  check("a rejected task never breaks the chain", order.join(",") === "rejected:a,ran:b", order.join(","));

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) process.exit(1);
}

void main();
