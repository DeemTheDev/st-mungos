"use client";

// The "3D room on/off" preference (CLAUDE.md §8 exam room).
//
// The scene is decoration: the station must be fully usable without it, so the
// default is deliberately conservative — ON only on a desktop-sized viewport
// with WebGL and no reduced-motion preference. Once she flips the toggle her
// choice is remembered in localStorage and wins on every later visit.
//
// It reads as an external store rather than state-in-an-effect: the server
// snapshot is always "not ready", the browser snapshot is resolved once on
// first read, so hydration matches and there are no cascading renders.

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "st-mungos:ward-scene";

/** Below this the scene is off by default — phones stay light and text-first. */
const SMALL_SCREEN_QUERY = "(max-width: 767px)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(query).matches
    : false;
}

/** A cheap capability probe — a context-less browser must never see a Canvas. */
function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

function readStored(): "on" | "off" | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === "on" || value === "off" ? value : null;
  } catch {
    return null; // private mode / storage disabled — fall back to the default
  }
}

interface SceneSnapshot {
  /** False until the browser-only default is resolved (avoids an SSR mismatch). */
  ready: boolean;
  enabled: boolean;
  /** Honoured by the scene itself: idle motion is damped when true. */
  reducedMotion: boolean;
  /** False when WebGL is unavailable — the toggle is hidden entirely. */
  supported: boolean;
}

const SERVER_SNAPSHOT: SceneSnapshot = {
  ready: false,
  enabled: false,
  reducedMotion: false,
  supported: false,
};

let snapshot: SceneSnapshot | null = null;
const listeners = new Set<() => void>();

function resolve(): SceneSnapshot {
  const reducedMotion = matches(REDUCED_MOTION_QUERY);
  const supported = webglAvailable();
  const stored = readStored();
  return {
    ready: true,
    supported,
    reducedMotion,
    enabled: supported && (stored ? stored === "on" : !reducedMotion && !matches(SMALL_SCREEN_QUERY)),
  };
}

function getSnapshot(): SceneSnapshot {
  snapshot ??= resolve();
  return snapshot;
}

function getServerSnapshot(): SceneSnapshot {
  return SERVER_SNAPSHOT;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface ScenePreference extends SceneSnapshot {
  setEnabled: (on: boolean) => void;
}

export function useScenePreference(): ScenePreference {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setEnabled = useCallback((on: boolean) => {
    try {
      window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
    } catch {
      /* storage disabled — the choice just doesn't persist */
    }
    snapshot = { ...getSnapshot(), enabled: on };
    for (const listener of listeners) listener();
  }, []);

  return { ...state, setEnabled };
}
