import { NextResponse } from "next/server";
import { getHistory } from "@/lib/historical-file";
import { isDatabaseEnabled } from "@/lib/database";
import { getHistoryPaginated } from "@/lib/historical-file-db";
import { logger } from "@/lib/logger";
import { parseHistoryQuery } from "@/lib/edge";

// Historical data only changes once a day (written by the snapshot cron at 17:20
// UTC), so cache the response at the CDN for an hour and serve stale while
// revalidating. This route reads query params (request.url) so it is inherently
// dynamic; CDN caching is driven by the Cache-Control header below rather than
// route-segment `revalidate` (which is incompatible with a dynamic route).
const HISTORY_CACHE_CONTROL =
  "public, s-maxage=3600, stale-while-revalidate=600";

// First date charts display. The archive node is pruned before ~2021-12-15
// (genesis -> 2021-12-14 returns no chain state), but the genesis..data-start gap
// is reconstructed deterministically (scripts/backfill-genesis-2021.ts: 325M at
// genesis = 275M restricted + 50M airdrop, ramping to the first real record), so
// the charts now start at the chain genesis date.
const DATA_START_DATE = "2021-06-19";

function fromDataStart<T extends { timestamp: string }>(records: T[]): T[] {
  return records.filter((r) => r.timestamp.slice(0, 10) >= DATA_START_DATE);
}

export async function GET(request: Request) {
  try {
    // Validated with the same parser the edge cache keys on (lib/edge.ts),
    // so an accepted query always maps to one cached copy.
    const query = parseHistoryQuery(new URL(request.url).searchParams);
    if (query.kind === "invalid") {
      return NextResponse.json(
        { error: `Invalid query: ${query.reason}` },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    // If database is enabled and pagination requested, use paginated query
    if (isDatabaseEnabled() && query.kind === "page") {
      const result = await getHistoryPaginated(
        query.page,
        query.pageSize,
        query.order,
        DATA_START_DATE
      );

      return NextResponse.json(result, {
        headers: { "Cache-Control": HISTORY_CACHE_CONTROL },
      });
    }

    // Default: return all history from the first reliable data point onward.
    const history = fromDataStart(await getHistory());

    // getHistory falls back to an empty list when the database read fails. With
    // a database configured an empty history is never real, so answer with an
    // uncached error rather than let the CDN hold an empty chart for an hour.
    if (history.length === 0 && isDatabaseEnabled()) {
      return NextResponse.json(
        { error: "Historical data is temporarily unavailable" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Support simple ordering via query param even without pagination
    const orderBy = query.kind === "all" ? query.order : null;
    if (orderBy === "asc") {
      history.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    } else if (orderBy === "desc") {
      history.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    }

    return NextResponse.json(history, {
      headers: { "Cache-Control": HISTORY_CACHE_CONTROL },
    });
  } catch (error) {
    logger.error("Error fetching history:", error);
    return NextResponse.json(
      { error: "Failed to fetch historical data" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
