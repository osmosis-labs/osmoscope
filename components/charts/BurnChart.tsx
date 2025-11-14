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
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { formatNumber, formatNumberWithCommas } from "@/lib/utils";
import type { HistoricalRecord } from "@/lib/historical-file";
import { useState, useRef } from "react";
import {
  TimeRangeSelector,
  TimeRange,
  filterDataByTimeRange,
} from "../TimeRangeSelector";
import { ScreenshotButtons } from "../ScreenshotButtons";

interface BurnChartProps {
  burned: number;
  historicalData: HistoricalRecord[];
}

export function BurnChart({ burned, historicalData }: BurnChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Transform historical data for the chart
  const chartData = filteredData.map((record) => ({
    date: new Date(record.timestamp).toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
    }),
    "OSMO Burned": record.burnedSupply || record.burned || 0,
  }));

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <CardTitle>OSMO Burned</CardTitle>
            <TimeRangeSelector
              selectedRange={timeRange}
              onRangeChange={setTimeRange}
            />
            <ScreenshotButtons targetRef={cardRef} filename="osmo-burned" />
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-[#FF7043]">
              {formatNumberWithCommas(burned)}
            </div>
            <div className="text-xs text-osmo-200">Total Burned</div>
          </div>
        </div>
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
