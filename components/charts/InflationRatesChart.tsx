"use client";

import {
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  TooltipProps,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card";
import { formatPercentage } from "@/lib/utils";
import type { HistoricalRecord } from "@/lib/historical-file";
import { useState, useMemo, useRef } from "react";
import {
  TimeRangeSelector,
  TimeRange,
  filterDataByTimeRange,
} from "../TimeRangeSelector";
import { ScreenshotButtons } from "../ScreenshotButtons";

// Custom tooltip to show only one "Net Inflation" value
function CustomTooltip({
  active,
  payload,
  label,
}: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;

  const data = payload[0].payload as Record<string, number | null>;

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
      {data["Net Inflation"] != null && (
        <p
          style={{
            color: data["Net Inflation"] >= 0 ? "#E53935" : "#81C784",
            marginBottom: "4px",
          }}
        >
          Net Inflation: {formatPercentage(data["Net Inflation"])}
        </p>
      )}
      {data["Inflation Rate"] != null && (
        <p style={{ color: "#7C4DFF", marginBottom: "4px" }}>
          Inflation Rate: {formatPercentage(data["Inflation Rate"])}
        </p>
      )}
      {data["Burn Rate"] != null && (
        <p style={{ color: "#FF7043" }}>
          Burn Rate: {formatPercentage(data["Burn Rate"])}
        </p>
      )}
    </div>
  );
}

interface InflationRatesChartProps {
  inflationRate: number;
  burnRate: number;
  netInflation: number;
  historicalData: HistoricalRecord[];
}

export function InflationRatesChart({
  inflationRate,
  burnRate,
  netInflation,
  historicalData,
}: InflationRatesChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");

  // Memoize expensive chart data calculations
  const {
    chartData,
    averageInflationRate,
    averageBurnRate,
    averageNetInflation,
    hasNegativeNetInflation,
  } = useMemo(() => {
    // Filter data based on selected time range
    const filteredData = filterDataByTimeRange(historicalData, timeRange);

    // Transform historical data for the chart - use raw values instead of rolling averages
    // First pass: calculate all values
    const baseData = filteredData.map((record, index) => {
      // Use raw burn rate from the data if available, otherwise calculate daily burn rate
      let calculatedBurnRate = 0;
      if (index > 0 && record.totalSupply > 0) {
        const prevRecord = filteredData[index - 1];
        const burnChange =
          (record.burnedSupply || record.burned || 0) -
          (prevRecord.burnedSupply || prevRecord.burned || 0);
        const timeSpanMs =
          new Date(record.timestamp).getTime() -
          new Date(prevRecord.timestamp).getTime();
        const timeSpanDays = timeSpanMs / (1000 * 60 * 60 * 24);

        if (timeSpanDays > 0) {
          // Annualize the burn rate (daily change * 365 / total supply)
          const annualizedBurnChange = (burnChange / timeSpanDays) * 365;
          calculatedBurnRate =
            -(annualizedBurnChange / record.totalSupply) * 100;
        }
      }

      // Use raw inflation rate from the record
      const calculatedInflationRate = record.inflationRate || 0;
      const netInflationValue = calculatedInflationRate + calculatedBurnRate;

      return {
        date: new Date(record.timestamp).toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "short",
        }),
        inflationRate: calculatedInflationRate,
        burnRate: calculatedBurnRate,
        netInflation: netInflationValue,
      };
    });

    // Second pass: split into blue and orange lines
    // Rule: If current OR previous is negative → orange, if BOTH are positive → blue
    const chartData = baseData.map((data, index) => {
      const current = data.netInflation;
      const prev = index > 0 ? baseData[index - 1].netInflation : null;
      const next =
        index < baseData.length - 1 ? baseData[index + 1].netInflation : null;

      let netInflationPositive = null;
      let netInflationNegative = null;

      // Check if current or previous is negative
      const currentNegative = current < 0;
      const prevNegative = prev !== null && prev < 0;
      const currentOrPrevNegative = currentNegative || prevNegative;

      if (currentOrPrevNegative) {
        // Draw orange line
        netInflationNegative = current;

        // Special case: when transitioning from negative to positive,
        // also draw on blue line for continuity with next segment
        if (prev !== null && prev < 0 && current >= 0) {
          netInflationPositive = current;
        }
      } else {
        // Both current and previous are positive (or no previous) - draw blue line
        netInflationPositive = current;

        // Special case: if next point is negative (positive to negative transition),
        // also draw on orange line for continuity
        if (next !== null && next < 0) {
          netInflationNegative = current;
        }
      }

      return {
        date: data.date,
        "Inflation Rate": data.inflationRate,
        "Burn Rate": -data.burnRate, // Display as positive
        "Net Inflation": data.netInflation,
        "Net Inflation Positive": netInflationPositive,
        "Net Inflation Negative": netInflationNegative,
      };
    });

    // Calculate averages for headlines from the filtered time range
    let inflationSum = 0;
    let burnSum = 0;
    let netInflationSum = 0;
    let count = 0;
    let hasNegativeNetInflation = false;

    for (const data of baseData) {
      inflationSum += data.inflationRate;
      burnSum += data.burnRate;
      netInflationSum += data.netInflation;
      if (data.netInflation < 0) {
        hasNegativeNetInflation = true;
      }
      count++;
    }

    const averageInflationRate =
      count > 0 ? inflationSum / count : inflationRate;
    const averageBurnRate = count > 0 ? burnSum / count : burnRate;
    const averageNetInflation =
      count > 0 ? netInflationSum / count : netInflation;

    return {
      chartData,
      averageInflationRate,
      averageBurnRate,
      averageNetInflation,
      hasNegativeNetInflation,
    };
  }, [historicalData, timeRange, inflationRate, burnRate, netInflation]);

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>OSMO Inflation</CardTitle>
          <div className="flex items-center gap-4">
            <TimeRangeSelector
              selectedRange={timeRange}
              onRangeChange={setTimeRange}
            />
            <ScreenshotButtons targetRef={cardRef} filename="osmo-inflation" />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {/* Summary stats above chart */}
        <div className="mb-6 grid grid-cols-3 gap-4 border-b border-white/10 pb-4">
          <div className="text-center">
            <div
              className={`text-2xl font-bold ${hasNegativeNetInflation ? "text-[#81C784]" : "text-[#E53935]"}`}
            >
              {formatPercentage(averageNetInflation)}
            </div>
            <div className="text-sm text-osmo-100">Net Inflation</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-[#7C4DFF]">
              {formatPercentage(averageInflationRate)}
            </div>
            <div className="text-sm text-osmo-100">Inflation Rate</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-[#FF7043]">
              {formatPercentage(-averageBurnRate)}
            </div>
            <div className="text-sm text-osmo-100">Burn Rate</div>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={400}>
          <ComposedChart data={chartData}>
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
              tickFormatter={(value) => `${Math.round(value)}%`}
            />
            <Tooltip content={<CustomTooltip />} />
            <ReferenceLine y={0} stroke="#fff" strokeDasharray="3 3" />
            <Bar dataKey="Inflation Rate" fill="#7C4DFF" opacity={0.8} />
            <Bar dataKey="Burn Rate" fill="#FF7043" opacity={0.8} />
            <Line
              type="monotone"
              dataKey="Net Inflation Positive"
              stroke="#E53935"
              strokeWidth={3}
              dot={false}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="Net Inflation Negative"
              stroke="#81C784"
              strokeWidth={3}
              dot={false}
              connectNulls={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
