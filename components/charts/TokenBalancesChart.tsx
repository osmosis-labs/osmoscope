"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader } from "../ui/Card";
import {
  formatNumber,
  formatNumberWithCommas,
  formatChartDate,
  makeMonthlyTicks,
} from "@/lib/utils";
import type { HistoricalRecord } from "@/lib/historical-file";
import { useState, useRef } from "react";
import { TimeRange, filterDataByTimeRange } from "../TimeRangeSelector";
import { ChartHeader } from "./ChartHeader";
import { InfoTooltip } from "../ui/InfoTooltip";

// The stacked series (bottom to top) with a plain-English explainer of what each
// represents. These distinctions are genuinely non-obvious — total vs circulating,
// what "restricted" folds in, where dev-vesting sits — so each gets a `?` hover.
// Colors match the <Area> strokes below.
const SERIES_LEGEND = [
  {
    label: "Circulating Supply",
    color: "#7C4DFF",
    explainer:
      "The public float: OSMO freely tradable and transferable. Computed as total supply minus restricted and community-pool balances. This is the figure most price/market-cap calculations use.",
  },
  {
    label: "Restricted Supply",
    color: "#9E9E9E",
    explainer:
      "OSMO excluded from circulating: the unvested developer-vesting allocation plus foundation and strategic-reserve wallets (their liquid and staked balances). Not freely tradable, so it's held out of circulating supply.",
  },
  {
    label: "Community Supply",
    color: "#2994D0",
    explainer:
      "The on-chain community pool balance, governed by community-pool spend proposals. Funded by a share of inflation, taker fees and pool-creation fees. Held separate from circulating supply.",
  },
] as const;

// Extra context surfaced on the headline, since Total/Minted aren't their own
// stacked bands but matter for reading the chart.
interface TokenBalancesChartProps {
  burned: number;
  totalSupply: number;
  circulating: number;
  historicalData: HistoricalRecord[];
}

export function TokenBalancesChart({
  burned: _burned,
  totalSupply: _totalSupply,
  circulating,
  historicalData,
}: TokenBalancesChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  // A tooltip popover would otherwise be clipped under the NEXT card: Card has
  // backdrop-blur, which creates a stacking context, so the tooltip's own z-index
  // can't beat a later sibling card. Fix (same as the treasury cards): lift the
  // WHOLE card's z-index while any explainer is open. `openCount` tracks how many
  // are open so overlapping hover/focus don't prematurely drop the lift.
  const [openCount, setOpenCount] = useState(0);
  const anyTipOpen = openCount > 0;

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Transform historical data for the chart. Use ?? (not ||) so a legitimate 0
  // survives, and leave an intentionally-unset circulating (nullable for the 2023
  // upgrade window) as null.
  //
  // These three series share a stackId, and Recharts treats a null band as 0 for
  // the STACK OFFSET — so a row with some (but not all) series present would make
  // the stacked total dip rather than show a true gap. Guard by dropping any row
  // that doesn't have all three defined (today no live row is partially-null, but
  // this future-proofs it), mirroring how StakingApr/StakingRatio filter first.
  // Carry the raw timestamp through the map so it survives the filter: the
  // monthly-tick builder needs labels and timestamps to stay index-aligned, and
  // sourcing timestamps from the UNFILTERED filteredData while labels come from
  // this (possibly shorter) list would mispair them once any row is dropped.
  const chartData = filteredData
    .map((record) => ({
      date: formatChartDate(record.timestamp, timeRange),
      timestamp: record.timestamp,
      "Circulating Supply":
        record.circulatingSupply ?? record.circulating ?? null,
      "Restricted Supply": record.restrictedSupply ?? null,
      "Community Supply": record.communitySupply ?? null,
    }))
    .filter(
      (d) =>
        d["Circulating Supply"] != null &&
        d["Restricted Supply"] != null &&
        d["Community Supply"] != null
    );

  // Note: earlier versions annotated supply-offset "step-downs" (the 2024-11-19
  // v27 -83M reinstatement and a 2023-08 archive artifact). The history data is
  // now normalized onto the chain's current supply-offset methodology
  // (scripts/normalize-supply-offset.ts), so the series is continuous and those
  // markers no longer correspond to any step. They were removed.

  // Translate a tooltip's open/close into a running count, so the card's z-lift
  // stays raised while ANY explainer is open (a second tooltip opening before the
  // first closes must not drop the lift).
  const trackTip = (open: boolean) =>
    setOpenCount((n) => Math.max(0, n + (open ? 1 : -1)));

  return (
    <Card ref={cardRef} className={anyTipOpen ? "relative z-30" : undefined}>
      <CardHeader>
        <ChartHeader
          title="Supply Distribution"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename="osmo-supply-distribution"
          shareText="OSMO supply distribution over time"
          csvRows={() =>
            historicalData.map((r) => ({
              date: r.timestamp,
              circulating_supply: r.circulatingSupply ?? r.circulating ?? null,
              restricted_supply: r.restrictedSupply ?? null,
              community_supply: r.communitySupply ?? null,
              total_supply: r.totalSupply ?? null,
            }))
          }
          headlineValue={formatNumberWithCommas(circulating)}
          headlineLabel="Circulating"
          headlineColor="text-[#7C4DFF]"
        />
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart
            data={chartData}
            margin={{ top: 24, right: 8, left: 8, bottom: 0 }}
          >
            <defs>
              <linearGradient id="colorCirculating" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#7C4DFF" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#7C4DFF" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="colorRestricted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#9E9E9E" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#9E9E9E" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="colorCommunity" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2994D0" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#2994D0" stopOpacity={0.1} />
              </linearGradient>
            </defs>
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
              height={80}
            />
            <YAxis
              stroke="#fff"
              tick={{ fill: "#e0d5f5" }}
              tickFormatter={(value) => formatNumber(value, 0)}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: "rgba(31, 10, 41, 0.95)",
                backdropFilter: "blur(12px)",
                border: "1px solid rgba(255, 255, 255, 0.2)",
                borderRadius: "8px",
                boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
              }}
              labelStyle={{ color: "#fff" }}
              formatter={(value: number) =>
                formatNumberWithCommas(value) + " OSMO"
              }
            />
            <Area
              type="monotone"
              dataKey="Restricted Supply"
              stackId="1"
              stroke="#9E9E9E"
              strokeWidth={2}
              fill="url(#colorRestricted)"
            />
            <Area
              type="monotone"
              dataKey="Community Supply"
              stackId="1"
              stroke="#2994D0"
              strokeWidth={2}
              fill="url(#colorCommunity)"
            />
            <Area
              type="monotone"
              dataKey="Circulating Supply"
              stackId="1"
              stroke="#7C4DFF"
              strokeWidth={2}
              fill="url(#colorCirculating)"
            />
          </AreaChart>
        </ResponsiveContainer>
        {/* Custom legend with per-series explainers. The chart has no built-in
            Recharts <Legend>, and the series are otherwise only named in the
            hover tooltip — so this row both labels the bands and carries the `?`
            explainers for what each supply bucket actually means. */}
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-osmo-200">
          {SERIES_LEGEND.map((s) => (
            <span key={s.label} className="inline-flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: s.color }}
                aria-hidden
              />
              <span>{s.label}</span>
              <InfoTooltip
                text={s.explainer}
                ariaLabel={`About ${s.label}`}
                placement="top"
                onOpen={trackTip}
              />
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
