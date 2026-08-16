// Camera framing for the patient tile (CLAUDE.md §8).
//
// There is no room any more — the tile composes a PORTRAIT of one figure over a
// CSS background, so the only thing the camera has to satisfy is the figure
// itself. This module is deliberately React-free and three-only so the SAME code
// that frames the live tile runs headlessly against the .glb: `pnpm
// verify:framing` (./verify-framing.ts) is the regression test for the
// "you can only see his boots" bug.
//
// Guessing a camera position is what produced that bug. The model is normalised
// at runtime, so the only honest way to frame it is to MEASURE the normalised
// bounding box and solve for the distance that puts every corner on screen.
//
// The solve is a fixed-point iteration on the projected NDC extents rather than
// a closed-form fov/height formula: the camera is pitched down slightly and sits
// off-axis, so the naive `d = h / (2·tan(fov/2))` under-shoots and crops the
// figure. Extents scale as ~1/distance, so `distance *= k` converges in a
// handful of steps and lands exactly on whichever constraint binds — vertical
// fill on wide tiles, horizontal fill on tall narrow ones.

import { Box3, Group, MathUtils, Object3D, PerspectiveCamera, Vector3 } from "three";

/** Metres — the loaded model is normalised to this so any .glb frames the same. */
export const PATIENT_HEIGHT = 1.75;

/** Vertical field of view, degrees. Shared by the scene and the proof. */
export const CAMERA_FOV = 38;

/**
 * Fraction of the tile HEIGHT the figure should occupy when height binds.
 *
 * This is measured against the MOTION-PADDED box (see MOTION_PAD), so the real
 * figure lands a little lower — 0.80 padded ≈ 0.73 measured, i.e. the 70–80%
 * "portrait with headroom" the tile is supposed to read as. Change this and
 * re-run `pnpm verify:framing`; the proof asserts the measured number.
 */
export const TARGET_FILL_Y = 0.8;
/**
 * Ceiling on the fraction of tile WIDTH. This is the constraint that binds on
 * tall narrow tiles — the model is 1.16 m wide (arms out), so a 9:16 tile runs
 * out of width long before it runs out of height and the camera has to back
 * off. Sits just inside NDC_SAFE so a phone-shaped tile still gets the figure
 * to ~72% of its height rather than shrinking it into the middle.
 */
export const MAX_FILL_X = 0.9;
/** No bbox corner may project outside ±this in NDC (a 6% safety border). */
export const NDC_SAFE = 0.94;

/** Default orbit pose: a touch off-axis and slightly above the target. */
export const DEFAULT_AZIMUTH = MathUtils.degToRad(12);
export const DEFAULT_ELEVATION = MathUtils.degToRad(7);

/** She can turn him most of the way round, never fully behind. */
export const ORBIT_AZIMUTH_SPAN = MathUtils.degToRad(70);
/** Never overhead, never looking up from under his feet. */
export const ORBIT_POLAR_MIN = MathUtils.degToRad(58);
export const ORBIT_POLAR_MAX = MathUtils.degToRad(95);

/**
 * Idle-rig headroom, so animation can never nudge a limb off-screen. Derived
 * from the rig in ward-scene.tsx rather than guessed: |rotation.y| ≤ 0.068 rad
 * sweeps the 0.58 m half-width against the 0.22 m half-depth (~0.02 m of extra
 * x, ~0.04 m of extra z), the bob reaches 0.04 m and the speaking scale pulse
 * adds 0.8% of the height (~0.014 m).
 */
export const MOTION_PAD = new Vector3(0.04, 0.07, 0.05);

/** Used until the model reports its real box (and if the model never loads). */
export function fallbackPatientBox(): Box3 {
  return new Box3(new Vector3(-0.32, 0, -0.24), new Vector3(0.32, PATIENT_HEIGHT, 0.24));
}

// ---------------------------------------------------------------------------
// normalisation

export interface NormalisedPatient {
  /** Wrapper to add to the scene — centred on X/Z, feet at y=0, 1.75 m tall. */
  object: Group;
  /** World-space bounding box AFTER normalisation. Frame from this, not guesses. */
  box: Box3;
  /** Bounds as authored, for diagnostics. */
  source: { size: Vector3; centre: Vector3 };
  /** Non-empty when the measured box is not a plausible standing human. */
  warnings: string[];
}

