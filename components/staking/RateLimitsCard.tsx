"use client";

import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { InfoTooltip } from "../ui/InfoTooltip";
import { ScreenshotButtons } from "../ScreenshotButtons";
import {
  useRateLimits,
  type EnrichedPathUtilization,
} from "@/lib/hooks/useRateLimits";
import type { WindowUtilization } from "@/lib/rate-limits/snapshot";
import { formatNumber } from "@/lib/utils";

// How many of the most-utilized assets get a row by default; "Show all"
// expands to the full set.
const TOP_PATHS = 10;

// Utilization colour thresholds: yellow from 50%, amber from 70%, red from 90%,
// neutral purple below.
function utilizationColor(pct: number): string {
  return pct >= 90
    ? "#FF6B6B"
    : pct >= 70
      ? "#FFB74D"
      : pct >= 50
        ? "#FACC15"
        : "#7C4DFF";
}

// Quota window duration in the label form the limiter uses (86400 → "24h").
function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return days === 1 ? "24h" : `${days}d`;
  }
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  return `${seconds}s`;
}

// When a window resets: the UTC date and time, with the countdown in brackets
// (minutes under two hours, whole hours above). The contract resets windows
// lazily, so a past period_end shows as "due" (it clears on the next transfer).
function formatReset(periodEndNs: string): string {
  const endMs = Number(BigInt(periodEndNs) / 1_000_000n);
  const diff = endMs - Date.now();
  if (diff <= 0) return "due";
  const stamp = new Date(endMs).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const rel =
    diff < 2 * 3_600_000
      ? `${Math.max(1, Math.round(diff / 60_000))}m`
      : `${Math.round(diff / 3_600_000)}h`;
  return `${stamp} (${rel})`;
}

// Why a window has no utilization figure: its counters no longer bind.
function windowStatus(w: WindowUtilization): string {
  if (!w.windowActive) return "expired";
  if (w.sendPct === 0 && w.recvPct === 0) return "closed";
  return "—";
}

// Absolute remaining capacity in a window's binding direction, in BASE units
// (comparable across windows of the same denom without a price). Null when the
// window has no computable utilization.
function remainingBase(w: WindowUtilization): number | null {
  if (w.utilizationPct == null || !w.direction || !w.channelValue) return null;
  const chan = Number(w.channelValue);
  const dirPct = w.direction === "in" ? w.recvPct : w.sendPct;
  const inflow = Number(w.inflow);
  const outflow = Number(w.outflow);
  const used =
    w.direction === "in"
      ? Math.max(0, inflow - outflow)
      : Math.max(0, outflow - inflow);
  return Math.max(0, chan * (dirPct / 100) - used);
}

// Window label from the quota NAME (the limiter names quotas "…DAY…"/"…WEEK…"),
// falling back to the duration when the name carries no period word.
function windowLabel(w: WindowUtilization): string {
  const m = w.quotaName.match(/day|week|month|hour/i);
  if (m) return m[0].charAt(0).toUpperCase() + m[0].slice(1).toLowerCase();
  return formatDuration(w.durationSeconds);
}

// One asset's rate-limit summary: every (channel, window) pair for its denom.
// The headline is the BINDING window — the one with the least absolute
// capacity remaining, i.e. the first that would block a transfer — not simply
// the highest percentage (a small-cap Day window can have less headroom than a
// big-cap Week window at a higher %).
interface AssetGroup {
  denom: string;
  symbol: string;
  paths: EnrichedPathUtilization[];
  binding: {
    path: EnrichedPathUtilization;
    window: WindowUtilization;
    remaining: number;
  } | null;
}

