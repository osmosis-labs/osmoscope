"use client";

import {
  ComposedChart,
  Area,
  Line,
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
  formatPercentage,
  formatChartDate,
  makeMonthlyTicks,
} from "@/lib/utils";
import type { HistoricalRecord } from "@/lib/historical-file";
import { useState, useRef } from "react";
import { TimeRange, filterDataByTimeRange } from "../TimeRangeSelector";
import { ChartHeader } from "./ChartHeader";

interface StakingRatioChartProps {
  stakingRatio: number | null;
  historicalData: HistoricalRecord[];
}

// Bonded OSMO over time, plus the staking ratio (bonded / total supply). The
// ratio uses total supply (not circulating) so it matches the conventional PoS
// bond ratio and the KPI tile — totalStaked includes restricted-entity stake,
// which is excluded from circulating, so dividing by circulating would mix bases.
export function StakingRatioChart({
  stakingRatio,
  historicalData,
}: StakingRatioChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");

  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Only plot days that have both bonded total and total supply, so the ratio is
  // well-defined; days missing totalStaked (early/upgrade windows) are dropped
  // rather than rendered as a 0 dip.
  const plotted = filteredData.filter(
    (r) => r.totalStaked != null && r.totalStaked > 0 && r.totalSupply > 0
  );

  const chartData = plotted.map((record) => ({
    date: formatChartDate(record.timestamp, timeRange),
    "Staked OSMO": record.totalStaked as number,
    "Staked %": ((record.totalStaked as number) / record.totalSupply) * 100,
  }));

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <ChartHeader
          title="Staking Ratio"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename="osmo-staking-ratio"
          headlineValue={
            stakingRatio != null ? formatPercentage(stakingRatio, 2) : "—"
          }
          headlineLabel="of total supply staked"
          headlineColor="text-[#4FC3F7]"
        />
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center text-osmo-200">
            No staking data available for this range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart data={chartData}>
              <defs>
                <linearGradient id="colorStaked" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#7C4DFF" stopOpacity={0.5} />
                  <stop offset="95%" stopColor="#7C4DFF" stopOpacity={0.05} />
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
                  plotted.map((r) => r.timestamp),
                  timeRange
                )}
                angle={-45}
                textAnchor="end"
                height={80}
              />
              {/* Left axis: bonded OSMO. */}
              <YAxis
                yAxisId="osmo"
                stroke="#fff"
                tick={{ fill: "#e0d5f5" }}
                tickFormatter={(value) => formatNumber(value, 0)}
              />
              {/* Right axis: staking ratio %. */}
              <YAxis
                yAxisId="pct"
                orientation="right"
                stroke="#4FC3F7"
                tick={{ fill: "#4FC3F7" }}
                tickFormatter={(value) => `${Math.round(value)}%`}
                domain={[0, "auto"]}
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
                formatter={(value: number, name: string) =>
                  name === "Staked %"
                    ? [formatPercentage(value, 2), name]
                    : [formatNumberWithCommas(value) + " OSMO", name]
                }
              />
              <Area
                yAxisId="osmo"
                type="monotone"
                dataKey="Staked OSMO"
                stroke="#7C4DFF"
                strokeWidth={2}
                fill="url(#colorStaked)"
              />
              <Line
                yAxisId="pct"
                type="monotone"
                dataKey="Staked %"
                stroke="#4FC3F7"
                strokeWidth={2}
                dot={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
