"use client";

// The exam room (CLAUDE.md §8): a deliberately cheap react-three-fiber scene —
// floor + backdrop + a bed primitive, ambient light and ONE key light, with the
// patient .glb centre-frame. No lighting rabbit holes, no post-processing.
//
// This module is the heavy one (three + the loader) and is ONLY ever reached
// through the next/dynamic({ ssr:false }) call in ./ward-stage.tsx, so it never
// lands in the server bundle and never blocks text mode.
//
// Idle animation is a slow breathing bob + a lazy sway. When the PATIENT is
// speaking the bob speeds up and gains a subtle scale pulse; the examiner's
// lines leave the patient idle (she gets an animated bubble instead).

import { Component, Suspense, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { Box3, Color, Group, Vector3 } from "three";

/** Compressed (meshopt + 1K WebP textures) copy of the Spider-Man model. */
const MODEL_URL = "/models/patient.glb";
/** Metres — the loaded model is normalised to this so any .glb frames the same. */
const PATIENT_HEIGHT = 1.75;

// ---------------------------------------------------------------------------

/**
 * The room is the deliverable; the model is a bonus. A failed fetch/parse must
 * never blank the station, so the patient sits behind an error boundary that
 * renders nothing and warns once.
 */
class ModelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[ward] patient model unavailable — showing the empty room", error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function PatientModel() {
  // useDraco=false → no gstatic decoder fetch; useMeshopt=true → the decoder
  // bundled with three-stdlib handles our EXT_meshopt_compression geometry.
  const { scene } = useGLTF(MODEL_URL, false, true);

  // Normalise once: centre on X/Z, feet on the floor, scaled to human height.
  // The correction rides on a WRAPPER so the model's own transform (this .glb
  // is quantised, so its scale is load-bearing) is left exactly as authored.
  const model = useMemo(() => {
    const root = scene.clone(true);
    const box = new Box3().setFromObject(root);
    const size = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const scale = size.y > 0 ? PATIENT_HEIGHT / size.y : 1;

    const wrapper = new Group();
    wrapper.add(root);
    wrapper.scale.setScalar(scale);
    wrapper.position.set(-centre.x * scale, -box.min.y * scale, -centre.z * scale);
    return wrapper;
  }, [scene]);

  return <primitive object={model} />;
}

/**
 * Idle rig. Reads the speaking flag through a ref so the per-frame callback is
 * immune to however the render pipeline memoises props.
 */
function PatientRig({ speaking, reducedMotion }: { speaking: boolean; reducedMotion: boolean }) {
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
      <ModelBoundary>
        <Suspense fallback={null}>
          <PatientModel />
        </Suspense>
      </ModelBoundary>
    </group>
  );
}

/** Floor + backdrop + a bed she can recognise as a bed. Primitives only. */
function Room() {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow={false}>
        <planeGeometry args={[26, 26]} />
        <meshStandardMaterial color="#0c1016" roughness={0.95} metalness={0} />
      </mesh>

      <mesh position={[0, 3.2, -4.2]}>
        <planeGeometry args={[26, 9]} />
        <meshStandardMaterial color="#121821" roughness={1} metalness={0} />
      </mesh>

      {/* bed: frame, mattress, pillow — set back and to the side so the
          patient stays centre-frame */}
      <group position={[1.55, 0, -1.5]} rotation={[0, -0.28, 0]}>
        <mesh position={[0, 0.2, 0]}>
          <boxGeometry args={[0.98, 0.4, 2.05]} />
          <meshStandardMaterial color="#161d27" roughness={0.9} />
        </mesh>
        <mesh position={[0, 0.47, 0]}>
          <boxGeometry args={[0.94, 0.16, 2]} />
          <meshStandardMaterial color="#27313f" roughness={0.85} />
        </mesh>
        <mesh position={[0, 0.6, -0.78]}>
          <boxGeometry args={[0.52, 0.11, 0.32]} />
          <meshStandardMaterial color="#3a4757" roughness={0.8} />
        </mesh>
        {/* headboard */}
        <mesh position={[0, 0.62, -1.06]}>
          <boxGeometry args={[0.98, 0.72, 0.07]} />
          <meshStandardMaterial color="#1b2330" roughness={0.9} />
        </mesh>
      </group>
    </group>
  );
}

export interface WardSceneProps {
  /** True while the patient's TTS line is playing (or a fresh text-mode line). */
  patientSpeaking: boolean;
  reducedMotion: boolean;
}

export default function WardScene({ patientSpeaking, reducedMotion }: WardSceneProps) {
  return (
    <Canvas
      // Capped DPR + no antialias keeps this cheap on her laptop and on a phone
      // if she opts in; the scene never competes with voice for the main thread.
      dpr={[1, 1.5]}
      gl={{ antialias: false, powerPreference: "low-power" }}
      camera={{ position: [0, 1.05, 3.9], fov: 38, near: 0.1, far: 60 }}
      onCreated={({ scene }) => {
        scene.background = new Color("#07090d");
      }}
    >
      <ambientLight intensity={0.45} color="#93a7c4" />
      <directionalLight position={[2.6, 4.6, 3.2]} intensity={2.1} color="#dbe7ff" />
      <Room />
      <PatientRig speaking={patientSpeaking} reducedMotion={reducedMotion} />
    </Canvas>
  );
}
