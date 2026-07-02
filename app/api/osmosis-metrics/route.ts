import { NextResponse } from "next/server";
import { getHistory } from "@/lib/historical-file";
import { fetchOsmoPrice } from "@/lib/osmosis-lcd";
import { logger } from "@/lib/logger";
import type { OsmosisMetrics } from "@/types/osmosis";

// This endpoint serves the MOST RECENT daily snapshot — it makes NO live LCD
// calls. Every value it returns (supply, burn, inflation, restricted, community,
// staking) is captured once per day by the snapshot cron (/api/cron/snapshot),
// which fires right after the daily epoch completes. The chain's mint/inflation
// figures only change at the epoch boundary, so the snapshot is epoch-fresh and
// reading it back is near-instant (vs. the previous live computation that did
// ~40 throttled LCD calls per cold load). Response is CDN-cached 5 minutes.
export async function GET() {
  try {
    const history = await getHistory();
    if (history.length === 0) {
      return NextResponse.json(
        { error: "No snapshot data available yet" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Most recent COMPLETE snapshot row. Don't just trust array position: pick
    // the row with the greatest timestamp that actually carries core supply data,
    // so a stray out-of-order or partial row (e.g. a migrate upsert at an odd time,
    // or a legacy duplicate-day row predating the same-day-replace logic) can't
    // override the real epoch-gated daily snapshot. (The DB save now keeps one row
    // per day, so in normal operation this is simply the chronological latest.)
    const latest = history.reduce(
      (best, r) => {
        const complete = r.totalSupply != null && r.mintedSupply != null;
        if (!complete) return best;
        if (!best) return r;
        return new Date(r.timestamp).getTime() >=
          new Date(best.timestamp).getTime()
          ? r
          : best;
      },
      undefined as (typeof history)[number] | undefined
    );

    if (!latest) {
      return NextResponse.json(
        { error: "No complete snapshot available yet" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    const inflationRate = latest.inflationRate ?? 0;

    // Annualized burn rate (%) over the last `days`, computed inline from the
    // already-loaded history. We do NOT call getBurnRateFromHistory here: that
    // re-reads via the DB path, which can return 0 on a flaky connection and
    // silently zero out the burn (making net inflation wrong). Computing from the
    // history we already have keeps the KPI consistent with the charts.
    const burnRateOver = (days: number): number => {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const win = history.filter(
        (r) => new Date(r.timestamp).getTime() > cutoff
      );
      if (win.length < 2) return 0;
      const oldest = win[0];
      const newest = win[win.length - 1];
      const burnChange =
        (newest.burnedSupply ?? newest.burned ?? 0) -
        (oldest.burnedSupply ?? oldest.burned ?? 0);
      const spanDays =
        (new Date(newest.timestamp).getTime() -
          new Date(oldest.timestamp).getTime()) /
        (1000 * 60 * 60 * 24);
      if (!(newest.totalSupply > 0) || spanDays <= 0) return 0;
      return -(((burnChange / spanDays) * 365) / newest.totalSupply) * 100;
    };

    const burnRate = burnRateOver(30);

    // 90-day cutoff for the headline KPIs. Computed in UTC (setUTCDate) so it's
    // deterministic and independent of the server host's timezone — 90 calendar
    // days back at the same UTC wall-clock, which also avoids the fixed-90*24h
    // DST skew of Date.now()-90*86400*1000. Note: the charts' "Last 90 days"
    // filter runs in the VIEWER's browser timezone, so on the single boundary day
    // a far-from-UTC viewer's chart window can differ from this KPI by one day;
    // with daily snapshots that's a <1/90 effect on the average, not worth
    // forcing a shared server value onto a per-viewer window.
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const ninetyDaysAgo = cutoff.getTime();
    const recentIdx = history.findIndex(
      (r) => new Date(r.timestamp).getTime() >= ninetyDaysAgo
    );
    const recent = recentIdx >= 0 ? history.slice(recentIdx) : [];
    const avg = (pick: (r: (typeof recent)[number]) => number | undefined) => {
      const vals = recent.map(pick).filter((v): v is number => v != null);
      return vals.length > 0
        ? vals.reduce((s, v) => s + v, 0) / vals.length
        : 0;
    };
    const avgInflation90d =
      recent.length > 0 ? avg((r) => r.inflationRate) : inflationRate;

    // Net inflation = average of DAILY net (gross inflation + that day's annualized
    // burn rate), matching how the inflation chart computes its "Net Inflation"
    // average. Computing it as avg(gross) + a single endpoint burn rate would not
    // equal the chart's per-day average, so we compute per-day net here too. Each
    // day's burn rate is the annualized burn delta vs the previous record.
    const burnDeltaAt = (i: number): number =>
      (history[i].burnedSupply ?? history[i].burned ?? 0) -
      (history[i - 1].burnedSupply ?? history[i - 1].burned ?? 0);

    // Drop trailing days whose burn hasn't been measured yet (cumulative burn
    // unchanged vs the prior day => delta 0). The inflation chart trims these
    // before averaging its "Net Inflation", so the KPI must too or the two
    // disagree. Trim from the end down to the first day with a real burn delta.
    let netEnd = history.length; // exclusive
    while (netEnd - 1 >= 1 && burnDeltaAt(netEnd - 1) === 0) {
      netEnd--;
    }

    let netSum = 0;
    let netCount = 0;
    // recentIdx < 0 means no records within the last 90 days — skip the loop and
    // fall back below rather than averaging all of history under a "90d" label.
    const netStart = recentIdx < 0 ? history.length : recentIdx;
    for (let i = netStart; i < netEnd; i++) {
      const cur = history[i];
      if (!(cur.totalSupply > 0)) continue;
      // Match the inflation chart's "Last 90 days" net-inflation basis exactly:
      // it iterates the FILTERED (in-window) series and gives the FIRST visible
      // day a burn rate of 0 (no prior in-window row), pairing every later day
      // with the previous in-window row. So the first in-window day here (i ===
      // recentIdx) contributes gross inflation only; others use burnDeltaAt(i).
      // (Previously the first day paired with history[recentIdx-1], one row
      // outside the window, so the two "Last 90 days" figures could diverge.)
      let dayBurnRate = 0;
      if (i > netStart) {
        const spanDays =
          (new Date(cur.timestamp).getTime() -
            new Date(history[i - 1].timestamp).getTime()) /
          (1000 * 60 * 60 * 24);
        dayBurnRate =
          spanDays > 0
            ? -(((burnDeltaAt(i) / spanDays) * 365) / cur.totalSupply) * 100
            : 0;
      }
      netSum += (cur.inflationRate ?? 0) + dayBurnRate;
      netCount++;
    }
    const netInflation90dAvg =
      netCount > 0 ? netSum / netCount : avgInflation90d + burnRate;

    // 90-day average staking APR (uses the raw daily APR; falls back to the
    // 30-day average stored on the latest snapshot if no window data).
    const stakingApr90dAvg = recent.some((r) => r.stakingApr != null)
      ? avg((r) => r.stakingApr)
      : (latest.stakingRate ?? latest.stakingApr ?? 0);

    // Live OSMO spot price + 24h change (the volatile values not in the daily
    // snapshot). Cheap single request; the response is CDN-cached 5 min below so
    // it is at most ~5 min stale, which is fine for a tokenomics dashboard.
    const priceData = await fetchOsmoPrice();
    const price = priceData?.price ?? null;
    const price24hChange = priceData?.price24hChange ?? null;

    const circulating = latest.circulatingSupply ?? latest.circulating ?? 0;
    const totalSupply = latest.totalSupply ?? 0;
    const totalStaked = latest.totalStaked ?? 0;

    // Market cap / FDV from our own supply figures (internally consistent with the
    // dashboard). null when price is unavailable so the UI omits these vs faking $0.
    const marketCap =
      price != null && circulating > 0 ? price * circulating : null;
    const fdv = price != null && totalSupply > 0 ? price * totalSupply : null;
    // Staking ratio = bonded / total supply (the conventional PoS bond ratio).
    // We divide by total supply, not circulating: totalStaked (bonded total from
    // the staking pool) includes restricted-entity stake that is excluded from
    // circulating, so staked/circulating would mix bases and overstate.
    const stakingRatio =
      totalStaked > 0 && totalSupply > 0
        ? (totalStaked / totalSupply) * 100
        : null;

    const response: OsmosisMetrics = {
      burned: latest.burnedSupply ?? latest.burned ?? 0,
      mintedSupply: latest.mintedSupply ?? 0,
      totalSupply,
      circulating,
      restrictedSupply: latest.restrictedSupply ?? 0,
      communitySupply: latest.communitySupply ?? 0,
      totalStaked,
      inflationRate,
      burnRate,
      // Net inflation = inflation + burn rate (burn rate is negative).
      netInflation: inflationRate + burnRate,
      // 90-day average net inflation, used as the headline KPI.
      netInflation90dAvg,
      // stakingRate holds the 30-day average APR captured in the snapshot.
      stakingApr: latest.stakingRate ?? latest.stakingApr ?? 0,
      // 90-day average staking APR, used as the headline KPI.
      stakingApr90dAvg,
      price,
      price24hChange,
      marketCap,
      fdv,
      stakingRatio,
      timestamp: latest.timestamp,
    };

    return NextResponse.json(response, {
      headers: {
        // CDN-cache for 5 minutes; serve stale for up to a minute more while a
        // fresh copy is fetched in the background. Errors below are not cached.
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    logger.error("Error fetching Osmosis metrics:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch Osmosis metrics",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
