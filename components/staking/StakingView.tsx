"use client";

import { Fragment, useState, useRef } from "react";
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
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { useValidatorData } from "@/lib/hooks/useValidatorData";
import { useUndelegations } from "@/lib/hooks/useUndelegations";
import { useOsmosisMetrics } from "@/lib/hooks/useOsmosisMetrics";
import { useHistoricalData } from "@/lib/hooks/useHistoricalData";
import type { HistoricalRecord } from "@/lib/historical-file";
import {
  formatNumber,
  formatNumberWithCommas,
  formatPercentage,
  formatChartDate,
  makeMonthlyTicks,
} from "@/lib/utils";
import { TimeRange, filterDataByTimeRange } from "../TimeRangeSelector";
import { ChartHeader } from "../charts/ChartHeader";
import { InfoTooltip } from "../ui/InfoTooltip";
import { StakingRatioChart } from "../charts/StakingRatioChart";

// One headline stat with an optional `?` explainer.
function Stat({
  label,
  value,
  explainer,
  color = "text-white",
}: {
  label: string;
  value: string;
  explainer?: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg bg-white/5 p-4">
      <div className="flex items-center gap-1.5 text-xs text-osmo-200">
        <span>{label}</span>
        {explainer && (
          <InfoTooltip text={explainer} ariaLabel={`About ${label}`} />
        )}
      </div>
      <div className={`mt-1 text-2xl font-bold sm:text-3xl ${color}`}>
        {value}
      </div>
    </div>
  );
}

// Osmosis-purple single-hue ramp for the voting-power bars (magnitude, not
// identity — so one hue, darkest for the largest validator). Cells beyond the
// list reuse the lightest step.
const BAR_FILL = "#7C4DFF";

