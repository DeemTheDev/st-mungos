// The one shared way around the app. Direct-URL-only navigation was the single
// loudest piece of user feedback ("no buttons to redirect to /session etc"), so
// every top-level page mounts this bar.
//
// Deliberately server-safe: the active route is passed in as a prop rather than
// read from usePathname(), so this stays a server component and ships zero JS.
import Link from "next/link";

export type NavKey = "home" | "stations" | "notes" | "review";

const LINKS: Array<{ key: NavKey; href: string; label: string }> = [
  { key: "stations", href: "/session", label: "Stations" },
  { key: "notes", href: "/notes", label: "Notes" },
  { key: "review", href: "/admin/review", label: "Review" },
];

export function SiteNav({ active }: { active?: NavKey }) {
  return (
    <nav className="no-print border-b border-neutral-800 bg-neutral-950">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-2.5">
        <Link
          href="/"
          className={`text-xs tracking-[0.2em] uppercase transition-colors ${
            active === "home" ? "text-neutral-200" : "text-neutral-500 hover:text-neutral-300"
          }`}
        >
          St Mungo&apos;s
        </Link>
        <ul className="flex items-center gap-1 text-sm">
          {LINKS.map((link) => (
            <li key={link.key}>
              <Link
                href={link.href}
                aria-current={active === link.key ? "page" : undefined}
                className={`rounded px-2.5 py-1 transition-colors ${
                  active === link.key
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
