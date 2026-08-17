"use client";

// Registers the hand-rolled service worker (public/sw.js) — see DECISIONS:
// @serwist/next's injection plugin is webpack-only and Next 16 builds with
// Turbopack, so the SW is a plain static file registered here. Production
// only: a caching SW during `next dev` is nothing but misery.

import { useEffect } from "react";

export function RegisterSw() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch((err) => {
        console.warn("Service worker registration failed", err);
      });
    };
    if (document.readyState === "complete") {
      register();
      return;
    }
    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
