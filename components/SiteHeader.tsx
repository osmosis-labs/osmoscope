"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Shared site header used by every page: logo + OSMOscope wordmark + a per-page
// subtitle, and a primary <nav> landmark linking the sections with an active-state
// indication. Extracted so the header (and its heading levels / nav semantics)
// live in one place instead of being duplicated per page.
//
// The nav shows inline buttons from `sm` up; on narrow screens (three sections
// now overflow the header row) it collapses to a hamburger that toggles a
// dropdown. `subtitle` is the current section name; `current` marks the active
// link so the others read as destinations.
const NAV = [
  { href: "/", label: "Tokenomics" },
  { href: "/treasury", label: "Treasury" },
  { href: "/network", label: "Network" },
] as const;

export function SiteHeader({
  subtitle,
  current,
}: {
  subtitle: string;
  current: "/" | "/treasury" | "/network";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);

  // Close the mobile menu on outside click / Escape, so it behaves like a normal
  // dropdown. Only wired while open.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (navRef.current && !navRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const linkClass = (active: boolean) =>
    `block rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? "border-white/30 bg-white/20 text-white"
        : "border-white/20 bg-white/5 text-osmo-100 hover:bg-white/15 hover:text-white"
    }`;

  return (
    <header className="mb-6 mt-2 flex items-center justify-between gap-3 sm:gap-4">
      <div className="flex items-center gap-3 sm:gap-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- small static
            brand icon, class-sized (no CLS); next/image adds no value here. */}
        <img
          src="/Osmosis_Icon.png"
          alt="OSMOscope logo"
          className="h-12 w-12 shrink-0 sm:h-16 sm:w-16"
        />
        <div>
          <h1 className="text-2xl font-bold leading-tight text-white sm:text-4xl">
            OSMOscope
          </h1>
          <p className="text-sm text-osmo-200 sm:text-base">{subtitle}</p>
        </div>
      </div>

      <nav aria-label="Primary" ref={navRef} className="relative shrink-0">
        {/* Inline links: sm and up. */}
        <ul className="hidden gap-2 sm:flex">
          {NAV.map(({ href, label }) => (
            <li key={href}>
              <Link
                href={href}
                aria-current={href === current ? "page" : undefined}
                className={linkClass(href === current)}
              >
                {label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Hamburger: below sm. */}
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          aria-expanded={menuOpen}
          aria-controls="mobile-nav"
          aria-label="Menu"
          className="flex h-10 w-10 items-center justify-center rounded-lg border border-white/20 bg-white/5 text-white transition-colors hover:bg-white/15 sm:hidden"
        >
          {/* Simple hamburger / close glyph (no icon dep). */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            {menuOpen ? (
              <path
                d="M5 5l10 10M15 5L5 15"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            ) : (
              <path
                d="M3 6h14M3 10h14M3 14h14"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            )}
          </svg>
        </button>

        {/* Mobile dropdown panel. */}
        {menuOpen && (
          <ul
            id="mobile-nav"
            className="absolute right-0 top-12 z-30 flex min-w-[10rem] flex-col gap-2 rounded-lg border border-white/20 bg-osmo-900 p-2 shadow-xl sm:hidden"
          >
            {NAV.map(({ href, label }) => (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={href === current ? "page" : undefined}
                  onClick={() => setMenuOpen(false)}
                  className={linkClass(href === current)}
                >
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </header>
  );
}
