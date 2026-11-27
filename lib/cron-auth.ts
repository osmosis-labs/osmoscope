import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { logger } from "./logger";

const NO_STORE = { "Cache-Control": "no-store" } as const;

// Verify `Authorization: Bearer <CRON_SECRET>` for every /api/cron/* route.
// Returns a 500/401 NextResponse on failure, or null when authorized.
export function verifyCronAuth(
  request: Request,
  cronName: string
): NextResponse | null {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    logger.error(`CRON_SECRET is not set; refusing to run ${cronName} cron`);
    return NextResponse.json(
      { error: "Cron not configured" },
      { status: 500, headers: NO_STORE }
    );
  }
  const authHeader = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${cronSecret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: NO_STORE }
    );
  }
  return null;
}
