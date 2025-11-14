import { NextResponse } from "next/server";
import { getHistory } from "@/lib/historical-file";
import { logger } from "@/lib/logger";

export async function GET() {
  try {
    const history = await getHistory();
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
