"use client";

import {
  LineChart,
  Line,
  BarChart,
  Bar,
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

interface BurnChartProps {
  burned: number;
  historicalData: HistoricalRecord[];
}

// Cumulative burned per row (tolerating the older `burned` field name).
function burnedOf(r: HistoricalRecord): number | null {
  const v = r.burnedSupply ?? r.burned;
  return v == null ? null : Number(v);
}

export function BurnChart({ burned, historicalData }: BurnChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("1y");
  // "cumulative" = total burned to date (a rising line); "daily" = the per-day
  // amount burned (the difference between consecutive days, as bars). They're
  // the same measure integrated vs differenced, but ~1000x apart in scale, so
  // each gets its own view/axis rather than a forbidden dual-axis overlay.
  const [view, setView] = useState<"cumulative" | "daily">("cumulative");

  // Daily burn deltas computed over the FULL series (so the first visible day
  // still has a correct delta vs the prior day), then filtered to the range.
  // Rows missing a cumulative value are skipped; a negative delta (a supply
  // re-mint or data blip) is floored to 0 so it doesn't render a downward bar.
  const dailyAll: { timestamp: string; daily: number }[] = [];
  let prevBurned: number | null = null;
  for (const r of historicalData) {
    const b = burnedOf(r);
    if (b == null) continue;
    if (prevBurned != null) {
      dailyAll.push({
        timestamp: r.timestamp,
        daily: Math.max(0, b - prevBurned),
      });
    }
    prevBurned = b;
  }

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);
  const cumulativeData = filteredData.map((record) => ({
    date: formatChartDate(record.timestamp, timeRange),
    "OSMO Burned": burnedOf(record) ?? 0,
  }));
  const dailyFiltered = filterDataByTimeRange(dailyAll, timeRange);
  const dailyData = dailyFiltered.map((d) => ({
    date: formatChartDate(d.timestamp, timeRange),
    timestamp: d.timestamp,
    "Daily Burn": d.daily,
  }));
  const avgDaily = dailyFiltered.length
    ? dailyFiltered.reduce((s, d) => s + d.daily, 0) / dailyFiltered.length
    : 0;

  const isDaily = view === "daily";

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <ChartHeader
          title="OSMO Burned"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename={isDaily ? "osmo-burned-daily" : "osmo-burned"}
          shareText={isDaily ? "Daily OSMO burned" : "OSMO burned over time"}
          // Full history, both measures in every export regardless of the view or
          // selected range: cumulative burned to date + that day's burn.
          csvRows={() => {
            const dailyByDay = new Map(
              dailyAll.map((d) => [d.timestamp, d.daily])
            );
            return historicalData
              .filter((r) => burnedOf(r) != null)
              .map((r) => ({
                date: r.timestamp,
                cumulative_osmo_burned: Math.round(burnedOf(r) as number),
                daily_osmo_burned: dailyByDay.has(r.timestamp)
                  ? Math.round(dailyByDay.get(r.timestamp) as number)
                  : "",
              }));
          }}
          csvFilename="osmo-burned"
          extraControls={
            // Interactive-only toggle: dropped from screenshots like the
            // time-range selector (a live control reads oddly as a static image).
            <div
              className="flex rounded-lg bg-white/5 p-1 text-sm"
              data-screenshot-compact
            >
              {(
                [
                  { key: "cumulative", label: "Cumulative" },
                  { key: "daily", label: "Daily" },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setView(opt.key)}
                  className={`rounded-md px-3 py-1 font-medium transition-colors ${
                    view === opt.key
                      ? "bg-white/15 text-white"
                      : "text-osmo-200 hover:text-white"
                  }`}
                  aria-pressed={view === opt.key}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          }
          headlineValue={
            isDaily
              ? formatNumberWithCommas(avgDaily, 0)
              : formatNumberWithCommas(burned)
          }
          headlineLabel={isDaily ? "Avg / day (range)" : "Total Burned"}
          headlineColor="text-[#FF7043]"
        />
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          {isDaily ? (
            <BarChart data={dailyData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.1)"
              />
              <XAxis
                dataKey="date"
                stroke="#fff"
                tick={{ fill: "#e0d5f5" }}
                ticks={makeMonthlyTicks(
                  dailyData.map((d) => d.date),
                  dailyFiltered.map((d) => d.timestamp),
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
                cursor={{ fill: "rgba(255,255,255,0.06)" }}
                contentStyle={{
                  backgroundColor: "rgba(31, 10, 41, 0.95)",
                  backdropFilter: "blur(12px)",
                  border: "1px solid rgba(255, 255, 255, 0.2)",
                  borderRadius: "8px",
                  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                }}
                labelStyle={{ color: "#fff" }}
                formatter={(value: number) => [
                  formatNumberWithCommas(value) + " OSMO",
                  "Daily Burn",
                ]}
              />
              <Bar dataKey="Daily Burn" fill="#FF7043" radius={[4, 4, 0, 0]} />
            </BarChart>
          ) : (
            <LineChart data={cumulativeData}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.1)"
              />
              <XAxis
                dataKey="date"
                stroke="#fff"
                tick={{ fill: "#e0d5f5" }}
                ticks={makeMonthlyTicks(
                  cumulativeData.map((d) => d.date),
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
              <Line
                type="monotone"
                dataKey="OSMO Burned"
                stroke="#FF7043"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          )}
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
