import { NextResponse } from "next/server";
import { prisma, isDatabaseEnabled } from "@/lib/database";
import { logger } from "@/lib/logger";

// A validator's logo, stored by the snapshot cron (lib/validator-logos.ts) and
// served from our own origin for the voting-power treemap. Logos change rarely,
// so the image and the "no logo" 404 are both edge-cached for a day.
export const dynamic = "force-dynamic";

const OPERATOR_RE = /^osmovaloper1[02-9ac-hj-np-z]{38}$/;
const DAY_CACHE =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ operator: string }> }
) {
  const { operator } = await params;
  if (!OPERATOR_RE.test(operator) || !isDatabaseEnabled())
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": DAY_CACHE },
    });
  try {
    const row = await prisma.validatorLogo.findUnique({
      where: { operatorAddress: operator },
      select: { contentType: true, data: true },
    });
    if (!row?.data || !row.contentType)
      return new NextResponse(null, {
        status: 404,
        headers: { "Cache-Control": DAY_CACHE },
      });
    return new NextResponse(new Uint8Array(row.data), {
      headers: {
        "Content-Type": row.contentType,
        "Cache-Control": DAY_CACHE,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logger.error("Validator logo route failed:", error);
    return new NextResponse(null, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
