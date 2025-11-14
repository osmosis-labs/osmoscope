"use client";

import { useOsmosisMetrics } from "@/lib/hooks/useOsmosisMetrics";
import { TokenBalancesChart } from "./charts/TokenBalancesChart";
import { InflationRatesChart } from "./charts/InflationRatesChart";
import { BurnChart } from "./charts/BurnChart";
import { FeeFlowChart } from "./charts/FeeFlowChart";
import { StakingAprChart } from "./charts/StakingAprChart";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/Card";
import { formatPercentage, formatNumberWithCommas } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { useEffect, useState } from "react";
import type { HistoricalRecord } from "@/lib/historical-file";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";

export function OsmosisDashboard() {
  const { data, isLoading, error } = useOsmosisMetrics();
  const [historicalData, setHistoricalData] = useState<HistoricalRecord[]>([]);

  // Fetch historical data
  useEffect(() => {
    async function fetchHistory() {
      try {
        const response = await fetch("/api/history");
        if (response.ok) {
          const history = await response.json();
          setHistoricalData(history);
        }
      } catch (error) {
        logger.error("Failed to fetch historical data:", error);
      }
    }
    fetchHistory();
  }, []);

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
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <div className="rounded-lg bg-red-500/20 p-6 text-center">
          <p className="mb-2 text-lg font-semibold text-white">
            Failed to load Osmosis metrics
          </p>
          <p className="text-sm text-red-200">
            {error instanceof Error ? error.message : "Unknown error"}
          </p>
          <p className="mt-4 text-xs text-osmo-100">
            Please check your internet connection and try again
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="space-y-6">
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
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between">
              <CardTitle>OSMO Burned (%)</CardTitle>
              <div className="text-right">
                <div className="text-3xl font-bold text-[#FF6B6B]">
                  {formatPercentage((data.burned / data.circulating) * 100)}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex items-center justify-center p-1">
            <ResponsiveContainer width="100%" height={380}>
              <PieChart>
                <Pie
                  data={[
                    { name: "Burned", value: data.burned },
                    { name: "Circulating Supply", value: data.circulating },
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
            </ResponsiveContainer>
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

      {/* Staking APR Chart */}
      <StakingAprChart
        currentApr={data.stakingApr}
        historicalData={historicalData}
      />

      {/* Coming Soon - Future Charts */}
      {/* Temporarily disabled
      <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle>Taker Fee Composition</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-center min-h-[300px]">
            <div className="text-center">
              <div className="mb-4 text-6xl">📊</div>
              <div className="text-xl font-semibold text-white mb-2">Coming Soon</div>
              <div className="text-sm text-osmo-200">
                Breakdown of taker fees by asset
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>ProtoRev Composition</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-center min-h-[300px]">
            <div className="text-center">
              <div className="mb-4 text-6xl">📊</div>
              <div className="text-xl font-semibold text-white mb-2">Coming Soon</div>
              <div className="text-sm text-osmo-200">
                Breakdown of ProtoRev by asset
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Protocol Revenue Over Time</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-center min-h-[300px]">
            <div className="text-center">
              <div className="mb-4 text-6xl">📈</div>
              <div className="text-xl font-semibold text-white mb-2">Coming Soon</div>
              <div className="text-sm text-osmo-200">
                Historical revenue from all sources
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Community Pool Holdings</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-center min-h-[300px]">
            <div className="text-center">
              <div className="mb-4 text-6xl">🏦</div>
              <div className="text-xl font-semibold text-white mb-2">Coming Soon</div>
              <div className="text-sm text-osmo-200">
                Breakdown of community pool assets
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      */}

      {/* Footer Info */}
      <div className="rounded-lg bg-white/5 p-4 text-center text-sm text-osmo-100">
        <p>
          Data Sources:{" "}
          <a
            href="https://lcd.osmosis.zone/swagger"
            target="_blank"
            rel="noopener noreferrer"
            className="text-osmo-purple underline hover:text-white"
          >
            Osmosis Chain
          </a>{" "}
          •{" "}
          <a
            href="https://www.numia.xyz/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-osmo-purple underline hover:text-white"
          >
            Numia
          </a>
        </p>
        <p className="mt-2">
          Last updated:{" "}
          {new Date(data.timestamp).toLocaleString("en-GB", {
            hour12: false,
          })}
        </p>
      </div>
    </div>
  );
}
