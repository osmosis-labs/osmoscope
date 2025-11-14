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
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { formatNumber, formatNumberWithCommas } from "@/lib/utils";
import type { HistoricalRecord } from "@/lib/historical-file";
import { useState } from "react";
import {
  TimeRangeSelector,
  TimeRange,
  filterDataByTimeRange,
} from "../TimeRangeSelector";

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
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Transform historical data for the chart
  const chartData = filteredData.map((record) => {
    const circulatingSupply =
      record.circulatingSupply || record.circulating || 0;
    const restrictedSupply = record.restrictedSupply || 0;
    const communitySupply = record.communitySupply || 0;

    return {
      date: new Date(record.timestamp).toLocaleDateString("en-GB", {
        day: "2-digit",
        month: "short",
      }),
      "Circulating Supply": circulatingSupply,
      "Restricted Supply": restrictedSupply,
      "Community Supply": communitySupply,
    };
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <CardTitle>Supply Distribution</CardTitle>
            <TimeRangeSelector
              selectedRange={timeRange}
              onRangeChange={setTimeRange}
            />
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-[#95E1D3]">
              {formatNumberWithCommas(circulating)}
            </div>
            <div className="text-xs text-osmo-200">Circulating</div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient id="colorCirculating" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#95E1D3" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#95E1D3" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="colorRestricted" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#FF9800" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#FF9800" stopOpacity={0.1} />
              </linearGradient>
              <linearGradient id="colorCommunity" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#2196F3" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#2196F3" stopOpacity={0.1} />
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
              dataKey="Circulating Supply"
              stackId="1"
              stroke="#95E1D3"
              strokeWidth={2}
              fill="url(#colorCirculating)"
            />
            <Area
              type="monotone"
              dataKey="Restricted Supply"
              stackId="1"
              stroke="#FF9800"
              strokeWidth={2}
              fill="url(#colorRestricted)"
            />
            <Area
              type="monotone"
              dataKey="Community Supply"
              stackId="1"
              stroke="#2196F3"
              strokeWidth={2}
              fill="url(#colorCommunity)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
