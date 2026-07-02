"use client";

import { Card } from "./ui/Card";
import { formatNumber, formatUsdOrDash, formatPercentage } from "@/lib/utils";
import type { OsmosisMetrics } from "@/types/osmosis";

// Format a small spot price with enough precision to be meaningful (OSMO trades
// well under $1, so 4 significant decimals). Falls back to a dash when unknown.
function formatPrice(price: number | null): string {
  if (price == null) return "—";
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toPrecision(4)}`;
}

// Signed percentage for a 24h change, e.g. "+4.10%" / "-1.23%".
function formatSignedPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

interface Kpi {
  label: string;
  value: string;
  sub?: string;
  // Tailwind text-color class for the sub line (used to color the 24h change).
  subColor?: string;
}

interface KpiSummaryProps {
  data: OsmosisMetrics;
}

// Top-of-page headline strip: the numbers a tokenomics visitor expects first
// (price, market cap, FDV, staking ratio, net inflation). Price-dependent KPIs
// show "—" when the price feed is unavailable rather than a misleading $0.
export function KpiSummary({ data }: KpiSummaryProps) {
  const kpis: Kpi[] = [
    {
      label: "OSMO Price",
      value: formatPrice(data.price),
      sub:
        data.price24hChange != null
          ? `${formatSignedPct(data.price24hChange)} 24h`
          : undefined,
      subColor:
        data.price24hChange != null
          ? data.price24hChange >= 0
            ? "text-[#81C784]"
            : "text-[#E57373]"
          : undefined,
    },
    {
      label: "Market Cap",
      value: formatUsdOrDash(data.marketCap),
      sub: "price × circulating",
    },
    {
      label: "FDV",
      value: formatUsdOrDash(data.fdv),
      sub: "price × total supply",
    },
    {
      label: "Staked",
      value:
        data.stakingRatio != null
          ? formatPercentage(data.stakingRatio, 2)
          : "—",
      sub: `${formatNumber(data.totalStaked)} OSMO of total`,
    },
    {
      label: "Staking APR",
      value: formatPercentage(data.stakingApr90dAvg, 2),
      sub: "Last 90 days",
    },
    {
      label: "Net Inflation",
      value: formatPercentage(data.netInflation90dAvg, 2),
      sub: "Last 90 days",
    },
  ];

  return (
    <section aria-label="Key metrics">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((kpi) => (
          <Card key={kpi.label} className="p-4">
            <div className="text-xs uppercase tracking-wide text-osmo-200">
              {kpi.label}
            </div>
            <div className="mt-1 text-2xl font-bold text-white">
              {kpi.value}
            </div>
            {kpi.sub && (
              <div
                className={`mt-0.5 text-xs ${kpi.subColor ?? "text-osmo-100"}`}
              >
                {kpi.sub}
              </div>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}