/**
 * Centre on X/Z, feet on the floor, scaled to human height.
 *
 * The correction rides on a WRAPPER so the model's own transform (this .glb is
 * quantised, so its scale is load-bearing) is left exactly as authored.
 */
export function normalisePatient(source: Object3D): NormalisedPatient {
  const root = source.clone(true);
  const raw = new Box3().setFromObject(root);
  const size = raw.getSize(new Vector3());
  const centre = raw.getCenter(new Vector3());
  const scale = size.y > 1e-6 ? PATIENT_HEIGHT / size.y : 1;

  const object = new Group();
  object.name = "patient";
  object.add(root);
  object.scale.setScalar(scale);
  object.position.set(-centre.x * scale, -raw.min.y * scale, -centre.z * scale);
  object.updateMatrixWorld(true);

  const box = new Box3().setFromObject(object);
  return { object, box, source: { size, centre }, warnings: validatePatientBox(box) };
}

/**
 * A skinned .glb can hand back bind-pose bounds from `Box3.setFromObject`, and a
 * bad box silently becomes a bad camera. Anything implausible is reported so the
 * scene can warn instead of quietly framing someone's boots.
 */
export function validatePatientBox(box: Box3): string[] {
  const problems: string[] = [];
  if (box.isEmpty()) return ["bounding box is empty — nothing to frame"];

  const size = box.getSize(new Vector3());
  const centre = box.getCenter(new Vector3());
  if (![size.x, size.y, size.z, centre.x, centre.y, centre.z].every(Number.isFinite)) {
    return ["bounding box contains non-finite values"];
  }
  if (Math.abs(size.y - PATIENT_HEIGHT) > 0.02) {
    problems.push(`height ${size.y.toFixed(3)} m, expected ${PATIENT_HEIGHT} m`);
  }
  if (Math.abs(box.min.y) > 0.02) problems.push(`feet at y=${box.min.y.toFixed(3)}, expected 0`);
  if (centre.y < 0.6 || centre.y > 1.15) {
    problems.push(`centre y=${centre.y.toFixed(3)} — bind-pose bounds?`);
  }
  if (Math.abs(centre.x) > 0.05 || Math.abs(centre.z) > 0.05) {
    problems.push(`centre x=${centre.x.toFixed(3)} z=${centre.z.toFixed(3)}, expected ~0`);
  }
  if (size.x > 2.5 || size.z > 2.5) {
    problems.push(`footprint ${size.x.toFixed(2)}×${size.z.toFixed(2)} m is too wide for a person`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// projection helpers (shared with the headless proof)

/** The 8 corners of a box, in world space. */
export function boxCorners(box: Box3): Vector3[] {
  const corners: Vector3[] = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) corners.push(new Vector3(x, y, z));
    }
  }
  return corners;
}

export interface ProjectionMetrics {
  /** Half the NDC vertical span = the fraction of viewport HEIGHT covered. */
  fillY: number;
  /** Half the NDC horizontal span = the fraction of viewport WIDTH covered. */
  fillX: number;
  /** Largest |ndc.x| / |ndc.y| over the corners — >1 means something is cropped. */
  maxAbsX: number;
  maxAbsY: number;
  /** View-space depths (positive metres in front of the camera). */
  minDepth: number;
  maxDepth: number;
  /** False if any corner sits behind the camera (projection is meaningless then). */
  inFront: boolean;
}

/**
 * Project world-space points through a camera and summarise where they land.
 * The camera must already be positioned/oriented; matrices are refreshed here.
 */
export function projectMetrics(camera: PerspectiveCamera, points: Vector3[]): ProjectionMetrics {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  let inFront = true;

  const view = new Vector3();
  const ndc = new Vector3();
  for (const point of points) {
    view.copy(point).applyMatrix4(camera.matrixWorldInverse);
    const depth = -view.z;
    if (depth <= 0) inFront = false;
    minDepth = Math.min(minDepth, depth);
    maxDepth = Math.max(maxDepth, depth);

    ndc.copy(point).project(camera);
    minX = Math.min(minX, ndc.x);
    maxX = Math.max(maxX, ndc.x);
    minY = Math.min(minY, ndc.y);
    maxY = Math.max(maxY, ndc.y);
  }

  return {
    fillY: (maxY - minY) / 2,
    fillX: (maxX - minX) / 2,
    maxAbsX: Math.max(Math.abs(minX), Math.abs(maxX)),
    maxAbsY: Math.max(Math.abs(minY), Math.abs(maxY)),
    minDepth,
    maxDepth,
    inFront,
  };
}

