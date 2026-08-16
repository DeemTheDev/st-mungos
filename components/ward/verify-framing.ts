// `pnpm verify:framing` — the regression test for "you can only see his boots".
//
// It loads public/models/patient.glb exactly as the tile does (meshopt decoder +
// KHR_mesh_quantization), applies the SAME normalisation and the SAME camera fit
// as ./framing.ts, and for a spread of tile aspect ratios projects the model's 8
// bounding-box corners through the view-projection matrix. Every corner must
// land inside NDC bounds with room to spare, and the figure must occupy 60–85%
// of the tile height. A camera that frames someone's boots fails here loudly
// instead of silently shipping.
//
// It lives beside framing.ts rather than in scripts/ on purpose: it is the proof
// for THIS module, imports it directly, and must be changed in the same commit
// whenever the fit constants move.
//
// Node has no image decoder, so textures are stripped from the GLB before
// parsing — geometry is all the framing depends on. No network, no GPU.

import { readFileSync } from "node:fs";
import { Box3, PerspectiveCamera, Vector3, type Group } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  CAMERA_FOV,
  NDC_SAFE,
  applyFraming,
  boxCorners,
  fitFraming,
  normalisePatient,
  projectMetrics,
} from "./framing";

const MODEL = "public/models/patient.glb";

/** The figure must never be smaller than this fraction of the tile height… */
const MIN_FILL_Y = 0.6;
/** …nor so large that the portrait loses its headroom. */
const MAX_FILL_Y = 0.85;

/**
 * Real tile shapes, not round numbers. The first three are the ones the task
 * cares about (wide desktop tile, square, tall mobile); the rest are the other
 * shapes the bento actually produces as the window is dragged around.
 */
const ASPECTS: Array<{ label: string; width: number; height: number }> = [
  { label: "desktop tile 4:5", width: 640, height: 800 },
  { label: "square 1:1", width: 720, height: 720 },
  { label: "mobile tall 9:16", width: 390, height: 693 },
  { label: "wide desktop 16:9", width: 1280, height: 720 },
  { label: "mobile band 390x180", width: 390, height: 180 },
  // The real 3D-on-mobile band: h-28 inside a 375px viewport. Extreme aspect,
  // and the shape most likely to crop a head if the fit ever regresses.
  { label: "mobile band 355x112", width: 355, height: 112 },
  { label: "narrow column 3:5", width: 420, height: 700 },
];

/** Rebuild the GLB without materials/textures/images so node never decodes WebP. */
function stripTextures(source: Buffer): ArrayBuffer {
  const dv = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let offset = 12;
  let json: Record<string, unknown> = {};
  let bin: Uint8Array = new Uint8Array(0);

  while (offset < source.byteLength) {
    const len = dv.getUint32(offset, true);
    const type = dv.getUint32(offset + 4, true);
    if (type === 0x4e4f534a) {
      json = JSON.parse(new TextDecoder().decode(source.subarray(offset + 8, offset + 8 + len)));
    } else if (type === 0x004e4942) {
      bin = source.subarray(offset + 8, offset + 8 + len);
    }
    offset += 8 + len;
  }

  delete json.materials;
  delete json.textures;
  delete json.images;
  delete json.samplers;
  const drop = (key: "extensionsUsed" | "extensionsRequired") => {
    json[key] = ((json[key] ?? []) as string[]).filter((e) => e !== "EXT_texture_webp");
  };
  drop("extensionsUsed");
  drop("extensionsRequired");
  for (const mesh of (json.meshes ?? []) as Array<{ primitives: Array<Record<string, unknown>> }>) {
    for (const prim of mesh.primitives) delete prim.material;
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const binPad = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + jsonBytes.byteLength + jsonPad + 8 + bin.byteLength + binPad;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.byteLength + jsonPad, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonBytes.byteLength + jsonPad);
  const binHeader = 20 + jsonBytes.byteLength + jsonPad;
  view.setUint32(binHeader, bin.byteLength + binPad, true);
  view.setUint32(binHeader + 4, 0x004e4942, true); // "BIN"
  out.set(bin, binHeader + 8);
  return out.buffer;
}

function fmt(v: Vector3): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
}

