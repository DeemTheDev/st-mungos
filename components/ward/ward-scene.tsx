"use client";

// The patient PORTRAIT (CLAUDE.md §8) — one figure, lit like a studio headshot,
// on a transparent canvas over the tile's CSS background.
//
// There is deliberately no room here any more. The ward (backdrop wall, floor
// plane, bed, cabinet, drip stand) was ~200 lines of grey primitives that made
// the tile look like a first-year scene graph and buried the one thing worth
// looking at. Deleting it removed the draw calls, removed every "camera clips
// the wall" constraint on the orbit, and let the tile background become a
// composed CSS gradient instead of a lump of geometry.
//
// This module is the heavy one (three + the loader) and is ONLY ever reached
// through the next/dynamic({ ssr:false }) call in ./ward-stage.tsx, so it never
// lands in the server bundle and never blocks text mode.
//
// Three bugs this file exists to have fixed:
//
//  1. FRAMING. The camera was a guess — position [0,1.05,3.9] with r3f's default
//     `lookAt(0,0,0)`, i.e. aimed at the FLOOR under the patient. The top of the
//     frame landed at y≈1.32 m, so the head (1.47–1.75 m) was cropped: "you can
//     only see his boots". The camera is now solved from the model's measured
//     bounding box (./framing.ts) and re-solved on every canvas resize.
//     `pnpm verify:framing` is the regression test.
//  2. MATERIALS. The suit material ships with no `metallicFactor`, and glTF
//     defaults that to 1.0 — a full metal with no environment map renders BLACK.
//     The legs/boots (metallicFactor 0) were the only part still catching light,
//     which is exactly what the screenshot showed. Fixed at the source: metalness
//     is clamped and a procedurally generated IBL probe is bound to the scene, so
//     PBR surfaces have something to reflect. No CDN fetch, no HDR asset.
//  3. TONE MAPPING. r3f defaults to ACES Filmic, which crushed the already dim
//     room into black. Swapped for Khronos PBR Neutral, exposure nudged up — the
//     brief was "a little bit brighter" and the suit's red/blue has to read.
//
// Idle animation is a slow breathing bob + a lazy sway. When the PATIENT is
// speaking the bob speeds up and gains a subtle scale pulse; the examiner's
// lines leave the patient idle (she gets an animated tile instead).

import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useGLTF } from "@react-three/drei";
import {
  Box3,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  NeutralToneMapping,
  PMREMGenerator,
  PerspectiveCamera,
  SRGBColorSpace,
  Vector3,
  type WebGLRenderTarget,
} from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import {
  CAMERA_FOV,
  ORBIT_AZIMUTH_SPAN,
  ORBIT_POLAR_MAX,
  ORBIT_POLAR_MIN,
  fallbackPatientBox,
  fitFraming,
  normalisePatient,
  type Framing,
} from "./framing";

/** Compressed (meshopt + 1K WebP textures) copy of the Spider-Man model. */
const MODEL_URL = "/models/patient.glb";
/** Seconds the "Reset view" ease takes. */
const RESET_SECONDS = 0.45;
/**
 * Indirect light from the generated probe. With no room geometry this is the
 * only thing filling the shadow side of a PBR surface, so it carries more of
 * the look than it did when there were walls to bounce off.
 */
const ENVIRONMENT_INTENSITY = 0.85;

/** Where the camera starts before the model has reported its real bounds. */
const INITIAL_FRAMING = fitFraming(fallbackPatientBox(), { aspect: 4 / 5 });

/** The slice of drei's OrbitControls this file drives. */
interface OrbitLike {
  target: Vector3;
  enabled: boolean;
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
  minAzimuthAngle: number;
  maxAzimuthAngle: number;
  update(): void;
}

/** What the tile needs to know to decide between the canvas and a fallback card. */
export type ModelStatus = "loading" | "ready" | "failed";

// ---------------------------------------------------------------------------

/**
 * A failed fetch/parse must never leave a black tile: the boundary reports the
 * failure upwards so ./ward-stage.tsx can swap in the monogram card, and warns
 * once so the cause is visible in the console.
 */
