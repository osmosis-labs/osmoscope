"use client";

import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  TooltipProps,
  Area,
  AreaChart,
} from "recharts";
import type { HistoricalRecord } from "@/lib/historical-file";
import { formatPercentage } from "@/lib/utils";
import {
  TimeRangeSelector,
  TimeRange,
  filterDataByTimeRange,
} from "../TimeRangeSelector";

// Custom tooltip component for APR breakdown
function CustomTooltip({
  active,
  payload,
  label,
}: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0].payload as Record<string, number | null>;
  const stakingApr = data["Staking APR"];
  const inflationApr = data["Inflation APR"];
  const revenueApr = data["Revenue APR"];

  return (
    <div
      style={{
        backgroundColor: "rgba(31, 10, 41, 0.95)",
        backdropFilter: "blur(12px)",
        border: "1px solid rgba(255, 255, 255, 0.2)",
        borderRadius: "8px",
        padding: "12px",
        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
      }}
    >
      <p style={{ color: "#fff", marginBottom: "8px", fontWeight: "500" }}>
        {label}
      </p>
      {stakingApr != null && (
        <>
          <p
            style={{ color: "#9C27B0", marginBottom: "4px", fontWeight: "600" }}
          >
            Total APR: {stakingApr.toFixed(2)}%
          </p>
          {inflationApr != null && revenueApr != null && (
            <>
              <p
                style={{
                  color: "#fff",
                  fontSize: "12px",
                  paddingLeft: "8px",
                  marginBottom: "2px",
                }}
              >
                ↳ Revenue APR: {revenueApr.toFixed(2)}%
              </p>
              <p
                style={{ color: "#fff", fontSize: "12px", paddingLeft: "8px" }}
              >
                ↳ Inflation APR: {inflationApr.toFixed(2)}%
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface StakingAprChartProps {
  currentApr: number;
  historicalData: HistoricalRecord[];
}

export function StakingAprChart({
  currentApr,
  historicalData,
}: StakingAprChartProps) {
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");

  // Filter data based on selected time range
  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  const chartData = useMemo(() => {
    if (filteredData.length === 0) {
      return [];
    }

    return filteredData.map((record) => {
      // Use raw staking APR from record
      const rawApr = record.stakingApr || null;

      // Calculate raw inflation APR for this specific day
      let inflationApr = null;
      if (
        record.inflationRate != null &&
        record.totalSupply != null &&
        record.totalStaked != null &&
        record.totalStaked > 0 &&
        record.distributionProportions?.staking
      ) {
        const stakingProportion = parseFloat(
          record.distributionProportions.staking
        );
        const developerProportion = parseFloat(
          record.distributionProportions.developerRewards || "0"
        );
        const poolIncentivesProportion = parseFloat(
          record.distributionProportions.poolIncentives || "0"
        );

        // Total circulating emissions proportion (excludes community pool)
        const circulatingProportion =
          stakingProportion + developerProportion + poolIncentivesProportion;

        // OSMO issued to stakers per year = (stakingProportion / circulatingProportion) × inflationRate × totalSupply
        const osmoToStakersPerYear =
          (stakingProportion / circulatingProportion) *
          (record.inflationRate / 100) *
          record.totalSupply;

        // APR = (osmoToStakersPerYear / totalStaked) × 100
        inflationApr = (osmoToStakersPerYear / record.totalStaked) * 100;
      }

      // Calculate revenue APR as difference
      const revenueApr =
        rawApr != null && inflationApr != null ? rawApr - inflationApr : null;

      return {
        date: new Date(record.timestamp).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
        }),
        "Staking APR": rawApr,
        "Inflation APR": inflationApr,
        "Revenue APR": revenueApr,
      };
    });
  }, [filteredData]);

  // Calculate headline APR from the filtered time range
  const averageApr = useMemo(() => {
    if (filteredData.length === 0) return currentApr;

    let sum = 0;
    let count = 0;

    for (const record of filteredData) {
      const apr = record.stakingApr;
      if (apr != null) {
        sum += apr;
        count++;
      }
    }

    return count > 0 ? sum / count : currentApr;
  }, [filteredData, currentApr]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <CardTitle>Staking APR</CardTitle>
            <TimeRangeSelector
              selectedRange={timeRange}
              onRangeChange={setTimeRange}
            />
          </div>
          <div className="text-right">
            <div className="text-3xl font-bold text-[#9C27B0]">
              {formatPercentage(averageApr)}
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={chartData}>
            <defs>
              <linearGradient
                id="inflationGradient"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="5%" stopColor="#7B1FA2" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#7B1FA2" stopOpacity={0.3} />
              </linearGradient>
              <linearGradient id="revenueGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#9C27B0" stopOpacity={0.8} />
                <stop offset="95%" stopColor="#9C27B0" stopOpacity={0.3} />
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
            <YAxis hide />
            <Tooltip content={<CustomTooltip />} />
            <Area
              type="monotone"
              dataKey="Inflation APR"
              stackId="1"
              stroke="#7B1FA2"
              fill="url(#inflationGradient)"
              strokeWidth={2}
            />
            <Area
              type="monotone"
              dataKey="Revenue APR"
              stackId="1"
              stroke="#9C27B0"
              fill="url(#revenueGradient)"
              strokeWidth={2}
            />
            <Line
              type="monotone"
              dataKey="Staking APR"
              stroke="#E1BEE7"
              strokeWidth={2}
              dot={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
