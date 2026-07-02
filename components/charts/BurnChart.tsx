"use client";

import {
  LineChart,
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

export function BurnChart({ burned, historicalData }: BurnChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("1y");

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Transform historical data for the chart
  const chartData = filteredData.map((record) => ({
    date: formatChartDate(record.timestamp, timeRange),
    "OSMO Burned": record.burnedSupply || record.burned || 0,
  }));

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <ChartHeader
          title="OSMO Burned"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename="osmo-burned"
          shareText="OSMO burned over time"
          csvRows={() =>
            historicalData.map((r) => ({
              date: r.timestamp,
              osmo_burned: r.burnedSupply ?? r.burned ?? null,
            }))
          }
          headlineValue={formatNumberWithCommas(burned)}
          headlineLabel="Total Burned"
          headlineColor="text-[#FF7043]"
        />
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
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
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
