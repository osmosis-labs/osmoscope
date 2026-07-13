"use client";

import { Card, CardContent, CardHeader } from "../ui/Card";
import { useMemo, useState, useRef } from "react";
import type { HistoricalRecord } from "@/lib/historical-file";
import {
  TimeRange,
  filterDataByTimeRange,
  timeRangeLabel,
} from "../TimeRangeSelector";
import { ChartHeader } from "./ChartHeader";
import { formatUsd as formatUSD } from "@/lib/utils";

// Format a 0-1 proportion as a percentage label. Keeps one decimal so half-
// percent splits read correctly and sum to 100 (e.g. 22.5% / 25% / 52.5%),
// trimming a trailing ".0" so whole values stay clean (e.g. "30%").
function pct(proportion: number): string {
  const v = proportion * 100;
  const s = v.toFixed(1);
  return (s.endsWith(".0") ? s.slice(0, -2) : s) + "%";
}

// Assumptions for asset composition
const TAKER_FEES_OSMO_PERCENT = 0.5; // 50% OSMO
const PROTOREV_OSMO_PERCENT = 0.5; // 50% OSMO
const PROTOREV_MAINTAINER_PERCENT = 0.05; // 5% to maintainers

// Calculate revenue totals for the filtered time range
function calculateRevenueTotals(filteredData: HistoricalRecord[]) {
  // Get data with revenue information
  const recentData = filteredData.filter((r) => r.totalRevenue !== undefined);

  if (recentData.length === 0) {
    // Return null if no data available
    return null;
  }

  // Sum up the totals for the entire filtered range
  const totalTakerFees = recentData.reduce(
    (sum, r) => sum + (r.takerFeesRevenue || 0),
    0
  );
  const totalProtorev = recentData.reduce(
    (sum, r) => sum + (r.protorevRevenue || 0),
    0
  );
  const totalTxFees = recentData.reduce(
    (sum, r) => sum + (r.txnFeesRevenue || 0),
    0
  );
  const totalMev = recentData.reduce((sum, r) => sum + (r.mevRevenue || 0), 0);

  return {
    takerFees: totalTakerFees,
    protorev: totalProtorev,
    txFees: totalTxFees,
    topOfBlock: totalMev,
  };
}

interface FeeFlowNode {
  id: string;
  label: string;
  shortLabel?: string;
  value: number;
  color: string;
  level: number; // For positioning
}

interface FeeFlowLink {
  source: string;
  target: string;
  value: number;
  label: string;
}

interface FeeFlowChartProps {
  historicalData?: HistoricalRecord[];
}

