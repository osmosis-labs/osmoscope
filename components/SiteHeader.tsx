import Link from "next/link";

// Shared site header used by every page: logo + OSMOscope wordmark + a per-page
// subtitle, and a primary <nav> landmark linking the two sections with an
// active-state indication. Extracted so the header (and its heading levels /
// nav semantics) live in one place instead of being duplicated per page.
//
// `subtitle` is the current section name ("Tokenomics" / "Treasury"); `current`
// marks which nav link is active so the other reads as the destination.
const NAV = [
  { href: "/", label: "Tokenomics" },
  { href: "/treasury", label: "Treasury" },
] as const;

export function SiteHeader({
  subtitle,
  current,
}: {
  subtitle: string;
  current: "/" | "/treasury";
}) {
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
      <nav aria-label="Primary" className="shrink-0">
        <ul className="flex gap-2">
          {NAV.map(({ href, label }) => {
            const active = href === current;
            return (
              <li key={href}>
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={`block rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "border-white/30 bg-white/20 text-white"
                      : "border-white/20 bg-white/5 text-osmo-100 hover:bg-white/15 hover:text-white"
                  }`}
                >
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </header>
  );
}