// A utilization bar with its trailing "% · direction · window · resets" info
// and a hover popup carrying the window's capacity economics: utilization,
// channel value in the asset and in dollars, the in/out caps, and the
// remaining capacity in the binding direction. Values that can't be resolved
// (unknown exponent or price) show as an em-free dash, never a fake zero.
function UtilBar({
  w,
  pct,
  symbol,
  exponent,
  priceUsd,
}: {
  w: WindowUtilization;
  pct: number | null;
  symbol: string;
  exponent: number | null;
  priceUsd: number | null;
}) {
  const chanBase = w.channelValue ? Number(w.channelValue) : null;
  const chanDisp =
    chanBase != null && exponent != null
      ? chanBase / Math.pow(10, exponent)
      : null;
  const chanUsd =
    chanDisp != null && priceUsd != null ? chanDisp * priceUsd : null;
  let remainingDisp: number | null = null;
  if (chanBase != null && exponent != null && w.direction) {
    const dirPct = w.direction === "in" ? w.recvPct : w.sendPct;
    const inflow = Number(w.inflow);
    const outflow = Number(w.outflow);
    const usedBase =
      w.direction === "in"
        ? Math.max(0, inflow - outflow)
        : Math.max(0, outflow - inflow);
    remainingDisp =
      Math.max(0, chanBase * (dirPct / 100) - usedBase) /
      Math.pow(10, exponent);
  }

  return (
    <>
      {/* Binding direction, just before the bar. Fixed width so bars stay
          aligned when a row has no computable direction. */}
      <span
        className="inline-flex w-4 shrink-0 items-center justify-center self-stretch text-xs font-bold leading-none"
        title={
          w.direction
            ? w.direction === "in"
              ? "inbound"
              : "outbound"
            : undefined
        }
        aria-label={
          w.direction
            ? w.direction === "in"
              ? "inbound"
              : "outbound"
            : undefined
        }
        style={{
          color:
            w.direction === "in"
              ? "#81C784"
              : w.direction === "out"
                ? "#FF6B6B"
                : undefined,
        }}
      >
        {/* SVG rather than a text glyph: diagonal arrow CHARACTERS carry
            their ink in a corner of the em box (↗ top-right, ↙ bottom-left),
            so they never look vertically centered. The SVG is geometrically
            centered; out = up-right, in = the same path rotated 180°. */}
        {w.direction && (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={w.direction === "in" ? "rotate-180" : ""}
          >
            <path d="M7 17 17 7M8 7h9v9" />
          </svg>
        )}
      </span>
      <span className="group relative h-3 min-w-0 flex-1 overflow-visible rounded-full bg-white/10">
        <span className="block h-full overflow-hidden rounded-full">
          <span
            className="block h-full rounded-full"
            style={{
              width: `${Math.min(100, pct ?? 0)}%`,
              backgroundColor: utilizationColor(pct ?? 0),
            }}
          />
        </span>
        {/* Capacity popup, on bar hover. pointer-events-none so it never
            traps the cursor. */}
        <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-72 -translate-x-1/2 rounded-lg border border-white/20 bg-osmo-900 p-3 text-left text-xs font-normal leading-relaxed text-osmo-100 shadow-xl group-hover:block">
          <span className="block">
            Utilization:{" "}
            <span style={{ color: utilizationColor(pct ?? 0) }}>
              {pct == null ? windowStatus(w) : `${pct.toFixed(1)}%`}
            </span>
          </span>
          <span className="block">
            Channel amount:{" "}
            {chanDisp == null ? "—" : `${formatNumber(chanDisp)} ${symbol}`}
          </span>
          <span className="block">
            Channel value:{" "}
            {chanUsd == null ? "$—" : `$${formatNumber(chanUsd)}`}
          </span>
          <span className="block">
            Caps: in {w.recvPct}%
            {chanUsd != null &&
              ` ($${formatNumber((chanUsd * w.recvPct) / 100)})`}{" "}
            / out {w.sendPct}%
            {chanUsd != null &&
              ` ($${formatNumber((chanUsd * w.sendPct) / 100)})`}
          </span>
          <span className="block">
            Remaining{w.direction ? ` (${w.direction})` : ""}:{" "}
            {remainingDisp == null
              ? "—"
              : `${formatNumber(remainingDisp)} ${symbol}`}
          </span>
        </span>
      </span>
      {/* Period end (UTC) with the countdown in brackets, under the list's
          "Period End" header. The percentage lives in the bar length and the
          hover popup; the window name in the expanded rows. */}
      <span className="w-32 shrink-0 text-right text-xs tabular-nums text-osmo-300">
        {pct == null ? windowStatus(w) : formatReset(w.periodEnd)}
      </span>
    </>
  );
}