export function FeeFlowChart({ historicalData = [] }: FeeFlowChartProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<TimeRange>("90d");

  // Show either the clicked node or the hovered node (clicked takes priority)
  const displayNode = selectedNode || hoveredNode;

  // Toggle a node's detail overlay (shared by click and keyboard).
  const toggleNode = (id: string) =>
    setSelectedNode((cur) => (cur === id ? null : id));
  // Enter/Space activate the node, matching native button behaviour.
  const onNodeKeyDown = (e: React.KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleNode(id);
    }
  };

  const {
    nodes,
    links: _links,
    osmoStakingPercent,
    osmoCommunityPercent,
    osmoBurnPercent,
    nonOsmoStakingPercent,
    nonOsmoCommunityPercent,
    nonOsmoBurnPercent,
    takerFeesOsmo,
    takerFeesNonOsmo,
    takerOsmoToStaking,
    takerOsmoToCommunity,
    takerOsmoToBurn,
    takerNonOsmoToStaking,
    takerNonOsmoToCommunity,
    takerNonOsmoToBurn,
    protorevOsmo,
    protorevNonOsmo,
    protorevOsmoToBurn,
    protorevNonOsmoToCommunity,
    txFeesToStaking,
    tobToCommunity,
    revenueAvgs,
  } = useMemo(() => {
    // Filter to the selected range INSIDE the memo: filterDataByTimeRange
    // returns a fresh array each call, so computing it outside and listing it as
    // a dep would defeat this (expensive) memo — it would recompute every render.
    const filteredData = filterDataByTimeRange(historicalData, timeRange);
    // Get the latest distribution parameters from historical data
    const latestRecord = historicalData[historicalData.length - 1];
    const osmoTakerDist = latestRecord?.osmoTakerFeeDistribution;
    const nonOsmoTakerDist = latestRecord?.nonOsmoTakerFeeDistribution;

    // Convert string percentages to numbers (they're stored as decimal strings like "0.33")
    const osmoStakingPercent = osmoTakerDist
      ? parseFloat(osmoTakerDist.stakingRewards)
      : 0.33;
    const osmoCommunityPercent = osmoTakerDist
      ? parseFloat(osmoTakerDist.communityPool)
      : 0.33;
    const osmoBurnPercent = osmoTakerDist
      ? parseFloat(osmoTakerDist.burn || "0.34")
      : 0.34;

    const nonOsmoStakingPercent = nonOsmoTakerDist
      ? parseFloat(nonOsmoTakerDist.stakingRewards)
      : 0;
    const nonOsmoCommunityPercent = nonOsmoTakerDist
      ? parseFloat(nonOsmoTakerDist.communityPool)
      : 1.0;
    const nonOsmoBurnPercent = nonOsmoTakerDist
      ? parseFloat(nonOsmoTakerDist.burn || "0")
      : 0;

    // Calculate revenue totals for the selected time range
    const revenueAvgs = calculateRevenueTotals(filteredData);

    // If no revenue data available, return null and handle in component
    if (!revenueAvgs) {
      return {
        nodes: [],
        links: [],
        osmoStakingPercent: 0,
        osmoCommunityPercent: 0,
        osmoBurnPercent: 0,
        nonOsmoStakingPercent: 0,
        nonOsmoCommunityPercent: 0,
        nonOsmoBurnPercent: 0,
        takerFeesOsmo: 0,
        takerFeesNonOsmo: 0,
        takerOsmoToStaking: 0,
        takerOsmoToCommunity: 0,
        takerOsmoToBurn: 0,
        takerNonOsmoToStaking: 0,
        takerNonOsmoToCommunity: 0,
        takerNonOsmoToBurn: 0,
        protorevOsmo: 0,
        protorevNonOsmo: 0,
        protorevOsmoToBurn: 0,
        protorevNonOsmoToCommunity: 0,
        txFeesToStaking: 0,
        tobToCommunity: 0,
        revenueAvgs: null,
      };
    }

    // Calculate flows using real revenue data
    const takerFeesOsmo = revenueAvgs.takerFees * TAKER_FEES_OSMO_PERCENT;
    const takerFeesNonOsmo =
      revenueAvgs.takerFees * (1 - TAKER_FEES_OSMO_PERCENT);

    const protorevTotal = revenueAvgs.protorev;
    const protorevToMaintainers = protorevTotal * PROTOREV_MAINTAINER_PERCENT;
    const protorevAfterMaintainers = protorevTotal - protorevToMaintainers;
    const protorevOsmo = protorevAfterMaintainers * PROTOREV_OSMO_PERCENT;
    const protorevNonOsmo =
      protorevAfterMaintainers * (1 - PROTOREV_OSMO_PERCENT);

    const txFees = revenueAvgs.txFees;
    const tobFees = revenueAvgs.topOfBlock;

    // Distribution using actual chain parameters
    // Taker fees OSMO: use actual distribution from chain
    const takerOsmoToStaking = takerFeesOsmo * osmoStakingPercent;
    const takerOsmoToCommunity = takerFeesOsmo * osmoCommunityPercent;
    const takerOsmoToBurn = takerFeesOsmo * osmoBurnPercent;

    // Taker fees non-OSMO: use actual distribution from chain
    const takerNonOsmoToStaking = takerFeesNonOsmo * nonOsmoStakingPercent;
    const takerNonOsmoToCommunity = takerFeesNonOsmo * nonOsmoCommunityPercent;
    const takerNonOsmoToBurn = takerFeesNonOsmo * nonOsmoBurnPercent;

    // ProtoRev OSMO: all burned
    const protorevOsmoToBurn = protorevOsmo;

    // ProtoRev non-OSMO: all to community pool
    const protorevNonOsmoToCommunity = protorevNonOsmo;

    // Transaction fees: 100% OSMO, distributed to staking
    const txFeesToStaking = txFees;

    // Top of Block: 100% to community pool
    const tobToCommunity = tobFees;

    // Calculate totals
    const totalToStaking =
      takerOsmoToStaking + takerNonOsmoToStaking + txFeesToStaking;
    const totalToCommunityPool =
      takerOsmoToCommunity +
      takerNonOsmoToCommunity +
      protorevNonOsmoToCommunity +
      tobToCommunity;
    const totalToBurn =
      takerOsmoToBurn + takerNonOsmoToBurn + protorevOsmoToBurn;

    const nodes: FeeFlowNode[] = [
      // Sources (Level 0)
      {
        id: "taker_fees",
        label: "Taker Fees",
        value: revenueAvgs.takerFees,
        color: "#F9A825",
        level: 0,
      },
      {
        id: "protorev",
        label: "ProtoRev",
        value: revenueAvgs.protorev,
        color: "#CA2EBD",
        level: 0,
      },
      {
        id: "tx_fees",
        label: "Transaction Fees",
        shortLabel: "Tx Fees",
        value: revenueAvgs.txFees,
        color: "#00ACC1",
        level: 0,
      },
      {
        id: "top_of_block",
        label: "Top of Block",
        shortLabel: "ToB",
        value: revenueAvgs.topOfBlock,
        color: "#AFB42B",
        level: 0,
      },

      // Intermediate splits (Level 1)
      {
        id: "taker_osmo",
        label: "Taker (OSMO)",
        value: takerFeesOsmo,
        color: "#FBC02D",
        level: 1,
      },
      {
        id: "taker_non_osmo",
        label: "Taker (Non-OSMO)",
        value: takerFeesNonOsmo,
        color: "#FDD835",
        level: 1,
      },
      {
        id: "protorev_maintainers",
        label: "ProtoRev Maintainers",
        value: protorevToMaintainers,
        color: "#E040FB",
        level: 1,
      },
      {
        id: "protorev_after_maintainers",
        label: "ProtoRev (After Maintainers)",
        value: protorevAfterMaintainers,
        color: "#D81B60",
        level: 1,
      },

      // ProtoRev splits (Level 2)
      {
        id: "protorev_osmo",
        label: "ProtoRev (OSMO)",
        value: protorevOsmo,
        color: "#C2185B",
        level: 2,
      },
      {
        id: "protorev_non_osmo",
        label: "ProtoRev (Non-OSMO)",
        value: protorevNonOsmo,
        color: "#AD1457",
        level: 2,
      },

      // Destinations (Level 3)
      {
        id: "staking",
        label: "Staking Rewards",
        value: totalToStaking,
        color: "#9C27B0",
        level: 3,
      },
      {
        id: "community_pool",
        label: "Community Pool",
        value: totalToCommunityPool,
        color: "#2994D0",
        level: 3,
      },
      {
        id: "burn",
        label: "Burn",
        value: totalToBurn,
        color: "#FF7043",
        level: 3,
      },
    ];

    const links: FeeFlowLink[] = [
      // Taker fees split
      {
        source: "taker_fees",
        target: "taker_osmo",
        value: takerFeesOsmo,
        label: "50% OSMO",
      },
      {
        source: "taker_fees",
        target: "taker_non_osmo",
        value: takerFeesNonOsmo,
        label: "50% Non-OSMO",
      },

      // Taker OSMO distribution
      {
        source: "taker_osmo",
        target: "staking",
        value: takerOsmoToStaking,
        label: pct(osmoStakingPercent),
      },
      {
        source: "taker_osmo",
        target: "community_pool",
        value: takerOsmoToCommunity,
        label: pct(osmoCommunityPercent),
      },
      {
        source: "taker_osmo",
        target: "burn",
        value: takerOsmoToBurn,
        label: pct(osmoBurnPercent),
      },

      // Taker non-OSMO distribution
      ...(takerNonOsmoToStaking > 0
        ? [
            {
              source: "taker_non_osmo",
              target: "staking",
              value: takerNonOsmoToStaking,
              label: pct(nonOsmoStakingPercent),
            },
          ]
        : []),
      ...(takerNonOsmoToCommunity > 0
        ? [
            {
              source: "taker_non_osmo",
              target: "community_pool",
              value: takerNonOsmoToCommunity,
              label: pct(nonOsmoCommunityPercent),
            },
          ]
        : []),
      ...(takerNonOsmoToBurn > 0
        ? [
            {
              source: "taker_non_osmo",
              target: "burn",
              value: takerNonOsmoToBurn,
              label: pct(nonOsmoBurnPercent),
            },
          ]
        : []),

      // ProtoRev split
      {
        source: "protorev",
        target: "protorev_maintainers",
        value: protorevToMaintainers,
        label: "5%",
      },
      {
        source: "protorev",
        target: "protorev_after_maintainers",
        value: protorevAfterMaintainers,
        label: "95%",
      },

      // ProtoRev after maintainers split
      {
        source: "protorev_after_maintainers",
        target: "protorev_osmo",
        value: protorevOsmo,
        label: "50% OSMO",
      },
      {
        source: "protorev_after_maintainers",
        target: "protorev_non_osmo",
        value: protorevNonOsmo,
        label: "50% Non-OSMO",
      },

      // ProtoRev OSMO to burn
      {
        source: "protorev_osmo",
        target: "burn",
        value: protorevOsmoToBurn,
        label: "100%",
      },

      // ProtoRev non-OSMO to community pool
      {
        source: "protorev_non_osmo",
        target: "community_pool",
        value: protorevNonOsmoToCommunity,
        label: "100%",
      },

      // Transaction fees to staking
      {
        source: "tx_fees",
        target: "staking",
        value: txFeesToStaking,
        label: "100%",
      },

      // Top of Block to community pool
      {
        source: "top_of_block",
        target: "community_pool",
        value: tobToCommunity,
        label: "100%",
      },
    ];

    return {
      nodes,
      links,
      osmoStakingPercent,
      osmoCommunityPercent,
      osmoBurnPercent,
      nonOsmoStakingPercent,
      nonOsmoCommunityPercent,
      nonOsmoBurnPercent,
      takerFeesOsmo,
      takerFeesNonOsmo,
      takerOsmoToStaking,
      takerOsmoToCommunity,
      takerOsmoToBurn,
      takerNonOsmoToStaking,
      takerNonOsmoToCommunity,
      takerNonOsmoToBurn,
      protorevOsmo,
      protorevNonOsmo,
      protorevOsmoToBurn,
      protorevNonOsmoToCommunity,
      txFeesToStaking,
      tobToCommunity,
      revenueAvgs,
    };
  }, [historicalData, timeRange]);

  const formatUSDCompact = (value: number) => {
    if (value >= 1000000) {
      // For millions, round to whole number if >= 10M, else 1 decimal
      return value >= 10000000
        ? `$${Math.round(value / 1000000)}M`
        : `$${(value / 1000000).toFixed(1)}M`;
    } else if (value >= 10000) {
      // For 10k+, round to whole number
      return `$${Math.round(value / 1000)}k`;
    } else if (value >= 1000) {
      // For 1k-10k, use 1 decimal
      return `$${(value / 1000).toFixed(1)}k`;
    }
    return `$${Math.round(value)}`;
  };

  const getTooltipContent = (nodeId: string) => {
    // No revenue data for the selected range: the overlay caller treats a null
    // return as "render nothing", so bail before dereferencing revenueAvgs.
    if (!revenueAvgs) return null;
    switch (nodeId) {
      case "taker_fees":
        return {
          title: "Taker Fees",
          total: formatUSD(revenueAvgs.takerFees),
          breakdown: [
            { label: "OSMO (~50% †)", value: formatUSD(takerFeesOsmo) },
            { label: "Non-OSMO (~50% †)", value: formatUSD(takerFeesNonOsmo) },
          ],
          flows: [
            {
              label: `→ Staking (${pct(osmoStakingPercent)} OSMO, ${pct(nonOsmoStakingPercent)} Non-OSMO)`,
              value: formatUSD(takerOsmoToStaking + takerNonOsmoToStaking),
            },
            {
              label: `→ Community Pool (${pct(osmoCommunityPercent)} OSMO, ${pct(nonOsmoCommunityPercent)} Non-OSMO)`,
              value: formatUSD(takerOsmoToCommunity + takerNonOsmoToCommunity),
            },
            {
              label: `→ Burn (${pct(osmoBurnPercent)} OSMO, ${pct(nonOsmoBurnPercent)} Non-OSMO)`,
              value: formatUSD(takerOsmoToBurn + takerNonOsmoToBurn),
            },
          ],
        };
      case "protorev":
        return {
          title: "ProtoRev",
          total: formatUSD(revenueAvgs.protorev),
          breakdown: [
            {
              label: "To Maintainers (5%)",
              value: formatUSD(revenueAvgs.protorev * 0.05),
            },
            {
              label: "Remaining (95%)",
              value: formatUSD(revenueAvgs.protorev * 0.95),
            },
            { label: "  • OSMO (~50% †)", value: formatUSD(protorevOsmo) },
            {
              label: "  • Non-OSMO (~50% †)",
              value: formatUSD(protorevNonOsmo),
            },
          ],
          flows: [
            { label: "→ Burn (OSMO)", value: formatUSD(protorevOsmoToBurn) },
            {
              label: "→ Community Pool (Non-OSMO)",
              value: formatUSD(protorevNonOsmoToCommunity),
            },
          ],
        };
      case "tx_fees":
        return {
          title: "Transaction Fees",
          total: formatUSD(revenueAvgs.txFees),
          breakdown: [
            { label: "100% OSMO", value: formatUSD(revenueAvgs.txFees) },
          ],
          flows: [
            { label: "→ Staking (100%)", value: formatUSD(txFeesToStaking) },
          ],
        };
      case "top_of_block":
        return {
          title: "Top of Block",
          total: formatUSD(revenueAvgs.topOfBlock),
          breakdown: [
            {
              label: "100% to Community Pool",
              value: formatUSD(revenueAvgs.topOfBlock),
            },
          ],
          flows: [
            {
              label: "→ Community Pool (100%)",
              value: formatUSD(tobToCommunity),
            },
          ],
        };
      case "staking":
        return {
          title: "Staking Rewards",
          total: formatUSD(
            takerOsmoToStaking + takerNonOsmoToStaking + txFeesToStaking
          ),
          breakdown: [
            {
              label: "From Taker Fees (OSMO)",
              value: formatUSD(takerOsmoToStaking),
            },
            {
              label: "From Taker Fees (Non-OSMO)",
              value: formatUSD(takerNonOsmoToStaking),
            },
            {
              label: "From Transaction Fees",
              value: formatUSD(txFeesToStaking),
            },
          ],
        };
      case "community_pool":
        return {
          title: "Community Pool",
          total: formatUSD(
            takerOsmoToCommunity +
              takerNonOsmoToCommunity +
              protorevNonOsmoToCommunity +
              tobToCommunity
          ),
          breakdown: [
            {
              label: "From Taker Fees (OSMO)",
              value: formatUSD(takerOsmoToCommunity),
            },
            {
              label: "From Taker Fees (Non-OSMO)",
              value: formatUSD(takerNonOsmoToCommunity),
            },
            {
              label: "From ProtoRev (Non-OSMO)",
              value: formatUSD(protorevNonOsmoToCommunity),
            },
            { label: "From Top of Block", value: formatUSD(tobToCommunity) },
          ],
        };
      case "burn":
        return {
          title: "Burn",
          total: formatUSD(
            takerOsmoToBurn + takerNonOsmoToBurn + protorevOsmoToBurn
          ),
          breakdown: [
            {
              label: "From Taker Fees (OSMO)",
              value: formatUSD(takerOsmoToBurn),
            },
            {
              label: "From Taker Fees (Non-OSMO)",
              value: formatUSD(takerNonOsmoToBurn),
            },
            {
              label: "From ProtoRev (OSMO)",
              value: formatUSD(protorevOsmoToBurn),
            },
          ],
        };
      default:
        return null;
    }
  };

  const getNodesByLevel = (level: number) =>
    nodes.filter((node) => node.level === level);

  // Calculate total for proportional sizing (already 30-day totals from
  // calculateRevenueTotals). Falls back to 0 when there is no revenue data for
  // the selected range (revenueAvgs is null).
  const total30Days =
    (revenueAvgs?.takerFees ?? 0) +
    (revenueAvgs?.protorev ?? 0) +
    (revenueAvgs?.txFees ?? 0) +
    (revenueAvgs?.topOfBlock ?? 0);

  // Get final destinations
  const destinations = getNodesByLevel(3);
  const totalDestinations = destinations.reduce(
    (sum, node) => sum + node.value,
    0
  );

  // Check if we're using fallback values
  // Check if we're using fallback revenue values (no historical revenue data)
  const usingFallbackValues =
    historicalData.length === 0 ||
    !historicalData.slice(-30).some((r) => r.totalRevenue !== undefined);

  // If no revenue data available, show error message
  if (!revenueAvgs) {
    return (
      <Card ref={cardRef}>
        <CardHeader>
          <ChartHeader
            title="Protocol Revenue"
            timeRange={timeRange}
            onRangeChange={setTimeRange}
            cardRef={cardRef}
            screenshotFilename="protocol-revenue"
            shareText="How Osmosis protocol revenue is distributed"
          />
        </CardHeader>
        <CardContent>
          <div className="flex min-h-[400px] items-center justify-center">
            <div className="text-center">
              <p className="mb-2 text-lg text-white">
                Revenue Data Unavailable
              </p>
              <p className="text-sm text-osmo-200">
                No revenue data available for the selected time range
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    // Lift the whole card's z-index while the node tooltip is open. The tooltip is
    // an in-card absolute overlay, and Card's backdrop-blur creates a stacking
    // context, so without this the overlay is painted UNDER the next card below.
    // Same fix as TokenBalancesChart's explainer popovers.
    <Card ref={cardRef} className={displayNode ? "relative z-30" : undefined}>
      <CardHeader>
        <ChartHeader
          title="Protocol Revenue"
          timeRange={timeRange}
          onRangeChange={setTimeRange}
          cardRef={cardRef}
          screenshotFilename="protocol-revenue"
          shareText="How Osmosis protocol revenue is distributed"
          headlineValue={formatUSD(total30Days)}
          headlineLabel={
            <>
              {timeRangeLabel(timeRange)}
              {usingFallbackValues && (
                <span className="ml-2 text-yellow-400">*</span>
              )}
            </>
          }
        />
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Gradient box encompassing both sources and destinations */}
          <div className="via-white/2 rounded-lg bg-gradient-to-b from-white/5 to-transparent p-4">
            {/* Sources with proportional widths */}
            <div>
              <div className="mb-2 text-xs font-semibold text-osmo-200">
                SOURCES
              </div>
              <div className="mb-6 flex gap-2">
                {getNodesByLevel(0).map((node) => {
                  const widthPercent = (node.value / total30Days) * 100;
                  // Use short label if bar is narrow (< 15%)
                  const displayLabel =
                    widthPercent < 15 && node.shortLabel
                      ? node.shortLabel
                      : node.label;
                  return (
                    <div
                      key={node.id}
                      style={{ width: `${widthPercent}%` }}
                      className="relative"
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.label}: ${formatUSD(node.value)}. Activate for detail.`}
                        className="flex h-16 cursor-pointer flex-col items-center justify-center rounded transition-all hover:opacity-80 hover:ring-2 hover:ring-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        style={{ backgroundColor: node.color }}
                        onMouseEnter={() =>
                          !selectedNode && setHoveredNode(node.id)
                        }
                        onMouseLeave={() => setHoveredNode(null)}
                        onClick={() => toggleNode(node.id)}
                        onKeyDown={(e) => onNodeKeyDown(e, node.id)}
                      >
                        <div className="px-1 text-center text-xs font-semibold text-white">
                          {displayLabel}
                        </div>
                        <div className="px-1 text-xs text-white/90">
                          {formatUSDCompact(node.value)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Flow spacer */}
            <div className="h-8"></div>

            {/* Destinations with proportional widths */}
            <div>
              <div className="mb-2 text-xs font-semibold text-osmo-200">
                DESTINATIONS
              </div>
              <div className="flex gap-2">
                {destinations.map((node) => {
                  const widthPercent = (node.value / totalDestinations) * 100;
                  return (
                    <div
                      key={node.id}
                      style={{ width: `${widthPercent}%` }}
                      className="relative"
                    >
                      <div
                        role="button"
                        tabIndex={0}
                        aria-label={`${node.label}: ${formatUSD(node.value)}. Activate for detail.`}
                        className="flex h-24 cursor-pointer flex-col items-center justify-center rounded transition-all hover:opacity-80 hover:ring-2 hover:ring-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
                        style={{ backgroundColor: node.color }}
                        onMouseEnter={() =>
                          !selectedNode && setHoveredNode(node.id)
                        }
                        onMouseLeave={() => setHoveredNode(null)}
                        onClick={() => toggleNode(node.id)}
                        onKeyDown={(e) => onNodeKeyDown(e, node.id)}
                      >
                        <div className="px-2 text-center text-sm font-bold text-white">
                          {node.label}
                        </div>
                        <div className="px-2 text-lg font-bold text-white">
                          {formatUSDCompact(node.value)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* Overlay Detail View */}
          {displayNode &&
            (() => {
              const tooltipData = getTooltipContent(displayNode);
              if (!tooltipData) return null;

              return (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
                  <div
                    className="pointer-events-auto mx-4 w-full max-w-md rounded-lg border border-white/20 bg-osmo-900/95 p-6 shadow-2xl backdrop-blur-md"
                    onMouseEnter={() => setHoveredNode(displayNode)}
                    onMouseLeave={() => !selectedNode && setHoveredNode(null)}
                  >
                    <div className="mb-4 flex items-start justify-between">
                      <div>
                        <div className="mb-1 text-xl font-bold text-white">
                          {tooltipData.title}
                        </div>
                        <div className="text-3xl font-bold text-osmo-accent">
                          {tooltipData.total}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setSelectedNode(null);
                          setHoveredNode(null);
                        }}
                        className="text-osmo-200 transition-colors hover:text-white"
                      >
                        <svg
                          className="h-5 w-5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>

                    {tooltipData.breakdown &&
                      tooltipData.breakdown.length > 0 && (
                        <div className="mb-4 border-t border-white/10 pt-4">
                          <div className="mb-3 text-sm font-semibold text-osmo-200">
                            Composition:
                          </div>
                          {tooltipData.breakdown.map((item, idx) => (
                            <div
                              key={idx}
                              className="mb-2 flex justify-between py-1 text-sm text-white"
                            >
                              <span className="text-osmo-100">
                                {item.label}
                              </span>
                              <span className="font-semibold">
                                {item.value}
                              </span>
                            </div>
                          ))}
                          {(displayNode === "taker_fees" ||
                            displayNode === "protorev") && (
                            <div className="mt-1 text-xs leading-relaxed text-osmo-300">
                              † The OSMO / non-OSMO split is an assumed ~50/50
                              source composition, not a live chain figure; the
                              downstream staking / community / burn split uses
                              live chain parameters.
                            </div>
                          )}
                        </div>
                      )}

                    {tooltipData.flows && tooltipData.flows.length > 0 && (
                      <div className="border-t border-white/10 pt-4">
                        <div className="mb-3 text-sm font-semibold text-osmo-200">
                          {displayNode === "taker_fees" ||
                          displayNode === "protorev" ||
                          displayNode === "tx_fees" ||
                          displayNode === "top_of_block"
                            ? "Flows to:"
                            : "Flows from:"}
                        </div>
                        {tooltipData.flows.map((item, idx) => (
                          <div
                            key={idx}
                            className="mb-2 flex justify-between py-1 text-sm text-white"
                          >
                            <span className="text-osmo-100">{item.label}</span>
                            <span className="font-semibold">{item.value}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}
        </div>
      </CardContent>
    </Card>
  );
}
