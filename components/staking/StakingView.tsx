"use client";

import { Fragment, useState, useRef, useEffect, type ReactNode } from "react";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Customized,
  Cell,
  Treemap,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { useValidatorData } from "@/lib/hooks/useValidatorData";
import { useUndelegations } from "@/lib/hooks/useUndelegations";
import { useOsmosisMetrics } from "@/lib/hooks/useOsmosisMetrics";
import { useHistoricalData } from "@/lib/hooks/useHistoricalData";
import type { HistoricalRecord } from "@/lib/historical-file";
import type { ValidatorInfo } from "@/lib/validators";
import {
  formatNumber,
  formatNumberWithCommas,
  formatPercentage,
  formatChartDate,
  makeMonthlyTicks,
} from "@/lib/utils";
import { TimeRange, filterDataByTimeRange } from "../TimeRangeSelector";
import { ChartHeader } from "../charts/ChartHeader";
import { ScreenshotButtons } from "../ScreenshotButtons";
import { InfoTooltip } from "../ui/InfoTooltip";
import { StakingRatioChart } from "../charts/StakingRatioChart";
import {
  NETWORK_EVENTS,
  EVENT_COLOR,
  type NetworkEvent,
} from "@/config/network-events";

// Shorten a bech32 address for table display, e.g. "osmo1abcd…wxyz".
function shortenAddress(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 10)}…${addr.slice(-4)}` : addr;
}

// Time-range selector for the coefficient/block-rate charts — same look as the
// shared TimeRangeSelector but WITHOUT the 7d option (these metrics barely move
// day-to-day, so a 7d window isn't useful). Renders inline with the share buttons.
function MetricRangeSelector({
  selectedRange,
  onRangeChange,
}: {
  selectedRange: TimeRange;
  onRangeChange: (r: TimeRange) => void;
}) {
  const ranges: { value: TimeRange; label: string }[] = [
    { value: "all", label: "All" },
    { value: "1y", label: "1Y" },
    { value: "90d", label: "90D" },
    { value: "30d", label: "30D" },
  ];
  return (
    <div
      className="flex gap-1 rounded-lg bg-white/5 p-1"
      data-screenshot-compact
    >
      {ranges.map((r) => (
        <button
          key={r.value}
          type="button"
          onClick={() => onRangeChange(r.value)}
          className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
            selectedRange === r.value
              ? "bg-osmo-purple text-white"
              : "text-osmo-200 hover:text-white"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

// Validator-leaderboard column keys. "validator" is always shown (not toggleable).
// The three most recent additions (address / lastSlash / selfBond) default hidden.
type ValidatorColKey =
  | "votingPower"
  | "cumulative"
  | "commission"
  | "uptime"
  | "longRunUptime"
  | "governance"
  | "slashed"
  | "address"
  | "lastSlash"
  | "selfBond";
const DEFAULT_VISIBLE_COLS: ValidatorColKey[] = [
  "votingPower",
  "cumulative",
  "commission",
  "longRunUptime", // labelled "Uptime"; the trailing-90-day figure
  "governance",
];

// A simple single-series line chart over the daily history, for the metrics
// backfilled from SmartStake (Nakamoto, Gini, block rate). Points missing the
// value are dropped (connectNulls keeps the line continuous across gaps). `unit`
// is appended in the tooltip; `decimals` controls y-axis / tooltip precision.
function MetricLineChart({
  title,
  explainer,
  data,
  dataKey,
  color,
  unit = "",
  decimals = 0,
  events,
  defaultRange = "all",
}: {
  title: string;
  explainer?: string;
  data: HistoricalRecord[];
  dataKey: "nakamotoCoefficient" | "giniCoefficient" | "blockRate";
  color: string;
  unit?: string;
  decimals?: number;
  /** Optional event markers (e.g. chain upgrades) drawn as vertical dotted
   *  ReferenceLines. Each is snapped to the nearest plotted day. */
  events?: NetworkEvent[];
  /** Initial selected time range for this chart. */
  defaultRange?: TimeRange;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>(defaultRange);
  const filtered = filterDataByTimeRange(data, timeRange).filter(
    (r) => r[dataKey] != null
  );
  const chartData = filtered.map((r) => ({
    date: formatChartDate(r.timestamp, timeRange),
    timestamp: r.timestamp,
    value: r[dataKey] as number,
  }));

  // Snap each event to the nearest plotted day by absolute time distance and keep
  // its INDEX into chartData. We render the vertical markers via <Customized>
  // positioned by index (see EventLine) rather than a category ReferenceLine:
  // at the wide "all"/"1y" ranges many days share one month label, and a category
  // ReferenceLine keyed on that shared label resolves unreliably. Index → pixel is
  // exact. Events whose nearest plotted day is >~4 days away (range doesn't cover
  // them) are dropped so we don't pin a marker to a chart edge.
  const eventMarkers = (events ?? [])
    .map((ev) => {
      const evTime = new Date(ev.date + "T00:00:00Z").getTime();
      let bestIndex = -1;
      let bestDist = Infinity;
      for (let i = 0; i < chartData.length; i++) {
        const dist = Math.abs(
          new Date(chartData[i].timestamp).getTime() - evTime
        );
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }
      return bestIndex >= 0
        ? { ...ev, index: bestIndex, dist: bestDist }
        : null;
    })
    .filter(
      (m): m is NetworkEvent & { index: number; dist: number } =>
        m != null && m.dist <= 4 * 86_400_000
    );

  // Fit the Y-axis tightly to the visible data with evenly-spaced ticks, and PIN
  // the domain to those tick bounds. Without a pinned domain Recharts picks its
  // own (often much wider) bounds, so a tight series like Nakamoto (all 6-7) ends
  // up with its ticks bunched at the bottom and ~⅔ of the plot empty above. Integer
  // metrics (decimals===0, e.g. Nakamoto) step by whole numbers; fractional metrics
  // (Gini, block rate) snap to a "nice" step so labels are round and non-duplicated.
  const values = chartData.map((d) => d.value);
  const { yDomain, yTicks } = (() => {
    if (!values.length)
      return {
        yDomain: undefined as [number, number] | undefined,
        yTicks: undefined as number[] | undefined,
      };
    const dataMin = Math.min(...values);
    const dataMax = Math.max(...values);
    if (decimals === 0) {
      // Integer axis: one tick per whole number (stepping up if the span is wide),
      // domain pinned to the integer bounds.
      const lo = Math.floor(dataMin);
      const hi = Math.max(lo + 1, Math.ceil(dataMax)); // ensure span > 0
      const step = Math.max(1, Math.ceil((hi - lo) / 8));
      const t: number[] = [];
      for (let v = lo; v <= hi; v += step) t.push(v);
      if (t[t.length - 1] !== hi) t.push(hi);
      return { yDomain: [lo, hi] as [number, number], yTicks: t };
    }
    // Fractional axis: snap to a nice step (1/2/5 ×10ⁿ) giving ~5 intervals, pin
    // the domain to the snapped bounds so the line fills the plot.
    const span = dataMax - dataMin;
    const raw = (span || Math.abs(dataMax) || 1) / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
    const lo = Math.floor(dataMin / step) * step;
    const hi = Math.ceil(dataMax / step) * step;
    const t: number[] = [];
    for (let v = lo; v <= hi + step / 2; v += step)
      t.push(Number(v.toFixed(decimals)));
    return { yDomain: [lo, hi] as [number, number], yTicks: t };
  })();

  return (
    <Card ref={cardRef} liftOnHover>
      <CardHeader>
        <ChartHeader
          title={title}
          titleExplainer={explainer}
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          hideTimeRange
          extraControls={
            <MetricRangeSelector
              selectedRange={timeRange}
              onRangeChange={setTimeRange}
            />
          }
          cardRef={cardRef}
          screenshotFilename={`osmo-${dataKey}`}
          shareText={`Osmosis ${title.toLowerCase()} over time`}
          csvRows={() =>
            data
              .filter((r) => r[dataKey] != null)
              .map((r) => ({ date: r.timestamp, value: r[dataKey] as number }))
          }
        />
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex min-h-[320px] items-center justify-center text-osmo-200">
            No data available for this range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={chartData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.1)"
              />
              <XAxis
                dataKey="date"
                stroke="#fff"
                tick={{ fill: "#e0d5f5" }}
                ticks={makeMonthlyTicks(
                  chartData.map((d) => d.date),
                  chartData.map((d) => d.timestamp),
                  timeRange
                )}
                angle={-45}
                textAnchor="end"
                height={70}
              />
              <YAxis
                stroke="#fff"
                tick={{ fill: "#e0d5f5" }}
                domain={yDomain ?? ["auto", "auto"]}
                allowDecimals={decimals > 0}
                ticks={yTicks}
                tickFormatter={(v) => `${v.toFixed(decimals)}${unit}`}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "rgba(31, 10, 41, 0.95)",
                  backdropFilter: "blur(12px)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: "8px",
                }}
                labelStyle={{ color: "#fff" }}
                itemStyle={{ color: "#fff" }}
                formatter={(value: number) => [
                  `${value.toFixed(decimals)}${unit}`,
                  title,
                ]}
              />
              {eventMarkers.length > 0 && (
                <Customized
                  component={(props: CustomizedAxisProps) => (
                    <EventLines
                      markers={eventMarkers}
                      count={chartData.length}
                      axis={props}
                    />
                  )}
                />
              )}
              <Line
                type="monotone"
                dataKey="value"
                stroke={color}
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}

// Recharts-passed props we read off the Customized child (only the bits we use).
interface CustomizedAxisProps {
  offset?: { left: number; top: number; width: number; height: number };
}

// Vertical event markers on a time-series line chart, positioned by DATA INDEX
// via <Customized> pure geometry (not a category ReferenceLine, which resolves
// unreliably when many days share one month label on the wide ranges). Point i of
// `count` sits at i/(count-1) across the plot width — matching how the category
// axis spaces points. Labels stagger (alternate up/down) so adjacent events don't
// overprint, and are clamped inside the plot so edge events stay readable.
function EventLines({
  markers,
  count,
  axis,
}: {
  markers: { index: number; label: string; kind: NetworkEvent["kind"] }[];
  count: number;
  axis: CustomizedAxisProps;
}) {
  const off = axis.offset;
  if (!off || count <= 1) return null;
  return (
    <g pointerEvents="none">
      {markers.map((m, i) => {
        const frac = count > 1 ? m.index / (count - 1) : 0;
        const x = off.left + frac * off.width;
        const color = EVENT_COLOR[m.kind];
        // Stagger labels across 3 rows so tight clusters (e.g. the v21-v25 run in
        // early 2024, close together on the wide ranges) don't overprint.
        const yLabel = off.top + 12 + (i % 3) * 14;
        // Anchor the label so it stays inside the plot at either edge.
        const nearRight = frac > 0.85;
        const anchor = nearRight ? "end" : "start";
        const tx = nearRight ? x - 4 : x + 4;
        return (
          <g key={`${m.label}-${m.index}`}>
            <line
              x1={x}
              x2={x}
              y1={off.top}
              y2={off.top + off.height}
              stroke={color}
              strokeWidth={1.5}
              strokeDasharray="4 4"
            />
            <text
              x={tx}
              y={yLabel}
              textAnchor={anchor}
              fill={color}
              fontSize={11}
            >
              {m.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// Vertical "Today" divider on the combined undelegation BAR chart, positioned by
// bar-band index via <Customized>. Bar i of `count` occupies the band from
// i/count to (i+1)/count of the plot width; the line sits at the CENTRE of today's
// bar (history bar `index`) — at (index+0.5)/count. A category ReferenceLine on the
// mixed history+forecast label axis resolves unreliably, so we draw it geometrically.
function UndelegBoundaryLine({
  index,
  count,
  axis,
}: {
  index: number;
  count: number;
  axis: CustomizedAxisProps;
}) {
  const off = axis.offset;
  if (!off || count <= 0 || index < 0) return null;
  const x = off.left + ((index + 0.5) / count) * off.width;
  return (
    <g pointerEvents="none">
      <line
        x1={x}
        x2={x}
        y1={off.top}
        y2={off.top + off.height}
        stroke="#FFB74D"
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
      <text
        x={x - 4}
        y={off.top + 12}
        textAnchor="end"
        fill="#FFB74D"
        fontSize={11}
      >
        Today
      </text>
    </g>
  );
}

// Custom Treemap tile for the voting-power treemap. Recharts passes the layout box
// (x/y/width/height) plus our payload fields (name, share, rank, total,
// operatorAddress). Fill is a purple ramp by rank (largest = darkest); the label
// only renders when the tile is big enough to hold it; clicking opens Mintscan.
function TreemapCell(props: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  share?: number;
  rank?: number;
  operatorAddress?: string;
  zone?: "veto" | "control" | "normal";
}) {
  const {
    x = 0,
    y = 0,
    width = 0,
    height = 0,
    name,
    share,
    rank,
    operatorAddress,
    zone = "normal",
  } = props;
  if (width <= 0 || height <= 0) return null;
  // Tile fill = a vertical gradient in the zone's colour (veto ⅓ red, control ⅔
  // orange, else the page's Osmosis purple). Gradients defined once on the first
  // tile; each references its zone's id.
  const gradId =
    zone === "veto" ? "tmVeto" : zone === "control" ? "tmControl" : "tmNormal";
  const showName = width > 54 && height > 22;
  const showPct = showName && height > 38;
  const onClick = () => {
    if (operatorAddress)
      window.open(
        `https://www.mintscan.io/osmosis/validators/${operatorAddress}`,
        "_blank",
        "noopener,noreferrer"
      );
  };
  return (
    <g
      style={{ cursor: operatorAddress ? "pointer" : "default" }}
      onClick={onClick}
    >
      {rank === 0 && (
        <defs>
          {/* Vertical sheen (light top → deep bottom) per zone, echoing the Staking
              Ratio area gradient. Muted, desaturated tints so they read as a soft
              accent against the dark page rather than a harsh block. Red = veto (⅓),
              amber = control (⅔), purple = rest. */}
          <linearGradient id="tmVeto" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#C97a86" />
            <stop offset="100%" stopColor="#9E5560" />
          </linearGradient>
          <linearGradient id="tmControl" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#C9A277" />
            <stop offset="100%" stopColor="#9E7A4E" />
          </linearGradient>
          <linearGradient id="tmNormal" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8570C4" />
            <stop offset="100%" stopColor="#5E4C9E" />
          </linearGradient>
        </defs>
      )}
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        fill={`url(#${gradId})`}
        stroke="#1f0a29"
        strokeWidth={2}
      />
      {/* Labels: plain white, inheriting the chart SVG font (no explicit
          fontFamily — setting it forced the SVG default serif). Non-interactive so
          the whole tile stays clickable. Truncated to what the width can hold. */}
      {showName && (
        <text
          x={x + 6}
          y={y + 15}
          fill="#ffffff"
          stroke="none"
          fontSize={11}
          pointerEvents="none"
          style={{ fill: "#ffffff" }}
        >
          {(name ?? "").slice(0, Math.max(2, Math.floor((width - 10) / 6.5)))}
        </text>
      )}
      {showPct && (
        <text
          x={x + 6}
          y={y + 29}
          fill="#ffffff"
          stroke="none"
          fontSize={10}
          pointerEvents="none"
          style={{ fill: "#ffffff", opacity: 0.85 }}
        >
          {share != null ? `${share.toFixed(2)}%` : ""}
        </text>
      )}
    </g>
  );
}

