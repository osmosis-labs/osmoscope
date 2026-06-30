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

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Transform historical data for the chart. Use ?? (not ||) so a legitimate 0
  // survives, and leave an intentionally-unset circulating (nullable for the 2023
  // upgrade window) as null — Recharts renders a gap, not a misleading 0 floor.
  const chartData = filteredData.map((record) => {
    const circulatingSupply =
      record.circulatingSupply ?? record.circulating ?? null;
    const restrictedSupply = record.restrictedSupply ?? null;
    const communitySupply = record.communitySupply ?? null;

    return {
      date: formatChartDate(record.timestamp, timeRange),
      "Circulating Supply": circulatingSupply,
      "Restricted Supply": restrictedSupply,
      "Community Supply": communitySupply,
    };
  });

  // Note: earlier versions annotated supply-offset "step-downs" (the 2024-11-19
  // v27 -83M reinstatement and a 2023-08 archive artifact). The history data is
  // now normalized onto the chain's current supply-offset methodology
  // (scripts/normalize-supply-offset.ts), so the series is continuous and those
  // markers no longer correspond to any step. They were removed.

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <ChartHeader
          title="Supply Distribution"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename="osmo-supply-distribution"
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
                filteredData.map((r) => r.timestamp),
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
      </CardContent>
    </Card>
  );
}