// IBC rate-limit utilization: how close each rate-limited asset is to its cap
// right now (max across all its channels and windows; click a row to swap the
// aggregate bar for the full per-channel/per-window breakdown), plus the
// max-utilization trend from the 15-minute monitor snapshots.
export function RateLimitsCard() {
  const { data, isLoading, isError } = useRateLimits();
  const cardRef = useRef<HTMLDivElement>(null);
  // Which asset rows are expanded to their per-channel/per-window breakdown.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Whether the list shows every rate-limited asset or just the top slice.
  const [showAll, setShowAll] = useState(false);

  const current = data?.current;
  // Group paths by denom: the headline row is per ASSET, the expansion shows
  // its channels and windows. The binding window (least absolute capacity
  // remaining) is resolved per group as it's built.
  const groups = new Map<string, AssetGroup>();
  for (const p of current?.paths ?? []) {
    const g = groups.get(p.denom) ?? {
      denom: p.denom,
      symbol: p.symbol,
      paths: [],
      binding: null,
    };
    g.paths.push(p);
    for (const w of p.windows) {
      const remaining = remainingBase(w);
      if (remaining == null) continue;
      if (g.binding == null || remaining < g.binding.remaining) {
        g.binding = { path: p, window: w, remaining };
      }
    }
    groups.set(p.denom, g);
  }
  // Tightest assets first (highest binding-window utilization), then the quiet
  // ones (no computable current-window utilization) alphabetically — so "show
  // all" has a stable, meaningful order.
  const headlinePct = (g: AssetGroup): number | null =>
    g.binding?.window.utilizationPct ?? null;
  const ranked = [...groups.values()].sort((a, b) => {
    const ap = headlinePct(a);
    const bp = headlinePct(b);
    if (ap != null && bp != null) return bp - ap;
    if (ap != null) return -1;
    if (bp != null) return 1;
    return a.symbol.localeCompare(b.symbol);
  });
  const top = showAll ? ranked : ranked.slice(0, TOP_PATHS);

  const toggle = (denom: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(denom)) next.delete(denom);
      else next.add(denom);
      return next;
    });

  return (
    <Card ref={cardRef} liftOnHover>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle as="h2">
            <span className="inline-flex items-center gap-1.5">
              IBC Rate Limits
              <InfoTooltip
                text="Osmosis caps how much of an asset can flow in or out over IBC within a time window (a percentage of the channel's value, enforced onchain by the rate-limiter contract). Utilization is the share of the binding cap consumed by net flow in the current window; at 100% further transfers in that direction are rejected until the window resets. Each row shows an asset's highest utilization across its channels and windows; click a row for the full breakdown, and hover a bar for capacity detail. Yellow marks 50%+, amber 70%+, red 90%+."
                ariaLabel="About IBC rate limits"
              />
              {current && (
                // Bottom-aligned against the title's baseline row, a size
                // below the explainer trigger.
                <span className="self-end pb-0.5 text-xs font-normal text-osmo-200">
                  as of{" "}
                  {new Date(current.timestamp).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                    timeZone: "UTC",
                  })}{" "}
                  UTC
                </span>
              )}
            </span>
          </CardTitle>
          <ScreenshotButtons
            targetRef={cardRef}
            filename="osmosis-ibc-rate-limits"
            shareText="Osmosis IBC rate-limit utilization"
            csvRows={() =>
              (current?.paths ?? []).flatMap((p) =>
                p.windows.map((w) => ({
                  symbol: p.symbol,
                  channel: p.channel,
                  denom: p.denom,
                  window: w.quotaName,
                  durationSeconds: w.durationSeconds,
                  sendCapPct: w.sendPct,
                  recvCapPct: w.recvPct,
                  utilizationPct: w.utilizationPct,
                  bindingDirection: w.direction,
                  windowActive: w.windowActive,
                }))
              )
            }
            csvFilename="osmosis-ibc-rate-limits"
          />
        </div>
      </CardHeader>
      <CardContent>
        {isError ? (
          <div className="flex min-h-[120px] items-center justify-center text-osmo-200">
            Failed to load rate-limit data. Please try again shortly.
          </div>
        ) : isLoading || !current ? (
          <div className="flex min-h-[120px] items-center justify-center text-osmo-200">
            Loading rate limits…
          </div>
        ) : (
          <>
            {/* Column headers, mirroring the row layout (label · arrow · bar ·
                period end). */}
            <div className="mb-1 flex items-center gap-3 border-b border-white/10 px-1 pb-1 text-xs font-medium text-osmo-300">
              <span className="w-36 shrink-0">Asset</span>
              <span className="w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1">Utilization</span>
              <span className="w-32 shrink-0 text-right">Period End (UTC)</span>
            </div>
            {/* One row per asset. Collapsed: the aggregate bar (its binding
                window). Expanded: the aggregate hides and each (channel,
                window) renders as its own bar in the same format. */}
            <div className="space-y-1">
              {top.map((g) => {
                const isOpen = expanded.has(g.denom);
                // The binding window is precomputed on the group (least
                // absolute capacity remaining); quiet assets fall back to
                // their first window so they still have a bar row and popup.
                const bindingPath = g.binding?.path ?? g.paths[0] ?? null;
                const bindingWindow =
                  g.binding?.window ?? g.paths[0]?.windows[0] ?? null;
                return (
                  <div key={g.denom}>
                    <button
                      type="button"
                      onClick={() => toggle(g.denom)}
                      aria-expanded={isOpen}
                      className="flex w-full items-center gap-3 rounded px-1 py-1 text-left transition-colors hover:bg-white/5"
                    >
                      <span className="flex w-36 shrink-0 items-center text-sm text-osmo-100">
                        <span
                          className="mr-1 inline-block w-3 shrink-0 text-osmo-300"
                          aria-hidden
                        >
                          {isOpen ? "▾" : "▸"}
                        </span>
                        {bindingPath?.logoUri && (
                          // eslint-disable-next-line @next/next/no-img-element -- remote assetlist logos; next/image would need per-host config
                          <img
                            src={bindingPath.logoUri}
                            alt=""
                            loading="lazy"
                            className="mr-1.5 h-4 w-4 shrink-0 rounded-full"
                          />
                        )}
                        {/* Hovering the symbol reveals the full denom. */}
                        <span className="truncate" title={g.denom}>
                          {g.symbol}
                        </span>
                      </span>
                      {!isOpen && bindingWindow && bindingPath ? (
                        <UtilBar
                          w={bindingWindow}
                          pct={bindingWindow.utilizationPct}
                          symbol={g.symbol}
                          exponent={bindingPath.exponent}
                          priceUsd={bindingPath.priceUsd}
                        />
                      ) : (
                        // Expanded: the aggregate bar hides and the header row
                        // is just the toggle; the window rows below carry all
                        // the detail.
                        <span className="flex-1" />
                      )}
                    </button>
                    {isOpen &&
                      g.paths.flatMap((p) =>
                        p.windows.map((w) => (
                          <div
                            key={`${p.channel}|${w.quotaName}`}
                            className="flex w-full items-center gap-3 px-1 py-1 pl-10"
                          >
                            {/* Every live limit is "any"-channel, so the
                                channel id only appears if a channel-scoped
                                limit ever ships; rows are labelled by their
                                window instead. */}
                            <span className="w-[6.75rem] shrink-0 truncate text-xs text-osmo-200">
                              {p.channel === "any"
                                ? windowLabel(w)
                                : `${p.channel} · ${windowLabel(w)}`}
                            </span>
                            <UtilBar
                              w={w}
                              pct={w.utilizationPct}
                              symbol={g.symbol}
                              exponent={p.exponent}
                              priceUsd={p.priceUsd}
                            />
                          </div>
                        ))
                      )}
                  </div>
                );
              })}
            </div>
            {ranked.length > TOP_PATHS && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="mt-3 w-full rounded-lg border border-white/15 bg-white/5 py-2 text-sm font-medium text-osmo-100 transition-colors hover:bg-white/15 hover:text-white"
              >
                {showAll
                  ? "Show fewer"
                  : `Show all ${ranked.length} rate-limited assets`}
              </button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