class ModelBoundary extends Component<{ onFailed: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[ward] patient model unavailable — falling back to the details card", error);
    this.props.onFailed();
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function PatientModel({ onMeasured }: { onMeasured: (box: Box3) => void }) {
  // useDraco=false → no gstatic decoder fetch; useMeshopt=true → the decoder
  // bundled with three-stdlib handles our EXT_meshopt_compression geometry.
  const { scene } = useGLTF(MODEL_URL, false, true);

  const patient = useMemo(() => {
    const normalised = normalisePatient(scene);

    // Material repair. `scene.clone()` shares materials with drei's cache, so
    // every edit here is idempotent on purpose — re-mounting must not compound.
    normalised.object.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const standard = material as MeshStandardMaterial;
        if (!standard.isMeshStandardMaterial) continue;
        // glTF's metallicFactor default is 1.0 and this .glb leaves it unset on
        // the suit — a rough full metal with nothing to reflect is a black
        // silhouette. A fabric costume is not metal; clamp it.
        standard.metalness = Math.min(standard.metalness, 0.25);
        standard.envMapIntensity = 1;
        // GLTFLoader tags base colour maps sRGB itself, but the WebP/meshopt
        // pass is exactly where that gets lost — assert it rather than trust it.
        // Getting this wrong is what makes a textured model render unlit-black,
        // and no amount of extra light intensity fixes it.
        if (standard.map) standard.map.colorSpace = SRGBColorSpace;
        if (standard.emissiveMap) standard.emissiveMap.colorSpace = SRGBColorSpace;
        standard.needsUpdate = true;
      }
    });

    return normalised;
  }, [scene]);

  useEffect(() => {
    for (const warning of patient.warnings) {
      console.warn(`[ward] patient bounds look wrong (${warning}) — framing may be off`);
    }
    onMeasured(patient.box);
  }, [patient, onMeasured]);

  return <primitive object={patient.object} />;
}

/**
 * Idle rig. Reads the speaking flag through a ref so the per-frame callback is
 * immune to however the render pipeline memoises props.
 *
 * NOTE: the excursions below are the source of MOTION_PAD in ./framing.ts — if
 * you make the idle bigger, widen the pad or the fit stops being a proof.
 */
function PatientRig({
  speaking,
  reducedMotion,
  onMeasured,
  onFailed,
}: {
  speaking: boolean;
  reducedMotion: boolean;
  onMeasured: (box: Box3) => void;
  onFailed: () => void;
}) {
  const group = useRef<Group>(null);
  const target = useRef(0);
  const level = useRef(0);

  useEffect(() => {
    target.current = speaking ? 1 : 0;
  }, [speaking]);

  useFrame((state, delta) => {
    const node = group.current;
    if (!node) return;
    // Clamp delta so a backgrounded tab doesn't snap the rig on return.
    const step = Math.min(delta, 0.1);
    level.current += (target.current - level.current) * Math.min(1, step * 4);

    const t = state.clock.elapsedTime;
    const damp = reducedMotion ? 0.25 : 1;
    const speak = level.current;

    node.position.y = Math.sin(t * (0.9 + speak * 1.4)) * (0.012 + speak * 0.028) * damp;
    node.rotation.y = (Math.sin(t * 0.31) * 0.05 + Math.sin(t * 2.1) * 0.018 * speak) * damp;
    node.scale.setScalar(1 + Math.sin(t * 8.5) * 0.008 * speak * damp);
  });

  return (
    <group ref={group}>
      <ModelBoundary onFailed={onFailed}>
        <Suspense fallback={null}>
          <PatientModel onMeasured={onMeasured} />
        </Suspense>
      </ModelBoundary>
    </group>
  );
}

/**
 * Camera + orbit. Solves the framing from the measured box for the CURRENT tile
 * aspect (r3f's `size` is driven by a ResizeObserver on the canvas parent, so
 * this re-solves whenever the bento tile changes shape — including the jump from
 * a tall desktop tile to a short mobile band), keeps her orbit direction and
 * relative zoom across the re-fit, clamps the orbit so she can never flip
 * overhead or under his feet, and eases back to the default pose on reset.
 */