export function StakingView() {
  const { data, isLoading, isError } = useValidatorData();
  const { data: undelegations, isLoading: undelegationsLoading } =
    useUndelegations();
  const { data: metrics } = useOsmosisMetrics();
  const { data: historicalData = [] } = useHistoricalData();
  const [leaderboardExpanded, setLeaderboardExpanded] = useState(false);
  // Pending Undelegations has three INDEPENDENT toggles that can each be on or
  // off: Forecast (forward 14-day completion schedule), History (imported daily
  // total-unbonding series, scoped by undelegRange), and Details (largest
  // individual unbonding entries, as a table). Forecast + History share one
  // continuous daily column chart split by a "Today" line; Details renders below.
  const [showHistory, setShowHistory] = useState(true);
  const [showForecast, setShowForecast] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [undelegRange, setUndelegRange] = useState<TimeRange>("30d");
  // Details table pagination (10 rows/page).
  const [detailsPage, setDetailsPage] = useState(0);
  // Which leaderboard columns are visible (Validator + # are always shown).
  const [visibleCols, setVisibleCols] = useState<Set<ValidatorColKey>>(
    () => new Set(DEFAULT_VISIBLE_COLS)
  );
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const colMenuRef = useRef<HTMLDivElement>(null);
  // Close the columns menu on outside click / Escape.
  useEffect(() => {
    if (!colMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        colMenuRef.current &&
        !colMenuRef.current.contains(e.target as Node)
      ) {
        setColMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setColMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [colMenuOpen]);
  // Card refs for the share / copy / CSV buttons on the cards that don't use
  // the shared ChartHeader (leaderboard table + treemap).
  const validatorsRef = useRef<HTMLDivElement>(null);
  const treemapRef = useRef<HTMLDivElement>(null);
  const undelegationsRef = useRef<HTMLDivElement>(null);

  if (isError) {
    return (
      <Card>
        <CardContent>
          <div className="flex min-h-[200px] items-center justify-center text-osmo-200">
            Failed to load validator data. Please try again shortly.
          </div>
        </CardContent>
      </Card>
    );
  }

  // Full validator set (stake-desc) with running cumulative share. Feeds the
  // consensus-boundary indices, the treemap tiles, and the treemap CSV export.
  const validators = data?.validators ?? [];
  let cumulative = 0;
  const chartData = validators.map((v) => {
    cumulative += v.votingPowerShare * 100;
    return {
      moniker: v.moniker,
      operatorAddress: v.operatorAddress, // for the Mintscan link on tile-click
      share: v.votingPowerShare * 100,
      cumulative,
    };
  });
  // Consensus boundaries: the FIRST validator at which running cumulative stake
  // exceeds 1/3 (can veto/halt — this count IS the Nakamoto coefficient) and 2/3
  // (controls consensus). We draw a dotted line UNDER that validator's bar (at
  // the band's bottom edge), so "everyone at or above the line collectively
  // holds that share". Exact thirds with strict >, matching nakamotoCoefficient
  // in lib/validators.ts — a rounded 33.4 cutoff could disagree with the KPI by
  // one validator when the crossing lands between 33.33% and 33.4%.
  const boundaryIndex = (threshold: number): number =>
    chartData.findIndex((d) => d.cumulative > threshold);
  const vetoIdx = boundaryIndex(100 / 3); // ⅓
  const controlIdx = boundaryIndex(200 / 3); // ⅔

  // Treemap view of the same distribution: tile area = voting-power share, for the
  // FULL validator set individually (no grouping). Recharts Treemap keys on `size`;
  // we carry name/share/operatorAddress for the tooltip and click-through. `zone`
  // tints each tile by where it sits relative to the consensus thresholds: the
  // validators that together make up the first ⅓ (veto) are red, those completing
  // the next third up to ⅔ (control) are orange, the rest neutral purple. So the
  // colour blocks show how few validators hold veto / control power.
  const treemapData = chartData.map((d, i) => ({
    name: d.moniker,
    size: d.share,
    share: d.share,
    operatorAddress: d.operatorAddress,
    rank: i,
    total: chartData.length,
    zone:
      vetoIdx >= 0 && i <= vetoIdx
        ? "veto"
        : controlIdx >= 0 && i <= controlIdx
          ? "control"
          : "normal",
  }));

  // Default leaderboard length: the control-threshold validator count (controlIdx
  // + 1) rounded UP to the next multiple of 5, plus one more 5 of headroom — so a
  // count of 21-25 shows 30, 26-30 shows 35. Keeps the default focused on the
  // consensus-relevant set; "Show all" reveals the full list.
  const controlCount = controlIdx >= 0 ? controlIdx + 1 : 0;
  const defaultRows = controlCount
    ? Math.ceil(controlCount / 5) * 5 + 5
    : (data?.validators.length ?? 0);
  const allValidators = data?.validators ?? [];
  const visibleValidators = leaderboardExpanded
    ? allValidators
    : allValidators.slice(0, defaultRows);
  // Running cumulative voting-power share (%) at each validator, for the
  // leaderboard's cumulative column. allValidators is stake-desc.
  const cumulativeByOperator = new Map<string, number>();
  {
    let running = 0;
    for (const v of allValidators) {
      running += v.votingPowerShare * 100;
      cumulativeByOperator.set(v.operatorAddress, running);
    }
  }
  // Quartile colouring: cells at or below p25 are amber (worst quarter), at or
  // above p75 emerald (best quarter), the middle two quartiles neutral. Recent and
  // long-run uptime each get their OWN quartiles (a validator can be top-quarter on
  // one and bottom on the other), so we build an independent coloriser per series.
  const quantile = (arr: number[], q: number): number | null => {
    if (arr.length === 0) return null;
    const pos = (arr.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  };
  const makeQuartileColorClass = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const p25 = quantile(sorted, 0.25);
    const p75 = quantile(sorted, 0.75);
    return (v: number | null): string => {
      if (v == null || p25 == null || p75 == null) return "text-osmo-100";
      if (v <= p25) return "text-amber-300";
      if (v >= p75) return "text-emerald-300";
      return "text-osmo-100";
    };
  };
  const uptimeColorClass = makeQuartileColorClass(
    allValidators.map((v) => v.uptime).filter((u): u is number => u != null)
  );
  const longRunUptimeColorClass = makeQuartileColorClass(
    allValidators
      .map((v) => v.longRunUptime)
      .filter((u): u is number => u != null)
  );
  // Governance metric: the self-computed last-90-day participation (proposals
  // voted on out of those decided in the window, indexed daily from onchain
  // votes) once the index has run; SmartStake's static last-10 import as the
  // fallback before that. A null value in self-computed mode means the
  // validator's voting account is unidentified (see config/gov-voter-overrides),
  // shown as "—" rather than a wrong 0.
  const hasSelfGov = allValidators.some((v) => v.govRecentWindow != null);
  const govWindowN = hasSelfGov
    ? Math.max(...allValidators.map((v) => v.govRecentWindow ?? 0))
    : 10;
  const govValue = (v: ValidatorInfo): number | null =>
    hasSelfGov ? v.govVotedRecent : v.govVotesLast10;
  // Governance colour: hard red at 0 (voted on none of the window), amber for low
  // participation, neutral above. No green top-quartile (unlike uptime) — only low
  // participation is flagged. The amber cutoff is the STRICTER of: the bottom-quartile
  // vote count across the set, OR 25% of the sample max — i.e. the
  // HIGHER of the two, so a validator must clear both bars to avoid amber.
  const govVotes = allValidators
    .map(govValue)
    .filter((n): n is number => n != null)
    .sort((a, b) => a - b);
  const govBottomQuartile =
    govVotes.length > 0
      ? govVotes[Math.floor((govVotes.length - 1) * 0.25)]
      : 0;
  const govMax = govVotes.length > 0 ? govVotes[govVotes.length - 1] : 0;
  const govAmberCutoff = Math.max(govBottomQuartile, govMax * 0.25);
  const govColorClass = (n: number | null): string =>
    n == null
      ? "text-osmo-100"
      : n === 0
        ? "text-[#E57373]"
        : n <= govAmberCutoff
          ? "text-amber-300"
          : "text-osmo-100";
  // Commission colour: amber over 10%, red over 25%, neutral otherwise (matches the
  // amber/red text treatment used elsewhere; replaces the old "(!)" marker).
  const commissionColorClass = (rate: number): string =>
    rate > 0.25
      ? "text-[#E57373]"
      : rate > 0.1
        ? "text-amber-300"
        : "text-osmo-100";

  // Column-driven leaderboard. Each column renders its own cell; the header + body
  // iterate the VISIBLE columns so the show/hide menu just toggles set membership.
  // "Validator" (+ the rank #) are always shown and not in this toggle list.
  const fmtSlashDate = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "—";
  const valColumns: {
    key: ValidatorColKey;
    label: string;
    subLabel?: string;
    /** Optional `?` explainer shown beside the column header. */
    info?: string;
    align: "left" | "right";
    render: (v: ValidatorInfo, i: number) => ReactNode;
  }[] = [
    {
      key: "address",
      label: "Address",
      align: "left",
      render: (v) => (
        <a
          href={`https://www.mintscan.io/osmosis/validators/${v.operatorAddress}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-osmo-100 underline-offset-2 hover:text-white hover:underline"
          title={v.operatorAddress}
        >
          {v.operatorAddress}
        </a>
      ),
    },
    {
      key: "selfBond",
      label: "Self-bond",
      info: "The share of this validator's voting power that is its own self-delegated stake. A higher self-bond aligns the validator's own capital with its performance.",
      align: "right",
      render: (v) =>
        v.selfBondPercentage == null
          ? "—"
          : formatPercentage(v.selfBondPercentage, 1),
    },
    {
      key: "votingPower",
      label: "Voting power",
      align: "right",
      render: (v) => formatPercentage(v.votingPowerShare * 100, 2),
    },
    {
      key: "cumulative",
      label: "Cumulative voting power",
      align: "right",
      render: (v) =>
        formatPercentage(cumulativeByOperator.get(v.operatorAddress) ?? 0, 2),
    },
    {
      key: "commission",
      label: "Commission",
      info: "The fee the validator takes from its delegators' staking rewards. Amber marks a rate above 10%, red above 25%.",
      align: "right",
      render: (v) => (
        <span className={commissionColorClass(v.commission)}>
          {formatPercentage(v.commission * 100, 0)}
        </span>
      ),
    },
    {
      key: "longRunUptime",
      label: "Uptime",
      subLabel: "trailing 90 days",
      info: "Share of blocks the validator signed over the trailing 90 days. Amber marks the bottom quartile of the set, green the top quartile.",
      align: "right",
      render: (v) => (
        <span className={longRunUptimeColorClass(v.longRunUptime)}>
          {v.longRunUptime == null ? "—" : formatPercentage(v.longRunUptime, 2)}
        </span>
      ),
    },
    {
      key: "uptime",
      label: "Recent uptime",
      subLabel: "~80k blocks",
      info: "Share of blocks signed over the current slashing window (the most recent ~80,000 blocks, roughly 24 hours at current block times), read live from the chain. Amber marks the bottom quartile of the set, green the top quartile.",
      align: "right",
      render: (v) => (
        <span className={uptimeColorClass(v.uptime)}>
          {v.uptime == null ? "—" : formatPercentage(v.uptime * 100, 2)}
        </span>
      ),
    },
    {
      key: "governance",
      label: "Governance Participation",
      subLabel: hasSelfGov
        ? `of ${govWindowN} proposals (90 days)`
        : "last 10 proposals",
      info: hasSelfGov
        ? `Number of the ${govWindowN} governance proposals decided in the last 90 days the validator voted on, counted from its onchain votes. A dash means the validator's voting account isn't identifiable onchain.`
        : "Number of the last 10 governance proposals the validator voted on.",
      align: "right",
      // Self-computed 90-day participation (govVotedRecent) once indexed;
      // SmartStake's last-10 import (govVotesLast10) as the fallback.
      render: (v) => (
        <span className={govColorClass(govValue(v))}>
          {govValue(v) == null ? "—" : govValue(v)}
        </span>
      ),
    },
    {
      key: "slashed",
      label: "Slash Events",
      info: "Number of times the validator has been slashed over its history. On Osmosis, extended downtime only jails the validator (no stake is burned), while double-signing burns 5% of the validator's and its delegators' staked OSMO.",
      align: "right",
      render: (v) =>
        v.timesSlashed == null ? (
          <span className="text-osmo-300">—</span>
        ) : v.timesSlashed > 0 ? (
          <span className="text-amber-300">{v.timesSlashed}</span>
        ) : (
          <span className="text-osmo-300">0</span>
        ),
    },
    {
      key: "lastSlash",
      label: "Last Slash Event",
      info: "Date of the validator's most recent slashing event, or a dash if it has never been slashed.",
      align: "right",
      render: (v) => (
        <span
          className={v.latestSlashedTime ? "text-osmo-100" : "text-osmo-300"}
        >
          {fmtSlashDate(v.latestSlashedTime)}
        </span>
      ),
    },
  ];
  const shownColumns = valColumns.filter((c) => visibleCols.has(c.key));

  // Forecast: the next 14 days STARTING TOMORROW. Today is owned by the History
  // series (its full completed amount); today's live forecast bucket only holds
  // what's LEFT to complete today (low, since the day is nearly over), so
  // including it would draw a misleading dip and double the today column. A bar
  // per calendar day (even zero-completion days) keeps the axis continuous.
  const unbondingData = (() => {
    if (!undelegations) return [];
    const byDay = new Map(undelegations.days.map((d) => [d.date, d.amount]));
    const out: { date: string; label: string; amount: number }[] = [];
    const start = new Date();
    for (let i = 1; i <= 14; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      out.push({
        date: iso,
        // timeZone UTC so the label always names the same day as the `iso`
        // bucket key (viewer-local rendering shifted it a day west of UTC).
        label: d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        }),
        amount: byDay.get(iso) ?? 0,
      });
    }
    return out;
  })();

  // Historical per-completion-day unbonding series (UndelegationDay: SmartStake
  // backfill + cron, keyed by completion day). SAME measure as the forecast
  // (amount COMPLETING that day), so the two join seamlessly. Take only days up to
  // today for the History portion (the forward tail is what Forecast shows live),
  // then scope by the range selector. Days without data are simply absent.
  const todayIso = new Date().toISOString().slice(0, 10);
  const undelegHistory = filterDataByTimeRange(
    (undelegations?.history ?? [])
      .filter((d) => d.date.slice(0, 10) <= todayIso)
      .map((d) => ({ timestamp: d.date, amount: d.amountCompleting })),
    undelegRange
  ).map((d) => ({
    date: formatChartDate(d.timestamp, undelegRange),
    timestamp: d.timestamp,
    amount: d.amount,
  }));
  // Combined daily column series: History (per-day completing, past → today) then
  // Forecast (per-day completing, next 14d) on one continuous completion-day axis,
  // split by the "Today" line. Same measure throughout, and no day is ever both, so
  // it's ONE `amount` series (a single full-tick-width bar per day) with a per-day
  // `kind` driving the colour — not two half-width grouped bars with a 0 in each.
  const undelegChartData: {
    label: string;
    amount: number;
    // "history" = a past day (completed); "today" = the current day (releasing
    // now); "forecast" = a future day (still unbonding). Drives colour + tooltip.
    kind: "history" | "today" | "forecast";
  }[] = [
    ...(showHistory
      ? undelegHistory.map((d) => ({
          label: d.date,
          amount: d.amount,
          // "today" by DATE, not by position: the history series is sparse (a
          // day with no completions has no row, and a cron gap can leave the
          // newest row days old), so the last row isn't necessarily today.
          kind: (d.timestamp.slice(0, 10) === todayIso
            ? "today"
            : "history") as "history" | "today",
        }))
      : []),
    ...(showForecast
      ? unbondingData.map((d) => ({
          label: d.label,
          amount: d.amount,
          kind: "forecast" as const,
        }))
      : []),
  ];
  // "Today" divider only makes sense when both parts are shown (it marks the
  // history→forecast boundary). Positioned by INDEX via <Customized> (a category
  // ReferenceLine resolves unreliably on the mixed history+forecast label axis),
  // centred on TODAY's bar — located by date, and hidden when today has no row
  // (drawing it on the last bar would place it on an older day).
  const undelegTodayIdx = undelegHistory.findIndex(
    (d) => d.timestamp.slice(0, 10) === todayIso
  );
  const undelegBoundaryIndex =
    showHistory && showForecast && undelegTodayIdx >= 0 ? undelegTodayIdx : -1;

  // --- Top-of-page KPI strip (mirrors the Tokenomics KpiSummary look) ---------
  // Latest block rate = most recent historical row carrying it (not in the live
  // validator API). Pending-undelegation subtitle compares the current total to
  // the typical 90-day level from the imported history.
  const latestBlockRate = [...historicalData]
    .reverse()
    .find((r) => r.blockRate != null)?.blockRate;
  // "vs typical" on the Pending Undelegations KPI: average OSMO completing per day
  // over the NEXT 14 days vs the average per day over the LAST 90 days — both from
  // the UndelegationDay flow series (same measure, so it's like-for-like). Reads as
  // "is upcoming unbonding pressure above or below the recent norm." Higher upcoming
  // = red (more leaving), lower = green. Both windows need data or it's null.
  const undelegFlowByDay = new Map<string, number>(
    (undelegations?.history ?? []).map((d) => [
      d.date.slice(0, 10),
      d.amountCompleting,
    ])
  );
  const undelegVsTypical = (() => {
    const today = new Date();
    const dayOffset = (n: number) =>
      new Date(today.getTime() + n * 86_400_000).toISOString().slice(0, 10);
    // Last 90 days (excluding today, which is still partial): offsets -90..-1.
    const last90: number[] = [];
    for (let i = 90; i >= 1; i--) {
      const v = undelegFlowByDay.get(dayOffset(-i));
      if (v != null) last90.push(v);
    }
    // Next 14 days (from tomorrow), preferring the live forecast buckets.
    const next14 = unbondingData.map((d) => d.amount);
    if (last90.length === 0 || next14.length === 0) return null;
    const avg90 = last90.reduce((s, v) => s + v, 0) / last90.length;
    const avg14 = next14.reduce((s, v) => s + v, 0) / next14.length;
    if (!(avg90 > 0)) return null;
    return (avg14 / avg90 - 1) * 100;
  })();

  const kpis: {
    label: string;
    value: ReactNode;
    sub?: string;
    /** Optional `?` explainer shown beside the label (used where the subtitle
     *  has been dropped in favour of a hover tooltip). */
    tooltip?: string;
    /** Tailwind text-color for the VALUE (defaults to white). */
    color?: string;
    /** Tailwind text-color for the SUB line (defaults to osmo-100). */
    subColor?: string;
  }[] = [
    {
      label: "Block Rate",
      value: latestBlockRate != null ? `${latestBlockRate.toFixed(2)}s` : "—",
      sub: "seconds per block",
    },
    {
      label: "Staked",
      value:
        metrics?.stakingRatio != null
          ? formatPercentage(metrics.stakingRatio, 2)
          : "—",
      sub: "of total supply",
    },
    {
      // Placeholder for an eventual security-ratio / value-secured figure.
      label: "Total Staked",
      value:
        metrics?.totalStaked != null
          ? formatNumberWithCommas(metrics.totalStaked, 0)
          : "—",
      sub: "bonded OSMO",
    },
    {
      label: "Active Validator Set",
      value: isLoading ? "…" : String(data?.validatorCount ?? "—"),
    },
    {
      label: "Nakamoto Coeff.",
      value: isLoading ? "…" : String(data?.nakamoto ?? "—"),
      tooltip:
        "Minimum validators to exceed ⅓ of bonded stake. Higher is more decentralized.",
    },
    {
      label: "Pending Undelegations",
      value:
        undelegationsLoading || !undelegations
          ? "…"
          : formatNumberWithCommas(undelegations.total, 0),
      // Value stays white; only the sub % is coloured. Higher upcoming vs typical
      // = red (more unbonding pressure), lower = green.
      sub:
        undelegVsTypical != null
          ? `${undelegVsTypical >= 0 ? "+" : ""}${undelegVsTypical.toFixed(0)}% vs 90d typical`
          : "currently unbonding",
      subColor:
        undelegVsTypical == null
          ? undefined
          : undelegVsTypical > 25
            ? "text-[#E57373]"
            : undelegVsTypical < -25
              ? "text-[#81C784]"
              : undefined,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Top KPI strip (replaces the old Decentralization stat card) */}
      <section aria-label="Key network metrics">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {kpis.map((kpi) => (
            <Card key={kpi.label} className="p-4" liftOnHover>
              <div className="inline-flex items-center gap-1 text-xs uppercase tracking-wide text-osmo-200">
                {kpi.label}
                {kpi.tooltip && (
                  <InfoTooltip
                    text={kpi.tooltip}
                    ariaLabel={`About ${kpi.label}`}
                  />
                )}
              </div>
              <div
                className={`mt-1 text-xl font-bold leading-tight sm:text-2xl ${kpi.color ?? "text-white"}`}
              >
                {kpi.value}
              </div>
              {kpi.sub && (
                <div
                  className={`mt-0.5 text-xs ${kpi.subColor ?? "text-osmo-100"}`}
                >
                  {kpi.sub}
                </div>
              )}
            </Card>
          ))}
        </div>
      </section>

      {/* Validator leaderboard */}
      <Card ref={validatorsRef} liftOnHover>
        <CardHeader className="mb-0">
          {/* Title left; share buttons + Columns menu top-right. */}
          <div className="flex items-start justify-between gap-3">
            <CardTitle as="h2">Validators</CardTitle>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <ScreenshotButtons
                targetRef={validatorsRef}
                filename="osmosis-validators"
                shareText="Osmosis validator set"
                csvRows={() =>
                  allValidators.map((v, i) => ({
                    rank: i + 1,
                    validator: v.moniker,
                    operatorAddress: v.operatorAddress,
                    votingPowerPct: +(v.votingPowerShare * 100).toFixed(4),
                    cumulativePct: +(
                      cumulativeByOperator.get(v.operatorAddress) ?? 0
                    ).toFixed(4),
                    commissionPct: +(v.commission * 100).toFixed(2),
                    uptimePct:
                      v.uptime == null ? null : +(v.uptime * 100).toFixed(4),
                    longRunUptimePct: v.longRunUptime ?? null,
                    govVotedRecent: v.govVotedRecent ?? null,
                    govRecentWindow: v.govRecentWindow ?? null,
                    govVotesLast10: v.govVotesLast10 ?? null,
                    timesSlashed: v.timesSlashed ?? null,
                    latestSlashedTime: v.latestSlashedTime ?? null,
                    selfBondPct: v.selfBondPercentage ?? null,
                  }))
                }
                csvFilename="osmosis-validators"
              />
              {/* Columns show/hide menu, inline with the share buttons. Validator +
                  rank always shown. */}
              <div
                ref={colMenuRef}
                data-screenshot-hide
                className="relative shrink-0"
              >
                <button
                  type="button"
                  onClick={() => setColMenuOpen((o) => !o)}
                  className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm font-medium text-osmo-100 transition-colors hover:bg-white/15 hover:text-white"
                  aria-expanded={colMenuOpen}
                >
                  Columns ▾
                </button>
                {colMenuOpen && (
                  <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-white/20 bg-osmo-900 p-2 shadow-xl">
                    {valColumns.map((c) => (
                      <label
                        key={c.key}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-osmo-100 hover:bg-white/10"
                      >
                        <input
                          type="checkbox"
                          checked={visibleCols.has(c.key)}
                          onChange={() =>
                            setVisibleCols((prev) => {
                              const next = new Set(prev);
                              if (next.has(c.key)) next.delete(c.key);
                              else next.add(c.key);
                              return next;
                            })
                          }
                          className="accent-osmo-purple"
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex min-h-[200px] items-center justify-center text-osmo-200">
              Loading validator set…
            </div>
          ) : (
            <div
              className="themed-scroll overflow-x-auto"
              data-screenshot-overflow-visible
            >
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/15 text-left text-osmo-200">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Validator</th>
                    {shownColumns.map((c) => (
                      <th
                        key={c.key}
                        className={`py-2 pr-3 font-medium last:pr-0 ${c.align === "right" ? "text-right" : "text-left"}`}
                      >
                        {/* Wrapping columns (long two-word headers) get a fixed
                            width so the table lays them out on a bounded line-box
                            that wraps at word boundaries, keeping the `?` flowing
                            after the final word rather than each word breaking onto
                            its own line. */}
                        <span
                          className={`inline items-baseline whitespace-normal align-baseline ${c.align === "right" ? "text-right" : "text-left"}`}
                          style={
                            c.key === "cumulative"
                              ? { display: "inline-block", width: "5.5rem" }
                              : c.key === "governance"
                                ? { display: "inline-block", width: "7.5rem" }
                                : c.key === "longRunUptime"
                                  ? { display: "inline-block", width: "6rem" }
                                  : undefined
                          }
                        >
                          {c.label}
                          {c.info && (
                            <>
                              {" "}
                              <InfoTooltip
                                text={c.info}
                                ariaLabel={`About ${c.label}`}
                                align={c.align === "right" ? "end" : "center"}
                              />
                            </>
                          )}
                        </span>
                        {c.subLabel && (
                          <span className="block text-[10px] font-normal text-osmo-300">
                            {c.subLabel}
                          </span>
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleValidators.map((v, i) => {
                    // Consensus-threshold markers AFTER the validator that completes
                    // ⅓ (veto, red) and ⅔ (control, orange): a very narrow labeled
                    // row on the dotted line, with the meaning on hover.
                    const marker =
                      i === vetoIdx
                        ? {
                            color: "#FF6B6B",
                            label: "Veto Threshold",
                            info: "Validators at or above this line together hold more than ⅓ of voting power, enough to veto governance proposals and halt the chain. This count is the Nakamoto coefficient. Delegate to validators below this line to increase decentralization of the network.",
                          }
                        : i === controlIdx
                          ? {
                              color: "#FFB74D",
                              label: "Control Threshold",
                              info: "Validators at or above this line together hold more than ⅔ of voting power, enough to control consensus (pass or censor anything and produce blocks unilaterally). Delegating to validators below this line does the most to increase decentralization of the network.",
                            }
                          : null;
                    return (
                      <Fragment key={v.operatorAddress}>
                        <tr className="border-b border-white/5">
                          <td className="py-2 pr-3 tabular-nums text-osmo-200">
                            {i + 1}
                          </td>
                          <td className="py-2 pr-3 font-medium text-white">
                            <span className="inline-flex items-center gap-1.5">
                              <a
                                href={`https://www.mintscan.io/osmosis/validators/${v.operatorAddress}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-white underline-offset-2 hover:text-osmo-pink hover:underline"
                                title={`View ${v.moniker} on Mintscan`}
                              >
                                {v.moniker}
                              </a>
                              {v.website && (
                                <a
                                  href={v.website}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={`${v.moniker} website`}
                                  title={v.website}
                                  className="shrink-0 text-osmo-300 transition-colors hover:text-white"
                                >
                                  {/* Globe = the validator's own website (distinct
                                      from the Mintscan link on the name). */}
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    width="13"
                                    height="13"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    aria-hidden="true"
                                  >
                                    <circle cx="12" cy="12" r="10" />
                                    <path d="M2 12h20" />
                                    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
                                  </svg>
                                </a>
                              )}
                            </span>
                          </td>
                          {shownColumns.map((c) => (
                            <td
                              key={c.key}
                              className={`py-2 pr-3 tabular-nums last:pr-0 ${c.align === "right" ? "text-right" : "text-left"} text-osmo-100`}
                            >
                              {c.render(v, i)}
                            </td>
                          ))}
                        </tr>
                        {marker && (
                          <tr>
                            <td
                              colSpan={2 + shownColumns.length}
                              className="p-0"
                            >
                              {/* Label sits INSIDE the dotted line: a dashed segment
                                  on each side, breaking to leave a gap for the text. */}
                              <div className="flex items-center gap-2 py-1">
                                <span
                                  className="h-0 flex-1 border-t border-dashed"
                                  style={{ borderColor: marker.color }}
                                  aria-hidden
                                />
                                <span
                                  className="inline-flex items-center gap-1 text-[10px] font-medium tracking-wide"
                                  style={{ color: marker.color }}
                                >
                                  {marker.label}
                                  <InfoTooltip
                                    text={marker.info}
                                    ariaLabel={`About the ${marker.label}`}
                                  />
                                </span>
                                <span
                                  className="h-0 flex-1 border-t border-dashed"
                                  style={{ borderColor: marker.color }}
                                  aria-hidden
                                />
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              {allValidators.length > defaultRows && (
                <button
                  type="button"
                  onClick={() => setLeaderboardExpanded((v) => !v)}
                  className="mt-3 w-full rounded-lg border border-white/15 bg-white/5 py-2 text-sm font-medium text-osmo-100 transition-colors hover:bg-white/15 hover:text-white"
                >
                  {leaderboardExpanded
                    ? "Show fewer"
                    : `Show all ${allValidators.length} validators`}
                </button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Voting-power distribution — treemap: each tile's area is a validator's
          share of bonded stake, tinted by consensus-threshold zone, so the
          concentration of voting power reads at a glance. */}
      <Card ref={treemapRef} liftOnHover>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <span className="inline-flex items-center gap-1.5">
              <CardTitle as="h2">Voting Power Treemap</CardTitle>
              <InfoTooltip
                text="Each tile's area is the validator's share of bonded stake, so concentration among the largest validators is visible at a glance. Tiles are tinted red for the validators that together hold the first ⅓ of stake (veto power) and orange for those completing ⅔ (control). Click a tile to open the validator on Mintscan."
                ariaLabel="About the Voting Power Treemap"
              />
            </span>
            <ScreenshotButtons
              targetRef={treemapRef}
              filename="osmosis-voting-power-treemap"
              shareText="Osmosis voting power distribution (treemap)"
              csvRows={() =>
                chartData.map((d, i) => ({
                  rank: i + 1,
                  validator: d.moniker,
                  operatorAddress: d.operatorAddress,
                  votingPowerPct: +d.share.toFixed(4),
                }))
              }
              csvFilename="osmosis-voting-power-treemap"
            />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex min-h-[360px] items-center justify-center text-osmo-200">
              Loading validator set…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <Treemap
                data={treemapData}
                dataKey="size"
                nameKey="name"
                stroke="#1f0a29"
                isAnimationActive={false}
                content={<TreemapCell />}
              >
                <Tooltip
                  contentStyle={{
                    backgroundColor: "rgba(31, 10, 41, 0.95)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(255, 255, 255, 0.2)",
                    borderRadius: "8px",
                  }}
                  labelStyle={{ color: "#fff" }}
                  itemStyle={{ color: "#fff" }}
                  formatter={(value: number, _n, p) => [
                    `${formatPercentage((p?.payload?.share as number) ?? value, 2)} voting power`,
                    (p?.payload?.name as string) ?? "",
                  ]}
                />
              </Treemap>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Nakamoto + Gini over time (history from the SmartStake import; the cron
          keeps them current). Side by side on desktop, stacked on mobile. */}
      <div className="grid gap-6 lg:grid-cols-2">
        <MetricLineChart
          title="Nakamoto Coefficient"
          explainer="Minimum validators to exceed ⅓ of bonded stake, over time. Higher is more decentralized."
          data={historicalData}
          dataKey="nakamotoCoefficient"
          color="#4FC3F7"
          decimals={0}
          defaultRange="1y"
        />
        <MetricLineChart
          title="Gini Coefficient"
          explainer="Voting power inequality across the validator set. 0 is an even distribution, 1 is a single validator holding all voting power."
          data={historicalData}
          dataKey="giniCoefficient"
          color="#FF66CC"
          decimals={3}
          defaultRange="1y"
        />
      </div>

      {/* Staking ratio over time (moved here from Tokenomics: it's a
          staking-health metric, not a tokenomics one). */}
      <StakingRatioChart
        stakingRatio={metrics?.stakingRatio ?? null}
        historicalData={historicalData}
      />

      {/* Pending undelegations — forward 14-day forecast OR imported history */}
      <Card ref={undelegationsRef} liftOnHover>
        <CardHeader>
          <ChartHeader
            title="Pending Undelegations"
            titleExplainer="OSMO completing its unbonding period each day, summed from every validator's actual unbonding delegations. Undelegations may be cancelled before completion, so upcoming amounts are indicative."
            timeRange={undelegRange}
            onRangeChange={setUndelegRange}
            // The range lives in extraControls (under the toggles), not in the
            // header's built-in slot, so hide the built-in one.
            hideTimeRange
            cardRef={undelegationsRef}
            screenshotFilename="osmosis-pending-undelegations"
            shareText="OSMO pending undelegations on Osmosis"
            // Full per-completion-day series (NOT scoped to the selected range).
            // Forecast is omitted — it's the same completing-per-day measure and the
            // history series already carries the forward tail, so it'd be redundant.
            csvRows={() =>
              (undelegations?.history ?? [])
                .slice()
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((d) => ({
                  date: d.date.slice(0, 10),
                  osmoCompleting: Math.round(d.amountCompleting),
                }))
            }
            csvFilename="osmosis-pending-undelegations"
            extraControls={
              <div className="flex flex-wrap items-center gap-2 text-sm">
                {/* History + its timespan share ONE pill (merged background) so the
                    range reads as belonging to History. Selecting a range also
                    turns History on. */}
                <div className="flex items-center gap-1 rounded-lg bg-white/5 p-1">
                  <button
                    type="button"
                    onClick={() => setShowHistory((v) => !v)}
                    aria-pressed={showHistory}
                    className={`rounded-md px-3 py-1 font-medium transition-colors ${
                      showHistory
                        ? "bg-white/15 text-white"
                        : "text-osmo-200 hover:text-white"
                    }`}
                  >
                    History
                  </button>
                  <span className="mx-0.5 h-4 w-px bg-white/15" aria-hidden />
                  {(
                    [
                      { value: "30d", label: "30D" },
                      { value: "90d", label: "90D" },
                      { value: "1y", label: "1Y" },
                      { value: "all", label: "All" },
                    ] as const
                  ).map((r) => (
                    <button
                      key={r.value}
                      type="button"
                      onClick={() => {
                        setUndelegRange(r.value);
                        setShowHistory(true);
                      }}
                      className={`rounded-md px-3 py-1 font-medium transition-colors ${
                        undelegRange === r.value
                          ? "bg-osmo-purple text-white"
                          : "text-osmo-200 hover:text-white"
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                {/* Forecast and Details as separate standalone buttons. */}
                <button
                  type="button"
                  onClick={() => setShowForecast((v) => !v)}
                  aria-pressed={showForecast}
                  className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                    showForecast
                      ? "bg-white/15 text-white"
                      : "bg-white/5 text-osmo-200 hover:text-white"
                  }`}
                >
                  Forecast
                </button>
                <button
                  type="button"
                  onClick={() => setShowDetails((v) => !v)}
                  aria-pressed={showDetails}
                  className={`rounded-lg px-3 py-1.5 font-medium transition-colors ${
                    showDetails
                      ? "bg-white/15 text-white"
                      : "bg-white/5 text-osmo-200 hover:text-white"
                  }`}
                >
                  Details
                </button>
              </div>
            }
            headlineValue={
              undelegations != null
                ? formatNumberWithCommas(undelegations.total, 0)
                : "—"
            }
            headlineLabel="OSMO total unbonding"
            headlineColor="text-[#7C4DFF]"
          />
        </CardHeader>
        <CardContent>
          {/* Combined daily column chart: History (past total outstanding) then
              Forecast (next 14d completing), split by the Today line. Rendered
              when either toggle is on. */}
          {undelegationsLoading && showForecast ? (
            <div className="flex min-h-[320px] items-center justify-center text-osmo-200">
              Loading unbonding schedule…
            </div>
          ) : showForecast || showHistory ? (
            undelegChartData.length === 0 ? (
              <div className="flex min-h-[320px] items-center justify-center text-osmo-200">
                No unbonding data for this range
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={340}>
                <BarChart
                  data={undelegChartData}
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <XAxis
                    dataKey="label"
                    stroke="#fff"
                    tick={{ fill: "#e0d5f5", fontSize: 12 }}
                    ticks={makeMonthlyTicks(
                      undelegChartData.map((d) => d.label),
                      // Only history rows carry a real timestamp for month-tick
                      // thinning; forecast labels are short day labels that fit.
                      // Timestamps must track the History toggle: with History
                      // off the chart holds only forecast rows, and pairing
                      // history timestamps against them by index would emit
                      // forecast labels as bogus month ticks.
                      showHistory ? undelegHistory.map((d) => d.timestamp) : [],
                      undelegRange
                    )}
                    angle={-45}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis
                    stroke="#fff"
                    tick={{ fill: "#e0d5f5" }}
                    tickFormatter={(v) => formatNumber(v, 0)}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.06)" }}
                    contentStyle={{
                      backgroundColor: "rgba(31, 10, 41, 0.95)",
                      backdropFilter: "blur(12px)",
                      border: "1px solid rgba(255, 255, 255, 0.2)",
                      borderRadius: "8px",
                    }}
                    labelStyle={{ color: "#fff" }}
                    itemStyle={{ color: "#fff" }}
                    formatter={(value: number, _n, p) => {
                      const kind = p?.payload?.kind;
                      const label =
                        kind === "forecast"
                          ? "Unbonding"
                          : kind === "today"
                            ? "Releasing"
                            : "Completed";
                      return [
                        `${formatNumberWithCommas(value, 0)} OSMO`,
                        label,
                      ];
                    }}
                  />
                  {/* Today divider (history→forecast boundary), positioned by
                      bar-band index via <Customized> so it lands reliably on the
                      mixed-label axis. Only when both parts are shown. */}
                  {undelegBoundaryIndex >= 0 && (
                    <Customized
                      component={(props: CustomizedAxisProps) => (
                        <UndelegBoundaryLine
                          index={undelegBoundaryIndex}
                          count={undelegChartData.length}
                          axis={props}
                        />
                      )}
                    />
                  )}
                  {/* One full-width bar per day; colour by kind (history purple,
                      forecast lighter). No day is both, so no 0-value half-bars. */}
                  <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                    {undelegChartData.map((d, i) => (
                      <Cell
                        key={i}
                        fill={d.kind === "forecast" ? "#B39DFF" : "#7C4DFF"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )
          ) : null}

          {/* Details: the largest individual unbonding entries. Rendered below
              the chart (or alone) when the Details toggle is on. */}
          {showDetails &&
            (undelegationsLoading ? (
              <div className="flex min-h-[200px] items-center justify-center text-osmo-200">
                Loading unbonding entries…
              </div>
            ) : (undelegations?.topEntries ?? []).length === 0 ? (
              <div className="flex min-h-[200px] items-center justify-center text-osmo-200">
                No unbonding entries
              </div>
            ) : (
              <div
                data-screenshot-overflow-visible
                className={`themed-scroll overflow-x-auto ${showForecast || showHistory ? "mt-6 border-t border-white/10 pt-4" : ""}`}
              >
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/15 text-left text-osmo-200">
                      <th className="py-2 pr-3 font-medium">#</th>
                      <th className="py-2 pr-3 font-medium">Delegator</th>
                      <th className="py-2 pr-3 font-medium">Validator</th>
                      <th className="py-2 pr-3 text-right font-medium">
                        Amount
                      </th>
                      <th className="py-2 text-right font-medium">Completes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const entries = undelegations?.topEntries ?? [];
                      const pages = Math.max(1, Math.ceil(entries.length / 10));
                      const page = Math.min(detailsPage, pages - 1);
                      return entries.slice(page * 10, page * 10 + 10);
                    })().map((e, i) => {
                      const pages = Math.max(
                        1,
                        Math.ceil((undelegations?.topEntries ?? []).length / 10)
                      );
                      const page = Math.min(detailsPage, pages - 1);
                      const rank = page * 10 + i + 1;
                      return (
                        <tr
                          key={`${e.delegator}-${e.validator}-${e.completionTime}-${rank}`}
                          className="border-b border-white/5"
                        >
                          <td className="py-2 pr-3 tabular-nums text-osmo-200">
                            {rank}
                          </td>
                          <td className="py-2 pr-3">
                            <a
                              href={`https://www.mintscan.io/osmosis/address/${e.delegator}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-xs text-osmo-100 underline-offset-2 hover:text-white hover:underline"
                              title={e.delegator}
                            >
                              {shortenAddress(e.delegator)}
                            </a>
                          </td>
                          <td className="py-2 pr-3 text-white">{e.moniker}</td>
                          <td className="py-2 pr-3 text-right tabular-nums text-white">
                            {formatNumberWithCommas(e.amount, 0)} OSMO
                          </td>
                          <td className="py-2 text-right tabular-nums text-osmo-100">
                            {new Date(e.completionTime).toLocaleDateString(
                              undefined,
                              {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              }
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {/* Pager: 10 rows/page. */}
                {(() => {
                  const total = (undelegations?.topEntries ?? []).length;
                  const pages = Math.ceil(total / 10);
                  if (pages <= 1) return null;
                  const page = Math.min(detailsPage, pages - 1);
                  return (
                    <div className="mt-3 flex items-center justify-between text-sm text-osmo-200">
                      <span>
                        Showing {page * 10 + 1}–
                        {Math.min((page + 1) * 10, total)} of Top {total}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setDetailsPage((p) => Math.max(0, p - 1))
                          }
                          disabled={page === 0}
                          className="rounded-md border border-white/15 bg-white/5 px-3 py-1 font-medium transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Prev
                        </button>
                        <span className="tabular-nums">
                          {page + 1} / {pages}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setDetailsPage((p) => Math.min(pages - 1, p + 1))
                          }
                          disabled={page >= pages - 1}
                          className="rounded-md border border-white/15 bg-white/5 px-3 py-1 font-medium transition-colors hover:bg-white/15 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Next
                        </button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            ))}

          {/* Nothing selected. */}
          {!showForecast && !showHistory && !showDetails && (
            <div className="flex min-h-[320px] items-center justify-center text-center text-osmo-200">
              Select Forecast, History, or Details above to show data.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Block rate — network performance (seconds per block), history from the
          SmartStake import; the cron computes it from daily block-height deltas. */}
      <MetricLineChart
        title="Block Rate"
        data={historicalData}
        dataKey="blockRate"
        color="#81C784"
        unit="s"
        decimals={2}
        events={NETWORK_EVENTS}
        defaultRange="90d"
      />

      {/* Footer: data sources + snapshot disclaimer (mirrors the Tokenomics
          footer). Validator set / voting power / uptime / undelegations are live
          from the chain; the Nakamoto / Gini / block-rate history and the
          per-validator governance, slashing and long-run-uptime columns are
          imported from Smart Stake (linked in the snapshot note below). */}
      <footer className="rounded-lg bg-white/5 p-4 text-center text-sm text-osmo-100">
        <p>
          Data Sources:{" "}
          <a
            href="https://lcd.osmosis.zone/swagger"
            target="_blank"
            rel="noopener noreferrer"
            className="text-osmo-300 underline hover:text-white"
          >
            Osmosis Chain
          </a>
        </p>
        {metrics?.timestamp && (
          <p className="mt-2">
            Onchain data snapshot as of{" "}
            {new Date(metrics.timestamp).toLocaleDateString("en-GB", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            . Historical data before 14th July 2026 from{" "}
            <a
              href="https://smartstake.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-osmo-300 underline hover:text-white"
            >
              Smart Stake
            </a>
            .
          </p>
        )}
      </footer>
    </div>
  );
}