async function main(): Promise<void> {
  const glb = stripTextures(readFileSync(MODEL));
  const loader = new GLTFLoader();
  await MeshoptDecoder.ready;
  loader.setMeshoptDecoder(MeshoptDecoder);

  const gltf = await new Promise<{ scene: Group }>((resolve, reject) => {
    loader.parse(glb, "", (result) => resolve(result as never), reject);
  });

  const raw = new Box3().setFromObject(gltf.scene);
  console.log("=== model ===");
  console.log(`file            ${MODEL}`);
  console.log(`authored bbox   min ${fmt(raw.min)}  max ${fmt(raw.max)}`);
  console.log(`authored size   ${fmt(raw.getSize(new Vector3()))}`);

  const patient = normalisePatient(gltf.scene);
  const size = patient.box.getSize(new Vector3());
  const centre = patient.box.getCenter(new Vector3());
  console.log("\n=== normalised (what the tile frames) ===");
  console.log(`bbox min        ${fmt(patient.box.min)}`);
  console.log(`bbox max        ${fmt(patient.box.max)}`);
  console.log(`size            ${fmt(size)}`);
  console.log(`centre          ${fmt(centre)}   <- lookAt target (chest height)`);
  console.log(
    `warnings        ${patient.warnings.length ? patient.warnings.join("; ") : "none — box is a plausible standing human"}`,
  );

  // A skinned mesh can hand back bind-pose bounds; if the box itself is wrong
  // every camera solved from it is wrong too, so that is a hard failure here.
  let failures = patient.warnings.length;

  const corners = boxCorners(patient.box);

  console.log("\n=== per-aspect framing ===");
  for (const aspect of ASPECTS) {
    const ratio = aspect.width / aspect.height;
    const framing = fitFraming(patient.box, { aspect: ratio });
    const camera = new PerspectiveCamera(CAMERA_FOV, ratio, 0.1, 80);
    applyFraming(camera, framing, ratio);
    // Measured on the REAL box, not the motion-padded one used for the solve.
    const m = projectMetrics(camera, corners);

    const problems: string[] = [];
    if (!m.inFront) problems.push("a corner is behind the camera");
    if (m.maxAbsX > 1) problems.push(`cropped horizontally (|x| ${m.maxAbsX.toFixed(3)})`);
    if (m.maxAbsY > 1) problems.push(`cropped vertically (|y| ${m.maxAbsY.toFixed(3)})`);
    if (m.maxAbsX > NDC_SAFE || m.maxAbsY > NDC_SAFE) problems.push("inside the frame but past the safe border");
    if (m.minDepth <= camera.near) problems.push(`clipped by near plane (${m.minDepth.toFixed(3)} m)`);
    if (m.maxDepth >= camera.far) problems.push(`clipped by far plane (${m.maxDepth.toFixed(3)} m)`);
    if (m.fillY < MIN_FILL_Y || m.fillY > MAX_FILL_Y) {
      problems.push(`vertical fill ${(m.fillY * 100).toFixed(1)}% outside ${MIN_FILL_Y * 100}–${MAX_FILL_Y * 100}%`);
    }
    if (problems.length) failures += 1;

    console.log(
      [
        `${problems.length ? "FAIL" : "PASS"}  ${aspect.label.padEnd(20)} ${aspect.width}x${aspect.height}  aspect ${ratio.toFixed(3)}`,
        `      distance ${framing.distance.toFixed(3)} m  (orbit ${framing.minDistance.toFixed(2)}–${framing.maxDistance.toFixed(2)} m, ${framing.iterations} iters)`,
        `      camera   ${fmt(framing.position)}  →  target ${fmt(framing.target)}`,
        `      fill     height ${(m.fillY * 100).toFixed(1)}%   width ${(m.fillX * 100).toFixed(1)}%`,
        `      ndc      |x|max ${m.maxAbsX.toFixed(3)}  |y|max ${m.maxAbsY.toFixed(3)}  depth ${m.minDepth.toFixed(2)}–${m.maxDepth.toFixed(2)} m`,
        problems.length ? `      problems ${problems.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  console.log(`\n${failures === 0 ? "ALL ASPECTS PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