function CameraRig({ box, resetToken }: { box: Box3; resetToken: number }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const width = useThree((state) => state.size.width);
  const height = useThree((state) => state.size.height);

  const controlsRef = useRef<OrbitLike | null>(null);
  const appliedRef = useRef<Framing | null>(null);
  const tweenRef = useRef<{ from: Vector3; fromTarget: Vector3; to: Vector3; toTarget: Vector3; t: number } | null>(
    null,
  );

  const aspect = Math.max(0.2, width / Math.max(1, height));
  const framing = useMemo(() => fitFraming(box, { aspect, fov: CAMERA_FOV }), [box, aspect]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;

    // Preserve her orbit across a re-fit: keep the viewing direction and the
    // relative zoom, take the new distance and target from the solve.
    let direction = framing.direction;
    let zoom = 1;
    const previous = appliedRef.current;
    if (previous) {
      const offset = camera.position.clone().sub(controls.target);
      const radius = offset.length();
      if (radius > 1e-4) {
        direction = offset.divideScalar(radius);
        zoom = MathUtils.clamp(radius / previous.distance, 0.6, 1.4);
      }
    }
    appliedRef.current = framing;

    controls.minDistance = framing.minDistance;
    controls.maxDistance = framing.maxDistance;
    controls.minPolarAngle = ORBIT_POLAR_MIN;
    controls.maxPolarAngle = ORBIT_POLAR_MAX;
    controls.minAzimuthAngle = framing.azimuth - ORBIT_AZIMUTH_SPAN;
    controls.maxAzimuthAngle = framing.azimuth + ORBIT_AZIMUTH_SPAN;

    controls.target.copy(framing.target);
    camera.position
      .copy(framing.target)
      .addScaledVector(direction, MathUtils.clamp(framing.distance * zoom, framing.minDistance, framing.maxDistance));
    camera.lookAt(framing.target);
    controls.update();
  }, [camera, framing]);

  // "Reset view" — ease home rather than snap, and hand control back after.
  useEffect(() => {
    const controls = controlsRef.current;
    const applied = appliedRef.current;
    if (resetToken === 0 || !controls || !applied) return;
    tweenRef.current = {
      from: camera.position.clone(),
      fromTarget: controls.target.clone(),
      to: applied.position.clone(),
      toTarget: applied.target.clone(),
      t: 0,
    };
    controls.enabled = false;
  }, [camera, resetToken]);

  useFrame((_, delta) => {
    const tween = tweenRef.current;
    const controls = controlsRef.current;
    if (!tween || !controls) return;
    tween.t = Math.min(1, tween.t + Math.min(delta, 0.1) / RESET_SECONDS);
    const eased = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
    camera.position.lerpVectors(tween.from, tween.to, eased);
    controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
    controls.update();
    if (tween.t >= 1) {
      tweenRef.current = null;
      controls.enabled = true;
    }
  });

  return (
    <OrbitControls
      // keyEvents defaults to false in drei — the canvas must NEVER take the
      // spacebar, which is push-to-talk. Stated explicitly so nobody "fixes" it.
      keyEvents={false}
      makeDefault
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.55}
      zoomSpeed={0.5}
      ref={(instance) => {
        controlsRef.current = instance as unknown as OrbitLike | null;
      }}
    />
  );
}

/**
 * Portrait lighting, four cheap lights, no shadow maps.
 *
 * With the room gone there is nothing to bounce off, so the rig has to do the
 * whole job: a strong key from front-right-above, a cooler fill from the left
 * that keeps the shadow side readable rather than black, a rim from behind to
 * separate the silhouette from the tile background, and a low bounce standing
 * in for the floor light that used to come off the vinyl.
 */
