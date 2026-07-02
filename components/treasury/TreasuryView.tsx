"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useTreasuryData } from "@/lib/hooks/useTreasuryData";
import { Card } from "@/components/ui/Card";
import { ScreenshotButtons } from "@/components/ScreenshotButtons";
import { formatNumberWithCommas, formatUsd as usd } from "@/lib/utils";
import { EXPLORER_BASE, tokenColor } from "@/config/community-pool";
import { EtherscanMark, MintscanMark } from "./ExplorerIcons";
import type {
  AssetTotal,
  TreasuryHolder,
  ClPositionCard,
  VaultPositionCard,
  HolderAddress,
} from "@/lib/treasury/snapshot";

// Compact USD for chart labels / tight spots (e.g. $1.2M, $384K).
function usdCompact(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

// Token amount: meaningful precision without noise. At/above 1000 the fractional
// part is just noise, so drop the decimals; 1-1000 keeps 2 places; sub-1 keeps
// 4 significant figures.
function amount(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) return formatNumberWithCommas(n, 0);
  if (abs >= 1) return formatNumberWithCommas(n, 2);
  return n.toPrecision(4);
}

// A human price for the CL range. Prices span a huge dynamic range across pairs
// (a BTC/USDC bound near 72,500; a PEPE/ETH bound near 1e-9), so pick a fixed
// (non-scientific) format per magnitude: thousands-separated integers for big
// numbers, a couple of decimals mid-range, and enough significant digits for
// very small ones — never toPrecision alone, which yields "7.25e+4".
function price(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) return formatNumberWithCommas(n, 0);
  if (abs >= 1) return formatNumberWithCommas(n, 2);
  if (abs >= 0.0001) {
    // 4 decimals is enough down to ~0.0001; trim trailing zeros.
    return n.toFixed(4).replace(/\.?0+$/, "");
  }
  // Very small: show ~3 significant figures WITHOUT scientific notation.
  const decimals = Math.min(20, Math.ceil(-Math.log10(abs)) + 2);
  return n.toFixed(decimals).replace(/\.?0+$/, "");
}

// OSMOscope palette for the pie slices (purples/pinks/teals, brand-forward).
const PIE_COLORS = [
  "#9B32CD",
  "#FF66CC",
  "#7C4DFF",
  "#95E1D3",
  "#C384E1",
  "#F6C453",
  "#5E12A0",
  "#66C2FF",
  "#FF8A65",
  "#AF5BD7",
];
const PIE_OTHER = "#4B3B63";

// Protocol brand colors for the vault-kind badges (from each project's brand).
const MARGINED_GREEN = "#BDFF00"; // Margined lime green (logo mark)
const MAGMA_RED = "#E13737"; // Magma red (--magma-red token, app.magma.eco)

// --- Explorer link next to a holder title ----------------------------------
// Small square logo linking to the address on Mintscan (Osmosis) or Etherscan
// (Ethereum).
function ExplorerLink({ addr }: { addr: HolderAddress }) {
  const ex = EXPLORER_BASE[addr.chain];
  return (
    <a
      href={ex.addressUrl(addr.address)}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`${ex.name}: ${addr.address}`}
      aria-label={`View on ${ex.name}`}
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white/10 p-0.5 transition-colors hover:bg-white/25"
    >
      {addr.chain === "ethereum" ? (
        <EtherscanMark className="h-full w-full text-white" />
      ) : (
        <MintscanMark className="h-full w-full" />
      )}
    </a>
  );
}

// --- One aggregated asset line ---------------------------------------------
function AssetRow({ asset }: { asset: AssetTotal }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
      <span className="min-w-0 truncate font-medium text-white">
        {asset.symbol}
      </span>
      <span className="flex shrink-0 items-baseline gap-4 text-right">
        <span className="tabular-nums text-osmo-200">
          {amount(asset.amount)}
        </span>
        <span className="w-28 font-semibold tabular-nums text-white">
          {asset.priceUnavailable ? "—" : usd(asset.value)}
        </span>
      </span>
    </div>
  );
}