// A simple single-series line chart over the daily history, for the metrics
// backfilled from SmartStake (Nakamoto, Gini, block rate). Points missing the
// value are dropped (connectNulls keeps the line continuous across gaps). `unit`
// is appended in the tooltip; `decimals` controls y-axis / tooltip precision.
function MetricLineChart({
  title,
  subtitle,
  data,
  dataKey,
  color,
  unit = "",
  decimals = 0,
}: {
  title: string;
  subtitle: string;
  data: HistoricalRecord[];
  dataKey: "nakamotoCoefficient" | "giniCoefficient" | "blockRate";
  color: string;
  unit?: string;
  decimals?: number;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const filtered = filterDataByTimeRange(data, timeRange).filter(
    (r) => r[dataKey] != null
  );
  const chartData = filtered.map((r) => ({
    date: formatChartDate(r.timestamp, timeRange),
    timestamp: r.timestamp,
    value: r[dataKey] as number,
  }));

  return (
    <Card ref={cardRef} liftOnHover>
      <CardHeader>
        <ChartHeader
          title={title}
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename={`osmo-${dataKey}`}
          shareText={`Osmosis ${title.toLowerCase()} over time`}
          csvRows={() =>
            data
              .filter((r) => r[dataKey] != null)
              .map((r) => ({ date: r.timestamp, value: r[dataKey] as number }))
          }
        />
        <p className="mt-1 text-sm text-osmo-200">{subtitle}</p>
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
                domain={["auto", "auto"]}
                tickFormatter={(v) => v.toFixed(decimals)}
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

// A dotted consensus-boundary line drawn UNDER the boundary validator's bar (at
// the bottom edge of its category band), spanning the plot width, with a label.
// Rendered via <Customized> so we get the y-axis band scale and can position
// between rows — a plain category ReferenceLine centers on the bar instead.
function BoundaryLine({
  count,
  index,
  color,
  label,
  axis,
}: {
  count: number;
  index: number;
  color: string;
  label: string;
  axis: CustomizedAxisProps;
}) {
  if (index < 0 || count <= 0) return null;
  const off = axis.offset;
  if (!off) return null;
  // Pure geometry: the plot has `count` equal-height rows top-to-bottom, so the
  // BOTTOM edge of row `index` (0-based) is (index+1)/count of the way down the
  // plot. Independent of the band scale's center/top convention (which tripped
  // up the earlier scale()-based attempts, leaving the line on the bar).
  const y = off.top + ((index + 1) / count) * off.height;
  const x1 = off.left;
  const x2 = off.left + off.width;
  return (
    <g pointerEvents="none">
      <line
        x1={x1}
        x2={x2}
        y1={y}
        y2={y}
        stroke={color}
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
      <text x={x2 - 6} y={y - 5} textAnchor="end" fill={color} fontSize={11}>
        {label}
      </text>
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
  const [distributionExpanded, setDistributionExpanded] = useState(false);

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

  // Full validator set for the distribution chart (stake-desc). Each bar is
  // labelled, so the chart height scales with the count. Track the running
  // cumulative share so we can mark the consensus boundaries.
  const validators = data?.validators ?? [];
  let cumulative = 0;
  const chartData = validators.map((v) => {
    cumulative += v.votingPowerShare * 100;
    return {
      // Full name (no truncation) — the axis tick wraps it across lines to fit
      // the column (see WrappedTick). fullMoniker still feeds the tooltip.
      moniker: v.moniker,
      fullMoniker: v.moniker,
      operatorAddress: v.operatorAddress, // for the Mintscan link on bar-click
      share: v.votingPowerShare * 100,
      tokens: v.tokens,
      cumulative,
    };
  });
  // Consensus boundaries: the FIRST validator at which running cumulative stake
  // crosses 1/3 (>33.4% can veto/halt — this count IS the Nakamoto coefficient)
  // and 2/3 (>66.7% controls consensus). We draw a dotted line UNDER that
  // validator's bar (at the band's bottom edge), so "everyone at or above the
  // line collectively holds that share".
  const boundaryIndex = (threshold: number): number =>
    chartData.findIndex((d) => d.cumulative >= threshold);
  const vetoIdx = boundaryIndex(33.4); // ⅓
  const controlIdx = boundaryIndex(66.7); // ⅔

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
  // The distribution chart shows a bit more than the leaderboard's cutoff
  // (defaultRows + 10) before rolling the tail into a "Remaining" bar — the
  // consensus boundaries still fall within it (control is at controlIdx <
  // defaultRows). In the collapsed view the validators past the chart cutoff are
  // aggregated into a single trailing bar (their combined voting power) so the
  // chart still sums to 100%. The expand toggle reveals all individually.
  const chartCutoff = defaultRows + 10;
  const visibleChartData = (() => {
    if (distributionExpanded || chartData.length <= chartCutoff) {
      return chartData;
    }
    const shown = chartData.slice(0, chartCutoff);
    const rest = chartData.slice(chartCutoff);
    const restShare = rest.reduce((s, d) => s + d.share, 0);
    const restTokens = rest.reduce((s, d) => s + d.tokens, 0);
    return [
      ...shown,
      {
        moniker: `Remaining ${rest.length} validators`,
        fullMoniker: `Remaining ${rest.length} validators (Click to expand)`,
        share: restShare,
        tokens: restTokens,
        cumulative: 100,
        isRemainder: true,
      },
    ];
  })();
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
  // Uptime quartile thresholds across the set: cells at or below p25 are coloured
  // orange (worst quarter), at or above p75 green (best quarter), the middle two
  // quartiles neutral. Computed over validators that actually have an uptime.
  const uptimes = allValidators
    .map((v) => v.uptime)
    .filter((u): u is number => u != null)
    .sort((a, b) => a - b);
  const quantile = (arr: number[], q: number): number | null => {
    if (arr.length === 0) return null;
    const pos = (arr.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
  };
  const uptimeP25 = quantile(uptimes, 0.25);
  const uptimeP75 = quantile(uptimes, 0.75);
  const uptimeColorClass = (u: number | null): string => {
    if (u == null || uptimeP25 == null || uptimeP75 == null)
      return "text-osmo-100";
    if (u <= uptimeP25) return "text-amber-300";
    if (u >= uptimeP75) return "text-emerald-300";
    return "text-osmo-100";
  };
  // Fit the X axis to the real max of what's actually plotted (round up to the
  // next whole %). Computed over visibleChartData so the aggregated "Remaining"
  // bar — which can exceed any single validator's share — isn't clipped.
  const maxShare = visibleChartData.reduce((m, d) => Math.max(m, d.share), 0);
  const shareAxisMax = Math.max(1, Math.ceil(maxShare));
  // ~22px per bar keeps every label readable; floor so a tiny set still has height.
  const chartHeight = Math.max(360, visibleChartData.length * 22);

  // Next-14-day unbonding schedule (forward-looking). Show a bar per calendar day
  // even when nothing completes that day, so the axis is a continuous 14-day
  // window rather than only the days that happen to have completions.
  const unbondingData = (() => {
    if (!undelegations) return [];
    const byDay = new Map(undelegations.days.map((d) => [d.date, d.amount]));
    const out: { date: string; label: string; amount: number }[] = [];
    const start = new Date();
    for (let i = 0; i < 14; i++) {
      const d = new Date(start.getTime() + i * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      out.push({
        date: iso,
        label: d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        amount: byDay.get(iso) ?? 0,
      });
    }
    return out;
  })();

  return (
    <div className="space-y-6">
      {/* Decentralization overview */}
      <Card liftOnHover>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <CardTitle as="h2">Decentralization</CardTitle>
            {/* Time control placeholder: history is being recorded from now; the
                selector activates once enough daily points exist. */}
            <span className="shrink-0 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-xs text-osmo-200">
              History accumulating
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Nakamoto coefficient"
              value={isLoading ? "…" : String(data?.nakamoto ?? "—")}
              color="text-[#4FC3F7]"
              explainer="The minimum number of validators whose combined stake exceeds 1/3 of the bonded total — the smallest colluding set that could halt the chain. Higher is more decentralized."
            />
            <Stat
              label="Gini coefficient"
              value={isLoading ? "…" : (data?.gini.toFixed(3) ?? "—")}
              explainer="Stake-concentration inequality across the validator set, from 0 (perfectly even) to 1 (all stake on one validator). Complements Nakamoto by describing the whole distribution, not just the top tail."
            />
            <Stat
              label="Active validators"
              value={isLoading ? "…" : String(data?.validatorCount ?? "—")}
              explainer="Validators currently in the bonded (active) set, earning rewards and signing blocks."
            />
            <Stat
              label="Pending undelegations"
              value={
                undelegationsLoading
                  ? "…"
                  : undelegations
                    ? formatNumber(undelegations.total, 0)
                    : "—"
              }
              explainer="OSMO currently unbonding across the chain (in the ~14-day unbonding period), not yet liquid. Summed from every validator's actual unbonding delegations — NOT the staking pool's not-bonded tokens, which on Osmosis also include non-unbonding module balances and overstate this ~25x."
            />
          </div>
        </CardContent>
      </Card>

      {/* Nakamoto + Gini over time (history from the SmartStake import; the cron
          keeps them current). */}
      <MetricLineChart
        title="Nakamoto Coefficient"
        subtitle="Minimum validators to exceed ⅓ of bonded stake, over time. Higher is more decentralized."
        data={historicalData}
        dataKey="nakamotoCoefficient"
        color="#4FC3F7"
        decimals={0}
      />
      <MetricLineChart
        title="Gini Coefficient"
        subtitle="Stake-concentration inequality across the validator set (0 even → 1 concentrated), over time."
        data={historicalData}
        dataKey="giniCoefficient"
        color="#FF66CC"
        decimals={3}
      />

      {/* Staking ratio over time (moved here from Tokenomics: it's a
          staking-health metric, not a tokenomics one). */}
      <StakingRatioChart
        stakingRatio={metrics?.stakingRatio ?? null}
        historicalData={historicalData}
      />

      {/* Voting-power distribution */}
      <Card liftOnHover>
        <CardHeader>
          <CardTitle as="h2">Voting Power Distribution</CardTitle>
          <p className="mt-1 text-sm text-osmo-200">
            Share of bonded stake per validator, with the ⅓ veto and ⅔ control
            thresholds marked. Showing the consensus-relevant set by default;
            click a validator to view it on Mintscan.
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex min-h-[400px] items-center justify-center text-osmo-200">
              Loading validator set…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <BarChart
                data={visibleChartData}
                layout="vertical"
                // Negative left margin pulls the label column back over the Card's
                // p-6 (24px) left padding, so the names don't sit far inset from
                // the card edge (the blank space left of even long labels).
                margin={{ top: 8, right: 24, left: -36, bottom: 8 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="rgba(255,255,255,0.1)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  domain={[0, shareAxisMax]}
                  stroke="#fff"
                  tick={{ fill: "#e0d5f5" }}
                  tickFormatter={(v) => `${v.toFixed(0)}%`}
                />
                <YAxis
                  type="category"
                  dataKey="moniker"
                  stroke="#fff"
                  // Right-aligned (default) so every label sits flush against the
                  // axis line next to its bar, whatever its length. Width is only
                  // as wide as the truncated names need (~29 chars), which keeps
                  // the far-left dead space minimal.
                  tick={{ fill: "#e0d5f5", fontSize: 11 }}
                  width={225}
                  // interval={0} forces a tick (label) for EVERY bar; Recharts
                  // otherwise thins them to every other when space is tight.
                  interval={0}
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
                  // itemStyle sets the VALUE row's text colour; without it Recharts
                  // renders the item text in its default black (the "black tooltip").
                  itemStyle={{ color: "#fff" }}
                  // Show the FULL validator name in the tooltip title even though
                  // the axis label is truncated to fit the column. `payload` typed
                  // loosely to avoid fighting Recharts' Tooltip generics.
                  labelFormatter={(
                    labelValue: string,
                    payload: ReadonlyArray<{
                      payload?: { fullMoniker?: string };
                    }>
                  ) => payload?.[0]?.payload?.fullMoniker ?? labelValue}
                  formatter={(value: number, _name, item) => [
                    `${value.toFixed(2)}%  (${formatNumberWithCommas(item?.payload?.tokens ?? 0, 0)} OSMO)`,
                    "Voting power",
                  ]}
                />
                <Bar
                  dataKey="share"
                  radius={[0, 4, 4, 0]}
                  // Click behaviour: the aggregated "Remaining" bar expands the
                  // chart to all validators; a real validator's bar opens its
                  // Mintscan profile in a new tab.
                  onClick={(entry: {
                    payload?: {
                      isRemainder?: boolean;
                      operatorAddress?: string;
                    };
                  }) => {
                    const p = entry?.payload;
                    if (p?.isRemainder) {
                      setDistributionExpanded(true);
                    } else if (p?.operatorAddress) {
                      window.open(
                        `https://www.mintscan.io/osmosis/validators/${p.operatorAddress}`,
                        "_blank",
                        "noopener,noreferrer"
                      );
                    }
                  }}
                >
                  {visibleChartData.map((d, i) => {
                    const remainder = "isRemainder" in d && d.isRemainder;
                    return (
                      <Cell
                        key={i}
                        // The aggregated tail bar gets a muted grey so it doesn't
                        // read as a single validator. Every bar is clickable
                        // (validator → Mintscan, remainder → expand), so all get a
                        // pointer cursor.
                        fill={remainder ? "#6B6480" : BAR_FILL}
                        cursor="pointer"
                      />
                    );
                  })}
                </Bar>
                {/* Consensus boundaries: dotted lines UNDER the bar where
                    cumulative stake first crosses ⅓ (veto/halt) and ⅔ (control),
                    via Customized so they sit at the band edge, not through the bar. */}
                <Customized
                  component={(props: CustomizedAxisProps) => (
                    <>
                      <BoundaryLine
                        count={visibleChartData.length}
                        index={vetoIdx}
                        color="#FF6B6B"
                        label="Veto Threshold"
                        axis={props}
                      />
                      <BoundaryLine
                        count={visibleChartData.length}
                        index={controlIdx}
                        color="#FFB74D"
                        label="Control Threshold"
                        axis={props}
                      />
                    </>
                  )}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
          {/* Expanding is done by clicking the "Remaining" bar; only a collapse
              control is needed once expanded (that bar is then gone). */}
          {!isLoading &&
            distributionExpanded &&
            chartData.length > chartCutoff && (
              <button
                type="button"
                onClick={() => setDistributionExpanded(false)}
                className="mt-3 w-full rounded-lg border border-white/15 bg-white/5 py-2 text-sm font-medium text-osmo-100 transition-colors hover:bg-white/15 hover:text-white"
              >
                Show fewer
              </button>
            )}
        </CardContent>
      </Card>

      {/* Validator leaderboard */}
      <Card>
        <CardHeader>
          <CardTitle as="h2">Validators</CardTitle>
          {data?.snapshotAsOf && (
            <p className="mt-1 text-xs text-osmo-300">
              Governance, long-run uptime and slashing as of{" "}
              {new Date(data.snapshotAsOf).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
              .
            </p>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex min-h-[200px] items-center justify-center text-osmo-200">
              Loading validator set…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/15 text-left text-osmo-200">
                    <th className="py-2 pr-3 font-medium">#</th>
                    <th className="py-2 pr-3 font-medium">Validator</th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Voting power
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Cumulative
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Commission
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Uptime
                      <span className="block text-[10px] font-normal text-osmo-300">
                        recent (~80k blocks)
                      </span>
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Long-run uptime
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      Governance
                      <span className="block text-[10px] font-normal text-osmo-300">
                        last 10 proposals
                      </span>
                    </th>
                    <th className="py-2 text-right font-medium">Slashed</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleValidators.map((v, i) => {
                    const highCommission = v.commission > 0.1;
                    // Consensus-threshold markers: a dotted coloured divider AFTER
                    // the validator that completes ⅓ (veto, red) and ⅔ (control,
                    // orange), matching the distribution chart's lines (no label).
                    const markerColor =
                      i === vetoIdx
                        ? "#FF6B6B"
                        : i === controlIdx
                          ? "#FFB74D"
                          : null;
                    return (
                      <Fragment key={v.operatorAddress}>
                        <tr className="border-b border-white/5">
                          <td className="py-2 pr-3 tabular-nums text-osmo-200">
                            {i + 1}
                          </td>
                          <td className="py-2 pr-3 font-medium text-white">
                            {v.moniker}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-white">
                            {formatPercentage(v.votingPowerShare * 100, 2)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-osmo-200">
                            {formatPercentage(
                              cumulativeByOperator.get(v.operatorAddress) ?? 0,
                              2
                            )}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-osmo-100">
                            {highCommission && (
                              <span
                                className="mr-1 text-amber-300"
                                title="Commission above 10%"
                                aria-label="Commission above 10%"
                              >
                                (!)
                              </span>
                            )}
                            {formatPercentage(v.commission * 100, 0)}
                          </td>
                          <td
                            className={`py-2 pr-3 text-right tabular-nums ${uptimeColorClass(v.uptime)}`}
                          >
                            {v.uptime == null
                              ? "—"
                              : formatPercentage(v.uptime * 100, 2)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-osmo-100">
                            {v.longRunUptime == null
                              ? "—"
                              : formatPercentage(v.longRunUptime, 2)}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums text-osmo-100">
                            {v.govVotesLast10 == null
                              ? "—"
                              : `${v.govVotesLast10}/10`}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {v.timesSlashed == null ? (
                              <span className="text-osmo-300">—</span>
                            ) : v.timesSlashed > 0 ? (
                              <span className="text-amber-300">
                                {v.timesSlashed}
                              </span>
                            ) : (
                              <span className="text-osmo-300">0</span>
                            )}
                          </td>
                        </tr>
                        {markerColor && (
                          <tr>
                            <td colSpan={9} className="p-0">
                              <div
                                className="border-t-2 border-dashed"
                                style={{ borderColor: markerColor }}
                              />
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

      {/* Pending undelegations — next 14 days */}
      <Card liftOnHover>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle as="h2">Pending Undelegations</CardTitle>
              <p className="mt-1 text-sm text-osmo-200">
                OSMO completing its unbonding period.
              </p>
            </div>
            {undelegations != null && (
              <div className="shrink-0 text-right">
                <div className="text-2xl font-bold text-[#7C4DFF] sm:text-3xl">
                  {formatNumberWithCommas(undelegations.total, 0)}
                </div>
                <div className="text-xs text-osmo-200">
                  OSMO total unbonding
                </div>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {undelegationsLoading ? (
            <div className="flex min-h-[320px] items-center justify-center text-osmo-200">
              Loading unbonding schedule…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <BarChart
                data={unbondingData}
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
                  formatter={(value: number) => [
                    `${formatNumberWithCommas(value, 0)} OSMO`,
                    "",
                  ]}
                />
                <Bar dataKey="amount" fill={BAR_FILL} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Block rate — network performance (seconds per block), history from the
          SmartStake import; the cron computes it from daily block-height deltas. */}
      <MetricLineChart
        title="Block Rate"
        subtitle="Average seconds per block over time — Osmosis has fallen from ~6s to ~1.1s."
        data={historicalData}
        dataKey="blockRate"
        color="#81C784"
        unit="s"
        decimals={2}
      />
    </div>
  );
}
