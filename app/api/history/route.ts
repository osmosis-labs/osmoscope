import { NextResponse } from "next/server";
import { getHistory } from "@/lib/historical-file";
import { isDatabaseEnabled } from "@/lib/database";
import { getHistoryPaginated } from "@/lib/historical-file-db";
import { logger } from "@/lib/logger";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    // Check if pagination is requested
    const page = searchParams.get("page");
    const pageSize = searchParams.get("pageSize") || searchParams.get("limit");
    const orderBy = searchParams.get("orderBy") || searchParams.get("order");

    // If database is enabled and pagination requested, use paginated query
    if (isDatabaseEnabled() && page) {
      const pageNum = parseInt(page, 10) || 1;
      const pageSizeNum = parseInt(pageSize || "100", 10);
      const order = (orderBy?.toLowerCase() === "asc" ? "asc" : "desc") as
        | "asc"
        | "desc";

      const result = await getHistoryPaginated(pageNum, pageSizeNum, order);

      return NextResponse.json(result);
    }

    // Default: return all history
    const history = await getHistory();

    // Support simple ordering via query param even without pagination
    if (orderBy?.toLowerCase() === "asc") {
      history.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
    } else if (orderBy?.toLowerCase() === "desc") {
      history.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    }

    return NextResponse.json(history);
  } catch (error) {
    logger.error("Error fetching history:", error);
    return NextResponse.json(
      {
        error: "Failed to fetch historical data",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