// --- Per-holder minor-assets notice (moved off the top banner) -------------
function UnpricedNotice({ symbols }: { symbols: string[] }) {
  const n = symbols.length;
  if (n === 0) return null;
  return (
    <details className="mt-3 rounded bg-amber-500/10 p-3 text-xs text-amber-200">
      <summary className="cursor-pointer list-none">
        <span className="font-medium">{n}</span> minor asset{n === 1 ? "" : "s"}{" "}
        held here {n === 1 ? "has" : "have"} no market price (illiquid variants)
        and {n === 1 ? "is" : "are"} excluded.{" "}
        <span className="underline">show list</span>
      </summary>
      <p className="mt-2 break-words leading-relaxed text-amber-200/80">
        {symbols.join(", ")}
      </p>
    </details>
  );
}

// Render description text with any URLs / *.osmosis.zone domains as links.
// Splits on a URL pattern and interleaves <a> elements for the matches.
const URL_RE =
  /(https?:\/\/[^\s]+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.osmosis\.zone(?:\/[^\s]*)?)/gi;

function linkify(text: string): React.ReactNode[] {
  const parts = text.split(URL_RE);
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      const href = part.startsWith("http") ? part : `https://${part}`;
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="text-osmo-pink underline hover:text-white"
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{part}</span>;
  });
}