// ---------------------------------------------------------------------------
// the fit

export interface FramingOptions {
  aspect: number;
  fov?: number;
  fillY?: number;
  maxFillX?: number;
  azimuth?: number;
  elevation?: number;
  pad?: Vector3;
}

export interface Framing {
  /** lookAt point — the bbox centre, i.e. roughly chest height. */
  target: Vector3;
  position: Vector3;
  /** Unit vector target → camera. */
  direction: Vector3;
  distance: number;
  minDistance: number;
  maxDistance: number;
  azimuth: number;
  /** Fill fractions of the PADDED box at the solved distance. */
  fillY: number;
  fillX: number;
  /** Iterations used; > 1 means it actually solved rather than short-circuited. */
  iterations: number;
}

/** Direction from the target to the camera for an azimuth/elevation pair. */
export function orbitDirection(azimuth: number, elevation: number): Vector3 {
  return new Vector3(
    Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).normalize();
}

/** Build the camera the framing describes — used by the scene and the proof. */
export function applyFraming(camera: PerspectiveCamera, framing: Framing, aspect: number): void {
  camera.aspect = aspect;
  camera.position.copy(framing.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(framing.target);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
}

/**
 * Solve for the camera pose that puts the WHOLE box comfortably in frame.
 *
 * Binding constraints, whichever is tightest: the figure covers `fillY` of the
 * viewport height, covers no more than `maxFillX` of its width (this is what
 * widens the shot on narrow/portrait viewports), and no corner projects outside
 * ±NDC_SAFE.
 */
export function fitFraming(box: Box3, options: FramingOptions): Framing {
  const fov = options.fov ?? CAMERA_FOV;
  const aspect = Math.max(0.2, Number.isFinite(options.aspect) ? options.aspect : 1);
  const fillY = options.fillY ?? TARGET_FILL_Y;
  const maxFillX = options.maxFillX ?? MAX_FILL_X;
  const azimuth = options.azimuth ?? DEFAULT_AZIMUTH;
  const elevation = options.elevation ?? DEFAULT_ELEVATION;

  // Pad for the idle rig (bob + sway + scale pulse) so animation can never
  // push a hand or a heel outside the frame we just proved.
  const padded = box.clone().expandByVector(options.pad ?? MOTION_PAD);
  const target = padded.getCenter(new Vector3());
  const size = padded.getSize(new Vector3());
  const direction = orbitDirection(azimuth, elevation);
  const corners = boxCorners(padded);

  const camera = new PerspectiveCamera(fov, aspect, 0.05, 400);
  // Start deliberately FAR: a corner behind the near plane makes the projection
  // meaningless, and the iteration only ever needs to walk inwards from here.
  let distance = Math.max(1, size.length() / (2 * 0.2 * Math.tan(MathUtils.degToRad(fov) / 2)));
  let metrics = probe(camera, corners, target, direction, distance, aspect);
  let iterations = 0;

  for (; iterations < 48; iterations++) {
    const k = Math.max(
      metrics.fillY / fillY,
      metrics.fillX / maxFillX,
      metrics.maxAbsY / NDC_SAFE,
      metrics.maxAbsX / NDC_SAFE,
    );
    if (!Number.isFinite(k) || k <= 0) break;
    if (Math.abs(k - 1) < 5e-4) break;
    distance *= MathUtils.clamp(k, 0.6, 1.8);
    metrics = probe(camera, corners, target, direction, distance, aspect);
  }

  const position = target.clone().addScaledVector(direction, distance);
  // Zoom is clamped RELATIVE to the solve, not to absolute metres: leaning in
  // past 0.6× starts cropping him, and backing off past 1.4× leaves him a speck
  // in an empty tile. Both ends stay a deliberate composition.
  const minDistance = Math.max(0.8, distance * 0.6);
  const maxDistance = Math.max(minDistance + 0.4, distance * 1.4);

  return {
    target,
    position,
    direction,
    distance,
    minDistance,
    maxDistance,
    azimuth,
    fillY: metrics.fillY,
    fillX: metrics.fillX,
    iterations,
  };
}

function probe(
  camera: PerspectiveCamera,
  corners: Vector3[],
  target: Vector3,
  direction: Vector3,
  distance: number,
  aspect: number,
): ProjectionMetrics {
  camera.aspect = aspect;
  camera.position.copy(target).addScaledVector(direction, distance);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  return projectMetrics(camera, corners);
}