function PortraitLighting() {
  return (
    <>
      {/* ambient bounce: sky above, a dim warm "floor" below */}
      <hemisphereLight args={["#c9d8f2", "#2b2f38", 1.35]} />
      {/* key */}
      <directionalLight position={[2.6, 3.6, 3.2]} intensity={2.6} color="#fff6ec" />
      {/* fill: cooler, weaker, opposite side — lifts the shadow side off black */}
      <directionalLight position={[-3.1, 1.9, 2.2]} intensity={1.15} color="#a8c4ec" />
      {/* rim: behind and above, peels him off the background */}
      <directionalLight position={[-1.4, 3.2, -3.4]} intensity={1.9} color="#dbe7ff" />
    </>
  );
}

export interface WardSceneProps {
  /** True while the patient's TTS line is playing (or a fresh text-mode line). */
  patientSpeaking: boolean;
  reducedMotion: boolean;
  /** Bumped by the tile's "Reset view" — 0 means "never reset", so no tween on mount. */
  resetToken: number;
  /** Lets the tile swap in the details card instead of showing an empty canvas. */
  onStatusChange?: (status: ModelStatus) => void;
}

export default function WardScene({
  patientSpeaking,
  reducedMotion,
  resetToken,
  onStatusChange,
}: WardSceneProps) {
  const [box, setBox] = useState<Box3>(() => fallbackPatientBox());
  const environmentRef = useRef<WebGLRenderTarget | null>(null);
  const statusRef = useRef<ModelStatus>("loading");

  const report = useCallback(
    (status: ModelStatus) => {
      if (statusRef.current === status) return;
      statusRef.current = status;
      onStatusChange?.(status);
    },
    [onStatusChange],
  );

  // Identity-stable so PatientModel's effect doesn't re-fire every render, and
  // value-stable so an identical remeasure doesn't re-solve the framing.
  const handleMeasured = useCallback(
    (measured: Box3) => {
      setBox((current) => (current.equals(measured) ? current : measured));
      report("ready");
    },
    [report],
  );

  const handleFailed = useCallback(() => report("failed"), [report]);

  useEffect(
    () => () => {
      environmentRef.current?.dispose();
      environmentRef.current = null;
    },
    [],
  );

  return (
    <Canvas
      // alpha: the canvas is TRANSPARENT and composites over the tile's CSS
      // gradient — that background is styling, not geometry, so it costs nothing
      // and can be themed without touching three.
      // Capped DPR + no antialias keeps this cheap on her laptop and on a phone
      // if she opts in; the tile never competes with voice for the main thread.
      dpr={[1, 1.5]}
      gl={{ alpha: true, antialias: false, powerPreference: "low-power" }}
      camera={{
        fov: CAMERA_FOV,
        near: 0.1,
        far: 80,
        position: [INITIAL_FRAMING.position.x, INITIAL_FRAMING.position.y, INITIAL_FRAMING.position.z],
      }}
      className="cursor-grab touch-none active:cursor-grabbing"
      onCreated={({ gl, scene }) => {
        // r3f's default is ACES Filmic, which crushes the mid-tones to black.
        gl.toneMapping = NeutralToneMapping;
        gl.toneMappingExposure = 1.15;

        // Procedural image-based lighting. RoomEnvironment is generated
        // in-process (no HDR download, no CDN — drei's <Environment preset>
        // would fetch one), and it is what stops metallic/rough PBR surfaces
        // from rendering as black holes. It is a light probe only: with
        // scene.background left null the canvas stays transparent.
        const pmrem = new PMREMGenerator(gl);
        const room = new RoomEnvironment();
        const environment = pmrem.fromScene(room, 0.04);
        scene.environment = environment.texture;
        scene.environmentIntensity = ENVIRONMENT_INTENSITY;
        pmrem.dispose();
        room.dispose();
        environmentRef.current = environment;

        // A lost context paints nothing; without this the tile would go back to
        // being the black box the whole redesign exists to kill.
        gl.domElement.addEventListener("webglcontextlost", () => report("failed"));
      }}
    >
      <PortraitLighting />
      <PatientRig
        speaking={patientSpeaking}
        reducedMotion={reducedMotion}
        onMeasured={handleMeasured}
        onFailed={handleFailed}
      />
      <CameraRig box={box} resetToken={resetToken} />
    </Canvas>
  );
}
