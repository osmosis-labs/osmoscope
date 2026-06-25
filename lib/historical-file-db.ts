// Database-backed implementation of historical data functions
import { prisma, isDatabaseEnabled } from "./database";
import { logger } from "./logger";
import { Prisma } from "@prisma/client";
import type { HistoricalRecord as PrismaRecord } from "@prisma/client";
import type { HistoricalRecord as JsonRecord } from "./historical-file";

// Convert Prisma record to JSON format
function prismaToJson(record: PrismaRecord): JsonRecord {
  return {
    timestamp: record.timestamp.toISOString(),
    burnedSupply: Number(record.burnedSupply),
    mintedSupply: Number(record.mintedSupply),
    totalSupply: Number(record.totalSupply),
    circulatingSupply: Number(record.circulatingSupply),
    restrictedSupply: record.restrictedSupply
      ? Number(record.restrictedSupply)
      : undefined,
    communitySupply: record.communitySupply
      ? Number(record.communitySupply)
      : undefined,
    inflationRate: Number(record.inflationRate),
    totalStaked: record.totalStaked ? Number(record.totalStaked) : undefined,
    stakingApr: record.stakingApr ? Number(record.stakingApr) : undefined,
    stakingRate: record.stakingRate ? Number(record.stakingRate) : undefined,
    distributionProportions: record.distributionProportions as
      | JsonRecord["distributionProportions"]
      | undefined,
    osmoTakerFeeDistribution: record.osmoTakerFeeDistribution as
      | JsonRecord["osmoTakerFeeDistribution"]
      | undefined,
    nonOsmoTakerFeeDistribution: record.nonOsmoTakerFeeDistribution as
      | JsonRecord["nonOsmoTakerFeeDistribution"]
      | undefined,
    communityPoolDenomWhitelist: record.communityPoolDenomWhitelist,
    communityPoolDenomToSwapNonWhitelistedAssetsTo:
      record.communityPoolDenomToSwapNonWhitelistedAssetsTo || undefined,
    txnFeesRevenue: record.txnFeesRevenue
      ? Number(record.txnFeesRevenue)
      : undefined,
    takerFeesRevenue: record.takerFeesRevenue
      ? Number(record.takerFeesRevenue)
      : undefined,
    protorevRevenue: record.protorevRevenue
      ? Number(record.protorevRevenue)
      : undefined,
    mevRevenue: record.mevRevenue ? Number(record.mevRevenue) : undefined,
    totalRevenue: record.totalRevenue ? Number(record.totalRevenue) : undefined,
  };
}

// Convert JSON record to Prisma format.
//
// Json? columns need special handling under Prisma: a SQL NULL is written with
// Prisma.JsonNull (a plain `null` is not a valid Json input value), and a
// present value must satisfy Prisma.InputJsonValue. Scalar Decimal columns
// accept a plain `number`, so those pass through unchanged.
function jsonToPrisma(record: JsonRecord): Prisma.HistoricalRecordCreateInput {
  const toJson = (
    value: unknown
  ): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
    value == null ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

  return {
    timestamp: new Date(record.timestamp),
    burnedSupply: record.burnedSupply,
    mintedSupply: record.mintedSupply,
    totalSupply: record.totalSupply,
    circulatingSupply: record.circulatingSupply,
    restrictedSupply: record.restrictedSupply ?? null,
    communitySupply: record.communitySupply ?? null,
    inflationRate: record.inflationRate,
    totalStaked: record.totalStaked ?? null,
    stakingApr: record.stakingApr ?? null,
    stakingRate: record.stakingRate ?? null,
    distributionProportions: toJson(record.distributionProportions),
    osmoTakerFeeDistribution: toJson(record.osmoTakerFeeDistribution),
    nonOsmoTakerFeeDistribution: toJson(record.nonOsmoTakerFeeDistribution),
    communityPoolDenomWhitelist: record.communityPoolDenomWhitelist || [],
    communityPoolDenomToSwapNonWhitelistedAssetsTo:
      record.communityPoolDenomToSwapNonWhitelistedAssetsTo ?? null,
    txnFeesRevenue: record.txnFeesRevenue ?? null,
    takerFeesRevenue: record.takerFeesRevenue ?? null,
    protorevRevenue: record.protorevRevenue ?? null,
    mevRevenue: record.mevRevenue ?? null,
    totalRevenue: record.totalRevenue ?? null,
  };
}

