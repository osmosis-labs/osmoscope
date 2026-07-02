"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader } from "../ui/Card";
import {
  cn,
  formatCurrency,
  formatNumberWithCommas,
  formatChartDate,
  makeMonthlyTicks,
} from "@/lib/utils";
import type { HistoricalRecord } from "@/lib/historical-file";
import { useState, useRef } from "react";
import {
  TimeRange,
  filterDataByTimeRange,
  timeRangeLabel,
} from "../TimeRangeSelector";
import { ChartHeader } from "./ChartHeader";

// The four PROTOCOL-revenue sources we record per day (USD). Order = stack order
// (bottom to top) and legend order. Note: Numia's totalRevenue ALSO includes LP /
// swap-fee revenue, which accrues to liquidity providers, NOT the protocol — we
// intentionally exclude it here, so this chart and its headline reflect protocol
// revenue only (taker fees, ProtoRev, tx fees, top-of-block).
const SOURCES = [
  { key: "takerFeesRevenue", label: "Taker Fees", color: "#7C4DFF" },
  { key: "protorevRevenue", label: "ProtoRev", color: "#4FC3F7" },
  { key: "txnFeesRevenue", label: "Tx Fees", color: "#81C784" },
  { key: "mevRevenue", label: "Top of Block", color: "#FFB74D" },
] as const;

type RevenueMode = "standard" | "cumulative";

interface ProtocolRevenueChartProps {
  historicalData: HistoricalRecord[];
}

// Daily protocol revenue by source over time (stacked columns, USD), with a
// standard/cumulative toggle. Complements the FeeFlowChart (current flow) with
// the historical trend. Built from the revenue fields captured per snapshot.
export function ProtocolRevenueChart({
  historicalData,
}: ProtocolRevenueChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");
  const [mode, setMode] = useState<RevenueMode>("standard");

  const filteredData = filterDataByTimeRange(historicalData, timeRange);

  // Only days with a recorded total (revenue capture starts 2022-04); days
  // without it are dropped rather than rendered as a $0 column.
  const plotted = filteredData.filter((r) => r.totalRevenue != null);

  // Per-day protocol revenue per source (keyed by the SOURCES labels). In
  // cumulative mode each source carries a running total across the visible range.
  const protocolDaily = (r: HistoricalRecord) => ({
    "Taker Fees": r.takerFeesRevenue ?? 0,
    ProtoRev: r.protorevRevenue ?? 0,
    "Tx Fees": r.txnFeesRevenue ?? 0,
    "Top of Block": r.mevRevenue ?? 0,
  });
  const running: Record<string, number> = {
    "Taker Fees": 0,
    ProtoRev: 0,
    "Tx Fees": 0,
    "Top of Block": 0,
  };
  const chartData = plotted.map((record) => {
    const daily = protocolDaily(record);
    if (mode === "cumulative") {
      for (const k of Object.keys(daily) as (keyof typeof daily)[]) {
        running[k] += daily[k];
        daily[k] = running[k];
      }
    }
    return { date: formatChartDate(record.timestamp, timeRange), ...daily };
  });

  // Headline: total PROTOCOL revenue across the visible range (sum of the four
  // sources). We do NOT use Numia's totalRevenue here — that also includes LP /
  // swap-fee revenue, which is not protocol revenue. This makes the headline equal
  // the top of the stacked columns exactly.
  const rangeTotal = plotted.reduce((s, r) => {
    const d = protocolDaily(r);
    return s + d["Taker Fees"] + d.ProtoRev + d["Tx Fees"] + d["Top of Block"];
  }, 0);

  return (
    <Card ref={cardRef}>
      <CardHeader>
        <ChartHeader
          title="Protocol Revenue Over Time"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename="osmo-protocol-revenue-history"
          shareText="Osmosis protocol revenue over time"
          csvRows={() =>
            historicalData
              .filter((r) => r.totalRevenue != null)
              .map((r) => {
                const d = protocolDaily(r);
                return {
                  date: r.timestamp,
                  taker_fees_usd: d["Taker Fees"],
                  protorev_usd: d.ProtoRev,
                  tx_fees_usd: d["Tx Fees"],
                  top_of_block_usd: d["Top of Block"],
                  protocol_revenue_usd:
                    d["Taker Fees"] +
                    d.ProtoRev +
                    d["Tx Fees"] +
                    d["Top of Block"],
                };
              })
          }
          headlineValue={`$${formatNumberWithCommas(rangeTotal)}`}
          headlineLabel={timeRangeLabel(timeRange)}
          headlineColor="text-[#7C4DFF]"
          extraControls={
            <div
              className="flex gap-1 rounded-lg bg-white/5 p-1"
              data-screenshot-compact
            >
              {(["standard", "cumulative"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={cn(
                    "rounded px-3 py-1 text-xs font-medium capitalize transition-colors",
                    mode === m
                      ? "bg-osmo-purple text-white"
                      : "text-osmo-200 hover:text-white"
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          }
        />
      </CardHeader>
      <CardContent>
        {chartData.length === 0 ? (
          <div className="flex min-h-[400px] items-center justify-center text-osmo-200">
            No revenue data available for this range
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={400}>
            <BarChart data={chartData}>
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
              <YAxis
                stroke="#fff"
                tick={{ fill: "#e0d5f5" }}
                tickFormatter={(value) => formatCurrency(value, 0)}
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
                formatter={(value: number, name: string) => [
                  "$" + formatNumberWithCommas(value, 0),
                  name,
                ]}
              />
              <Legend wrapperStyle={{ color: "#e0d5f5" }} />
              {SOURCES.map((s) => (
                <Bar key={s.key} dataKey={s.label} stackId="1" fill={s.color} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
