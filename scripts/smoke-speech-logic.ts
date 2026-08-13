// $0 Node-side smoke of the voice layer's pure logic (no SDK, no audio):
//   1. voice selection — F patient → Leah + Luke examiner, M → the reverse,
//      null (interpretation station) → the female-patient default;
//   2. SSML construction — right voice name, XML-escaped text;
//   3. SerialQueue — strictly sequential (concurrency never exceeds 1,
//      completion order preserved even when later tasks are faster), and
//      clear() skips pending tasks without killing the running one.
//
// Usage: pnpm smoke:speech
import { SerialQueue } from "../lib/speech/serial-queue";
import { buildSsml, VOICE_FEMALE, VOICE_MALE, voicesForPatientSex } from "../lib/speech/voices";

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

  console.log("\n=== SSML ===");
  const ssml = buildSsml(`BP is 108/68 — "low <normal> & falling"`, female.examiner);
  check("SSML carries the chosen voice", ssml.includes(`<voice name="${VOICE_MALE}">`), ssml);
  check("SSML escapes XML metacharacters", ssml.includes("&quot;low &lt;normal&gt; &amp; falling&quot;"), ssml);
  check("SSML declares en-ZA", ssml.includes(`xml:lang="en-ZA"`));

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
