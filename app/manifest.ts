// PWA manifest — served at /manifest.webmanifest, auto-linked by Next.
// start_url is /flashcards: the installed app on her phone IS the study tool
// (docs/FLASHCARDS.md §6); the rest of St Mungo's is one nav tap away.
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "St Mungo's",
    short_name: "St Mungo's",
    description:
      "OSCE practice and spaced-repetition flashcards — Hospital for Magical Maladies & OSCE Injuries.",
    id: "/flashcards",
    start_url: "/flashcards",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0a0a0a",
    theme_color: "#0a0a0a",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