// --- `?` info tooltip (what the address is / how funded / where funds go) --
// The popover would otherwise be clipped/painted-under by later holder cards:
// each Card has backdrop-blur, which creates its own stacking context, so a
// z-index inside one card can't win against a sibling card. The fix is to raise
// the WHOLE card's z-index while the tooltip is shown. To keep that z-lift in
// exact lockstep with visibility (including click-to-open on touch, where CSS
// :hover "sticks" but wouldn't update the parent), visibility is driven by ONE
// piece of state and reported up via onOpen — no CSS :hover/:focus that the
// parent can't observe. stopPropagation so clicking `?` doesn't toggle the card.
function InfoTooltip({
  text,
  onOpen,
}: {
  text: string;
  onOpen?: (open: boolean) => void;
}) {
  // Track hover and click-pin SEPARATELY, else they fight: on a mouse that's
  // already hovering (open via hover), a single click would just toggle the
  // shared flag back off. Visible when hovered OR pinned; click toggles the pin.
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;

  // Report the effective open state up (drives the card's z-lift). useEffect so
  // the parent update happens after render, not during it.
  useEffect(() => {
    onOpen?.(open);
  }, [open, onOpen]);

  return (
    <span
      className="relative inline-flex shrink-0"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setPinned((v) => !v);
        }}
        onBlur={() => setPinned(false)}
        aria-label="About this address"
        aria-expanded={open}
        className="flex h-4 w-4 items-center justify-center rounded-full border border-white/30 text-[10px] font-bold leading-none text-osmo-200 transition-colors hover:bg-white/20 hover:text-white"
      >
        ?
      </button>
      {/* Pointer-events enabled only when open, so links inside are clickable
          (the wrapper's hover handlers keep it open while the pointer is on the
          tooltip; click-to-pin covers the button->tooltip gap). */}
      <span
        role="tooltip"
        className={`absolute left-1/2 top-6 w-64 -translate-x-1/2 rounded-lg border border-white/20 bg-osmo-900 p-3 text-left text-xs font-normal leading-relaxed text-osmo-100 shadow-xl transition-opacity duration-150 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      >
        {linkify(text)}
      </span>
    </span>
  );
}

// --- Holder card (collapsible) ---------------------------------------------
function HolderCard({
  holder,
  defaultOpen,
}: {
  holder: TreasuryHolder;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [tipOpen, setTipOpen] = useState(false);
  return (
    // relative + a raised z-index while the `?` tooltip is open lifts this card's
    // whole stacking context above the cards below, so the popover isn't painted
    // under them (each Card's backdrop-blur is its own stacking context).
    <Card className={`relative p-0 ${tipOpen ? "z-30" : ""}`}>
      <div className="flex w-full items-center justify-between gap-3 px-5 py-4">
        {/* Collapse toggle. A role="button" DIV rather than a real <button>
            because the title row contains other interactive elements (the `?`
            InfoTooltip button and the explorer links); a <button> can't legally
            nest a <button>, which triggered a hydration error. Keyboard support
            (Enter/Space) is added to match native button behaviour. */}
        <div
          role="button"
          tabIndex={0}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((v) => !v);
            }
          }}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
          aria-expanded={open}
        >
          <span
            className={`shrink-0 text-osmo-300 transition-transform ${open ? "rotate-90" : ""}`}
            aria-hidden
          >
            ▶
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold text-white">
                {holder.label}
              </span>
              {holder.description && (
                <InfoTooltip text={holder.description} onOpen={setTipOpen} />
              )}
              {holder.addresses.map((a) => (
                <ExplorerLink key={`${a.chain}:${a.address}`} addr={a} />
              ))}
            </span>
            <span className="block text-xs text-osmo-300">
              {holder.assets.length} asset
              {holder.assets.length === 1 ? "" : "s"}
            </span>
          </span>
        </div>
        <span className="shrink-0 text-lg font-bold tabular-nums text-white">
          {usd(holder.totalValue)}
        </span>
      </div>

      {open && (
        <div className="border-t border-white/10 px-5 py-3">
          {holder.assets.length === 0 ? (
            <p className="py-2 text-sm text-osmo-300">No holdings.</p>
          ) : (
            holder.assets.map((a) => <AssetRow key={a.symbol} asset={a} />)
          )}
          <UnpricedNotice symbols={holder.unpricedSymbols} />
        </div>
      )}
    </Card>
  );
}

// --- CL position card (Osmosis-frontend-style) -----------------------------
function ClCard({ pos }: { pos: ClPositionCard }) {
  const rewardValue = pos.rewards.reduce((s, r) => s + r.value, 0);
  const hasRange = pos.lowerPrice != null && pos.upperPrice != null;
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-white">
            {pos.token0Symbol} / {pos.token1Symbol}
          </div>
          <div className="text-xs text-osmo-300">
            Pool {pos.poolId} · {pos.holderLabel}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-bold tabular-nums text-white">
            {usd(pos.value)}
          </div>
          {rewardValue > 0 && (
            <div className="text-xs text-osmo-pink">
              +{usd(rewardValue)} rewards
            </div>
          )}
        </div>
      </div>

      <div className="mb-3 flex items-center justify-between gap-2 rounded bg-white/5 px-3 py-2 text-xs text-osmo-100">
        <span>
          {hasRange ? (
            <>
              <span className="text-osmo-300">Range </span>
              <span className="tabular-nums">
                {price(pos.lowerPrice as number)} –{" "}
                {price(pos.upperPrice as number)}
              </span>{" "}
              <span className="text-osmo-300">
                {pos.token1Symbol} per {pos.token0Symbol}
              </span>
            </>
          ) : (
            <span className="text-osmo-300">Range unavailable</span>
          )}
        </span>
        {pos.outOfRange && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 font-medium text-amber-300"
            title="This position is out of range: its price has moved outside the set bounds, so it currently earns no trading fees."
          >
            <span aria-hidden>⚠</span> Out of range
          </span>
        )}
      </div>

      <div className="space-y-1">
        {pos.assets.map((a) => (
          <div
            key={a.denom}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="text-white">{a.symbol}</span>
            <span className="flex items-baseline gap-3 text-right">
              <span className="tabular-nums text-osmo-200">
                {amount(a.amount)}
              </span>
              <span className="w-24 tabular-nums text-osmo-100">
                {a.priceUnavailable ? "—" : usd(a.value)}
              </span>
            </span>
          </div>
        ))}
        {/* Uncollected rewards, as "+ <TOKEN>" rows in the same table. */}
        {pos.rewards.map((r) => (
          <div
            key={`reward-${r.denom}`}
            className="flex items-baseline justify-between gap-3 text-sm"
            title="Uncollected reward"
          >
            <span className="text-osmo-pink">+ {r.symbol}</span>
            <span className="flex items-baseline gap-3 text-right">
              <span className="tabular-nums text-osmo-200">
                {amount(r.amount)}
              </span>
              <span className="w-24 tabular-nums text-osmo-100">
                {r.priceUnavailable ? "—" : usd(r.value)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- Vault / classic-pool position card ------------------------------------
// Magma + Margined vaults and GAMM classic pools: like a CL card but with no
// price range / out-of-range (vaults don't have those), just the underlying
// assets. A brand-colored kind badge distinguishes the position type.
function VaultCard({ pos }: { pos: VaultPositionCard }) {
  const badge =
    pos.kind === "Margined"
      ? { label: "Margined vault", bg: MARGINED_GREEN, fg: "#0A0A0A" }
      : pos.kind === "Magma"
        ? { label: "Magma vault", bg: MAGMA_RED, fg: "#FFFFFF" }
        : { label: "Pool", bg: "rgba(255,255,255,0.12)", fg: "#D7ADEB" };
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-white">{pos.label}</span>
            <span
              className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: badge.bg, color: badge.fg }}
            >
              {badge.label}
            </span>
          </div>
          <div className="text-xs text-osmo-300">
            {pos.poolRef ? `Pool ${pos.poolRef} · ` : ""}
            {pos.holderLabel}
          </div>
        </div>
        <div className="shrink-0 text-lg font-bold tabular-nums text-white">
          {usd(pos.value)}
        </div>
      </div>
      <div className="space-y-1">
        {pos.assets.map((a, i) => (
          <div
            key={`${a.symbol}-${i}`}
            className="flex items-baseline justify-between gap-3 text-sm"
          >
            <span className="text-white">{a.symbol}</span>
            <span className="flex items-baseline gap-3 text-right">
              <span className="tabular-nums text-osmo-200">
                {amount(a.amount)}
              </span>
              <span className="w-24 tabular-nums text-osmo-100">
                {a.priceUnavailable ? "—" : usd(a.value)}
              </span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// --- Generic value pie ------------------------------------------------------
// Renders a donut of {name, value} slices with a legend, and (optionally) an
// Exclude/Include OSMO toggle. Slices below MIN_SLICE_FRACTION of the shown total
// fold into "Other" so the chart stays legible. The caller supplies BOTH the
// full and the ex-OSMO slice sets; the toggle just picks between them.
const MIN_SLICE_FRACTION = 0.001; // 0.1%

interface Slice {
  name: string;
  value: number;
  // Optional token quantity (by-Asset pie shows this instead of a % column).
  // Undefined for slices with no single amount (by-Address, folded "Other").
  amount?: number;
}

function foldSmall(slices: Slice[]): { data: Slice[]; total: number } {
  const total = slices.reduce((s, x) => s + x.value, 0);
  if (total <= 0) return { data: [], total: 0 };
  const big: Slice[] = [];
  let otherValue = 0;
  for (const s of [...slices].sort((a, b) => b.value - a.value)) {
    if (s.value / total >= MIN_SLICE_FRACTION) big.push(s);
    else otherValue += s.value;
  }
  if (otherValue > 0) big.push({ name: "Other", value: otherValue });
  return { data: big, total };
}

function ValuePie({
  title,
  full,
  exOsmo,
  brandColors,
  shareText,
  shareFilename,
}: {
  title: string;
  full: Slice[];
  exOsmo?: Slice[]; // when provided, enables the Exclude/Include OSMO toggle
  // When true, color each slice by its token's brand color (tokenColor),
  // falling back to the palette. Used for the by-token pie.
  brandColors?: boolean;
  // When provided, a share pill (X + copy, no CSV) is shown; the caption is
  // prefilled into the X composer and the whole card is the screenshot target.
  shareText?: string;
  shareFilename?: string;
}) {
  const [includeOsmo, setIncludeOsmo] = useState(true);
  const source = !includeOsmo && exOsmo ? exOsmo : full;
  const { data: slices } = useMemo(() => foldSmall(source), [source]);
  const cardRef = useRef<HTMLDivElement>(null);
  const colorFor = (name: string, i: number) => {
    if (name === "Other") return PIE_OTHER;
    if (brandColors)
      return tokenColor(name) ?? PIE_COLORS[i % PIE_COLORS.length];
    return PIE_COLORS[i % PIE_COLORS.length];
  };

  return (
    <Card ref={cardRef} className="flex h-full flex-col">
      <div className="mb-4 flex items-center justify-between gap-3">
        {/* Title + share pill sit together on the left; the OSMO toggle stays
            pinned to the right. */}
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-xl font-semibold text-white">
            {title}
            {/* Appended only in the screenshot (onclone reveals it) when OSMO is
                excluded, so the exported title reads "Value by Asset (OSMO
                Excluded)". Uses inline display so it flows after the title. */}
            {exOsmo && !includeOsmo && (
              <span data-screenshot-only-inline className="hidden">
                {" "}
                (OSMO Excluded)
              </span>
            )}
          </h2>
          {shareText && (
            <ScreenshotButtons
              targetRef={cardRef}
              filename={shareFilename ?? "osmosis-treasury"}
              shareText={shareText}
            />
          )}
        </div>
        {exOsmo && (
          // Interactive toggle: hidden from screenshots (a live button reads
          // oddly as a static image). The screenshot-only "OSMO Excluded" label
          // is rendered under the pie instead (see below).
          <button
            type="button"
            onClick={() => setIncludeOsmo((v) => !v)}
            data-screenshot-hide
            className="shrink-0 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-white/20"
          >
            {includeOsmo ? "Exclude OSMO" : "Include OSMO"}
          </button>
        )}
      </div>
      {/* flex-1 + items-center vertically centers the chart+legend in the card,
          so a shorter pie sits centered against its taller grid-row sibling. */}
      <div className="flex flex-1 flex-col items-center gap-3 sm:flex-row sm:gap-5">
        <div className="h-52 w-52 shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="62%"
                outerRadius="100%"
                paddingAngle={1}
                stroke="none"
              >
                {slices.map((s, i) => (
                  <Cell key={s.name} fill={colorFor(s.name, i)} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => usd(v)}
                contentStyle={{
                  background: "#1F0A29",
                  border: "1px solid rgba(255,255,255,0.2)",
                  borderRadius: 8,
                }}
                // Recharts colors the item + label lines separately and defaults
                // them to a dark color that ignores contentStyle.color, so set
                // both explicitly to white or they render as unreadable black.
                itemStyle={{ color: "#fff" }}
                labelStyle={{ color: "#fff" }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
        {/* Grid rows so the name (flexible), amount, and value sit in fixed
            columns and never overlap. Amount column only present when any slice
            has one (the by-Asset pie). */}
        <div className="min-w-0 flex-1 space-y-1 text-sm">
          {slices.map((s, i) => (
            <div
              key={s.name}
              className={`grid items-start gap-x-3 ${
                slices.some((x) => x.amount != null)
                  ? "grid-cols-[1fr_auto_4rem]"
                  : "grid-cols-[1fr_4rem]"
              }`}
            >
              <span className="flex min-w-0 items-start gap-2">
                <span
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm"
                  style={{ background: colorFor(s.name, i) }}
                />
                <span className="min-w-0 break-words text-white">{s.name}</span>
              </span>
              {slices.some((x) => x.amount != null) && (
                <span className="justify-self-end tabular-nums text-osmo-300">
                  {s.amount != null ? amount(s.amount) : ""}
                </span>
              )}
              <span
                className="cursor-help justify-self-end tabular-nums text-osmo-100"
                title={usd(s.value)}
              >
                {usdCompact(s.value)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

export function TreasuryView() {
  const { data, isLoading, error } = useTreasuryData();

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-osmo-purple border-t-transparent"></div>
          <p className="text-white">Loading treasury snapshot…</p>
        </div>
      </div>
    );
  }

  if (error) {
    const pending =
      error instanceof Error &&
      error.message === "No treasury snapshot available yet";
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="rounded-lg bg-white/10 p-6 text-center">
          <p className="mb-2 text-lg font-semibold text-white">
            {pending ? "Treasury snapshot pending" : "Failed to load treasury"}
          </p>
          <p className="text-sm text-osmo-200">
            {pending
              ? "The first hourly snapshot has not been taken yet. Check back shortly."
              : error instanceof Error
                ? error.message
                : "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const asOf = new Date(data.timestamp).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });

  // Pie slice sets. By token: full vs OSMO-excluded from the treasury-wide asset
  // totals. By address: each holder's full value vs its non-OSMO value (summed
  // from that holder's own OSMO-flagged assets), so toggling OSMO off re-sizes
  // each slice to its non-OSMO holdings.
  const tokenFull: Slice[] = data.byAsset
    .filter((a) => !a.priceUnavailable && a.value > 0)
    .map((a) => ({ name: a.symbol, value: a.value, amount: a.amount }));
  const tokenExOsmo: Slice[] = data.byAsset
    .filter((a) => !a.priceUnavailable && a.value > 0 && !a.isOsmo)
    .map((a) => ({ name: a.symbol, value: a.value, amount: a.amount }));

  const addressFull: Slice[] = data.holders
    .filter((h) => h.totalValue > 0)
    .map((h) => ({ name: h.label, value: h.totalValue }));
  const addressExOsmo: Slice[] = data.holders
    .map((h) => ({
      name: h.label,
      value: h.assets
        .filter((a) => !a.isOsmo && !a.priceUnavailable)
        .reduce((s, a) => s + a.value, 0),
    }))
    .filter((s) => s.value > 0);

  return (
    <div className="space-y-6">
      {/* Headline: total + non-OSMO */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <div className="text-xs uppercase tracking-wide text-osmo-200">
            Total treasury value
          </div>
          <div className="mt-1 text-4xl font-bold text-white sm:text-5xl">
            {usd(data.totalValue)}
          </div>
          <div className="mt-1 text-sm text-osmo-300">
            Community pool plus {data.holders.length - 1} associated groups and
            liquidity positions.
          </div>
        </Card>
        <Card>
          <div className="text-xs uppercase tracking-wide text-osmo-200">
            Non-OSMO value
          </div>
          <div className="mt-1 text-4xl font-bold text-white sm:text-5xl">
            {usd(data.nonOsmoValue)}
          </div>
          <div className="mt-1 text-sm text-osmo-300">
            Excludes OSMO and OSMO liquid-staking tokens.
          </div>
        </Card>
      </div>

      {/* Value pies: by token and by address. Stack to one column below xl (not
          lg) so each pie keeps a full-width, wide legend sooner — otherwise the
          side-by-side legends get squeezed and symbols like PEPE wrap. */}
      <div className="grid gap-6 xl:grid-cols-2">
        <ValuePie
          title="Value by Asset"
          full={tokenFull}
          exOsmo={tokenExOsmo}
          brandColors
          shareText="Osmosis community treasury by asset"
          shareFilename="osmosis-treasury-by-asset"
        />
        <ValuePie
          title="Value by Address"
          full={addressFull}
          exOsmo={addressExOsmo}
        />
      </div>

      {/* Per-holder breakdown (all collapsed by default) */}
      <div>
        <h2 className="mb-3 text-xl font-semibold text-white">
          Holdings by Address
        </h2>
        <div className="space-y-3">
          {data.holders.map((holder) => (
            <HolderCard
              key={holder.address}
              holder={holder}
              defaultOpen={false}
            />
          ))}
        </div>
      </div>

      {/* Liquidity Positions: each type grouped sequentially (CL, then vaults /
          classic pools), each group already value-sorted by the engine. */}
      {(data.clPositions.length > 0 ||
        (data.vaultPositions?.length ?? 0) > 0) && (
        <div>
          <h2 className="mb-3 text-xl font-semibold text-white">
            Liquidity Positions
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {data.clPositions.map((pos) => (
              <ClCard key={`cl-${pos.positionId}`} pos={pos} />
            ))}
            {(data.vaultPositions ?? []).map((pos, i) => (
              <VaultCard
                key={`vault-${pos.holderLabel}-${pos.kind}-${pos.label}-${pos.poolRef ?? i}`}
                pos={pos}
              />
            ))}
          </div>
        </div>
      )}

      <p className="pb-4 text-center text-xs text-osmo-300">
        Holdings and prices as of {asOf}, refreshed hourly.
      </p>
    </div>
  );
}
