"use client";

import { useOsmosisMetrics } from "@/lib/hooks/useOsmosisMetrics";
import { useHistoricalData } from "@/lib/hooks/useHistoricalData";
import { TokenBalancesChart } from "./charts/TokenBalancesChart";
import { InflationRatesChart } from "./charts/InflationRatesChart";
import { BurnChart } from "./charts/BurnChart";
import { FeeFlowChart } from "./charts/FeeFlowChart";
import { ProtocolRevenueChart } from "./charts/ProtocolRevenueChart";
import { StakingAprChart } from "./charts/StakingAprChart";
import { KpiSummary } from "./KpiSummary";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { formatPercentage, formatNumberWithCommas } from "@/lib/utils";
import { useRef } from "react";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { ScreenshotButtons } from "./ScreenshotButtons";

export function OsmosisDashboard() {
  const { data, isLoading, error } = useOsmosisMetrics();
  const {
    data: historicalData = [],
    error: historyError,
    isLoading: historyLoading,
  } = useHistoricalData();
  const burnedPieChartRef = useRef<HTMLDivElement>(null);

  if (isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 animate-spin rounded-full border-4 border-osmo-purple border-t-transparent"></div>
          <p className="text-white">Loading Osmosis metrics...</p>
        </div>
      </div>
    );
  }

  if (error) {
    // The metrics endpoint 503s (via the hook) when no snapshot has been captured
    // yet — a "pending" state, not a failure. Show a friendly message for that.
    const pending =
      error instanceof Error &&
      error.message === "No snapshot data available yet";
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div
          className={`rounded-lg p-6 text-center ${pending ? "bg-white/10" : "bg-red-500/20"}`}
        >
          <p className="mb-2 text-lg font-semibold text-white">
            {pending ? "Metrics pending" : "Failed to load Osmosis metrics"}
          </p>
          <p
            className={`text-sm ${pending ? "text-osmo-200" : "text-red-200"}`}
          >
            {pending
              ? "The first daily snapshot has not been taken yet. Check back shortly."
              : error instanceof Error
                ? error.message
                : "Unknown error"}
          </p>
          {!pending && (
            <p className="mt-4 text-xs text-osmo-100">
              Please check your internet connection and try again
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  // The charts below all read historicalData. If it failed to load (the KPI
  // strip comes from a different endpoint and may be fine), the charts would
  // render empty with no explanation — surface a banner instead of silently
  // showing flat/blank charts.
  const historyUnavailable = !historyLoading && !!historyError;

  return (
    <div className="space-y-6">
      {/* KPI summary strip */}
      <KpiSummary data={data} />

      {historyUnavailable && (
        <div className="rounded-lg bg-amber-500/10 p-3 text-center text-sm text-amber-200">
          Historical data is currently unavailable, so the charts below may be
          empty. The headline metrics above are unaffected.
        </div>
      )}

      {/* OSMO Inflation (full width) */}
      <div className="grid gap-6">
        <InflationRatesChart
          inflationRate={data.inflationRate}
          burnRate={data.burnRate}
          netInflation={data.netInflation}
          historicalData={historicalData}
        />
      </div>

      {/* Row: OSMO Burned doughnut and line chart */}
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card ref={burnedPieChartRef}>
          <CardHeader>
            <div className="flex items-start justify-between">
              <div className="flex flex-col items-start gap-2">
                <CardTitle as="h2">OSMO Burned (%)</CardTitle>
                <ScreenshotButtons
                  targetRef={burnedPieChartRef}
                  filename="osmo-burned-percentage"
                  shareText="Share of OSMO supply burned"
                />
              </div>
              <div className="text-right">
                <div className="text-3xl font-bold text-[#FF6B6B]">
                  {data.mintedSupply > 0
                    ? formatPercentage((data.burned / data.mintedSupply) * 100)
                    : "—"}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="relative flex items-center justify-center p-1">
            {/* Burn as a share of TOTAL MINTED OSMO (everything ever created),
                not circulating — burned OSMO was minted then destroyed, so minted
                is the correct base; circulating already excludes it and would
                overstate the ratio. The doughnut pairs burned vs the unburned
                remainder (minted − burned = current total supply). */}
            <div
              className="w-full"
              role="img"
              aria-label={`OSMO burned as a share of total minted supply: ${formatNumberWithCommas(
                data.burned
              )} OSMO burned (${
                data.mintedSupply > 0
                  ? formatPercentage((data.burned / data.mintedSupply) * 100)
                  : "n/a"
              }) of ${formatNumberWithCommas(data.mintedSupply)} OSMO ever minted.`}
            >
              <ResponsiveContainer width="100%" height={380}>
                {data.mintedSupply > 0 ? (
                  <PieChart>
                    <Pie
                      data={[
                        { name: "Burned", value: data.burned },
                        {
                          name: "Unburned Supply",
                          value: Math.max(data.mintedSupply - data.burned, 0),
                        },
                      ]}
                      cx="50%"
                      cy="50%"
                      innerRadius="40%"
                      outerRadius="85%"
                      paddingAngle={2}
                      dataKey="value"
                    >
                      <Cell fill="#FF6B6B" />
                      <Cell fill="#95E1D3" />
                    </Pie>
                    <Tooltip
                      formatter={(value: number) =>
                        formatNumberWithCommas(value) + " OSMO"
                      }
                      contentStyle={{
                        backgroundColor: "rgba(31, 10, 41, 0.95)",
                        backdropFilter: "blur(12px)",
                        border: "1px solid rgba(255, 255, 255, 0.2)",
                        borderRadius: "8px",
                        boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
                      }}
                      labelStyle={{ color: "#fff" }}
                      itemStyle={{ color: "#fff" }}
                    />
                  </PieChart>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-osmo-300">
                    Supply data unavailable
                  </div>
                )}
              </ResponsiveContainer>
            </div>
            {/* OSMO icon in center of doughnut (decorative) */}
            <div
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
              aria-hidden="true"
            >
              <img
                src="/Osmosis_Icon.png"
                alt=""
                className="h-36 w-36 opacity-80"
                style={{ transform: "translate(-2%, 2%)" }}
              />
            </div>
          </CardContent>
        </Card>
        <BurnChart burned={data.burned} historicalData={historicalData} />
      </div>

      {/* Row: Circulating Supply (full width) */}
      <div className="grid gap-6">
        <TokenBalancesChart
          burned={data.burned}
          totalSupply={data.totalSupply}
          circulating={data.circulating}
          historicalData={historicalData}
        />
      </div>

      {/* Fee Flow Chart */}
      <FeeFlowChart historicalData={historicalData} />

      {/* Protocol Revenue Over Time */}
      <ProtocolRevenueChart historicalData={historicalData} />

      {/* Staking APR Chart */}
      <StakingAprChart
        currentApr={data.stakingApr}
        historicalData={historicalData}
      />

      {/* Footer Info */}
      <footer className="rounded-lg bg-white/5 p-4 text-center text-sm text-osmo-100">
        <p>
          Data Sources:{" "}
          <a
            href="https://lcd.osmosis.zone/swagger"
            target="_blank"
            rel="noopener noreferrer"
            className="text-osmo-300 underline hover:text-white"
          >
            Osmosis Chain
          </a>{" "}
          •{" "}
          <a
            href="https://www.numia.xyz/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-osmo-300 underline hover:text-white"
          >
            Numia
          </a>
        </p>
        <p className="mt-2">
          Onchain data snapshot as of{" "}
          {new Date(data.timestamp).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          . Market data is live.
        </p>
      </footer>
    </div>
  );
}
