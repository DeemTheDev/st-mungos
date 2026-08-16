"use client";

// "Which voice does the patient speak in?" — her choice, remembered.
//
// Same shape as components/ward/scene-preference.ts and for the same reason:
// reading localStorage during render is a hydration mismatch, and reading it in
// an effect is a cascading render (the react-hooks lint rule rejects both). As
// an external store the server snapshot is always "random", the browser snapshot
// is resolved once on first read, and there is exactly one re-render.
//
// The VALUE is either RANDOM_PATIENT_VOICE or a concrete Azure voice name. It is
// only ever a *request*: lib/speech/voices.ts still lets a server-side
// VOICE_PATIENT_F / VOICE_PATIENT_M pin override it, and an unknown name (a pool
// that changed under her) falls back to the deterministic random pick.

import { useCallback, useSyncExternalStore } from "react";
import { RANDOM_PATIENT_VOICE } from "@/lib/speech/voices";

const STORAGE_KEY = "st-mungos:patient-voice";

let snapshot: string | null = null;
const listeners = new Set<() => void>();

function resolve(): string {
  try {
    return window.localStorage.getItem(STORAGE_KEY)?.trim() || RANDOM_PATIENT_VOICE;
  } catch {
    return RANDOM_PATIENT_VOICE; // private mode / storage disabled
  }
}

function getSnapshot(): string {
  snapshot ??= resolve();
  return snapshot;
}

function getServerSnapshot(): string {
  return RANDOM_PATIENT_VOICE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePatientVoicePreference(): [string, (next: string) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const set = useCallback((next: string) => {
    const clean = next.trim() || RANDOM_PATIENT_VOICE;
    try {
      window.localStorage.setItem(STORAGE_KEY, clean);
    } catch {
      /* storage disabled — the choice just doesn't persist */
    }
    snapshot = clean;
    for (const listener of listeners) listener();
  }, []);

  return [value, set];
}