// Save snapshot to database
export async function saveSnapshotToDatabase(data: JsonRecord): Promise<void> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  try {
    const prismaData = jsonToPrisma(data);

    // Upsert: update if exists (same day), insert if not
    await prisma.historicalRecord.upsert({
      where: { timestamp: prismaData.timestamp },
      update: prismaData,
      create: prismaData,
    });

    logger.info(`Saved snapshot to database: ${data.timestamp}`);
  } catch (error) {
    logger.error("Failed to save snapshot to database:", error);
    throw error;
  }
}

// Get all historical records from database
export async function getHistoryFromDatabase(): Promise<JsonRecord[]> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  try {
    const records = await prisma.historicalRecord.findMany({
      orderBy: { timestamp: "asc" },
    });

    return records.map(prismaToJson);
  } catch (error) {
    logger.error("Failed to fetch history from database:", error);
    throw error;
  }
}

// Get history for a specific time range
export async function getHistoryRangeFromDatabase(
  days: number
): Promise<JsonRecord[]> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const records = await prisma.historicalRecord.findMany({
      where: {
        timestamp: {
          gte: cutoff,
        },
      },
      orderBy: { timestamp: "asc" },
    });

    return records.map(prismaToJson);
  } catch (error) {
    logger.error("Failed to fetch history range from database:", error);
    throw error;
  }
}

// Get paginated history
export async function getHistoryPaginated(
  page: number = 1,
  pageSize: number = 100,
  orderBy: "asc" | "desc" = "desc"
): Promise<{
  records: JsonRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  try {
    const skip = (page - 1) * pageSize;

    const [records, total] = await Promise.all([
      prisma.historicalRecord.findMany({
        take: pageSize,
        skip,
        orderBy: { timestamp: orderBy },
      }),
      prisma.historicalRecord.count(),
    ]);

    return {
      records: records.map(prismaToJson),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  } catch (error) {
    logger.error("Failed to fetch paginated history:", error);
    throw error;
  }
}

// Get history stats from database
export async function getHistoryStatsFromDatabase() {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  try {
    const [count, oldest, newest] = await Promise.all([
      prisma.historicalRecord.count(),
      prisma.historicalRecord.findFirst({
        orderBy: { timestamp: "asc" },
        select: { timestamp: true },
      }),
      prisma.historicalRecord.findFirst({
        orderBy: { timestamp: "desc" },
        select: { timestamp: true },
      }),
    ]);

    if (!oldest || !newest) {
      return {
        recordCount: 0,
        oldestRecord: null,
        newestRecord: null,
        coverageDays: 0,
      };
    }

    const coverageDays =
      (newest.timestamp.getTime() - oldest.timestamp.getTime()) /
      (1000 * 60 * 60 * 24);

    return {
      recordCount: count,
      oldestRecord: oldest.timestamp.toISOString(),
      newestRecord: newest.timestamp.toISOString(),
      coverageDays: Math.round(coverageDays * 10) / 10,
    };
  } catch (error) {
    logger.error("Failed to get history stats from database:", error);
    throw error;
  }
}

// Calculate burn rate from database
export async function getBurnRateFromDatabase(
  days: number = 1
): Promise<number> {
  if (!isDatabaseEnabled()) {
    throw new Error("Database is not configured");
  }

  try {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const records = await prisma.historicalRecord.findMany({
      where: {
        timestamp: {
          gte: cutoff,
        },
      },
      orderBy: { timestamp: "asc" },
      select: {
        timestamp: true,
        burnedSupply: true,
        totalSupply: true,
      },
    });

    if (records.length < 2) {
      logger.info(
        `Need at least 2 data points in last ${days} days. Have: ${records.length}`
      );
      return 0;
    }

    const oldest = records[0];
    const newest = records[records.length - 1];

    const burnChange =
      Number(newest.burnedSupply) - Number(oldest.burnedSupply);

    const timeSpanMs = newest.timestamp.getTime() - oldest.timestamp.getTime();
    const timeSpanDays = timeSpanMs / (1000 * 60 * 60 * 24);

    if (
      Number(newest.totalSupply) > 0 &&
      burnChange !== 0 &&
      timeSpanDays > 0
    ) {
      const annualizedBurnChange = (burnChange / timeSpanDays) * 365;
      const rate = -(annualizedBurnChange / Number(newest.totalSupply)) * 100;
      logger.info(
        `Burn rate: ${rate.toFixed(4)}% annually (${burnChange.toFixed(2)} OSMO over ${timeSpanDays.toFixed(1)} days)`
      );
      return rate;
    }

    return 0;
  } catch (error) {
    logger.error("Failed to calculate burn rate from database:", error);
    return 0;
  }
}
