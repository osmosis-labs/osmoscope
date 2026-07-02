#!/usr/bin/env tsx
import fs from "fs";
import path from "path";
import { prisma, isDatabaseEnabled } from "../lib/database";
import { jsonToPrisma } from "../lib/historical-file-db";
import type { HistoricalRecord as JsonRecord } from "../lib/historical-file";

console.log("════════════════════════════════════════");
console.log("Migrate JSON Data to Vercel Postgres");
console.log("════════════════════════════════════════\n");

// Check if database is configured
if (!isDatabaseEnabled()) {
  console.error("❌ Database not configured!");
  console.log("\nTo set up database:");
  console.log("1. Create Vercel Postgres database in Vercel dashboard");
  console.log("2. Connect it to your project");
  console.log("3. Run: vercel env pull .env.local");
  console.log("4. Run: npx prisma migrate dev");
  process.exit(1);
}

// File paths
const HISTORY_FILE = path.join(process.cwd(), "data", "history.json");
const ARCHIVE_FILE = path.join(process.cwd(), "data", "history-archive.json");

// Load JSON files
function loadJsonFile(filePath: string): JsonRecord[] {
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  File not found: ${filePath}`);
      return [];
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(content);
    console.log(
      `✓ Loaded ${data.length} records from ${path.basename(filePath)}`
    );
    return data;
  } catch (error) {
    console.error(`❌ Failed to load ${filePath}:`, error);
    return [];
  }
}

// Transform JSON record to Prisma format. Reuses the canonical jsonToPrisma from
// the DB layer so this migration and the live save path stay in lockstep (same
// null-handling, same marker round-trip). Legacy fields (record.burned /
// record.circulating) are mapped onto the canonical names first.
function transformRecord(record: JsonRecord) {
  return jsonToPrisma({
    ...record,
    burnedSupply: record.burnedSupply ?? record.burned ?? 0,
    circulatingSupply: record.circulatingSupply ?? record.circulating,
  });
}

async function migrate() {
  try {
    // Test database connection
    console.log("Testing database connection...");
    await prisma.$queryRaw`SELECT 1`;
    console.log("✓ Database connection successful\n");

    // Load JSON files
    const historyRecords = loadJsonFile(HISTORY_FILE);
    const archiveRecords = loadJsonFile(ARCHIVE_FILE);

    // Combine and deduplicate by timestamp
    const allRecords = [...historyRecords, ...archiveRecords];
    const uniqueRecords = new Map<string, JsonRecord>();

    for (const record of allRecords) {
      const key = new Date(record.timestamp).toISOString();
      if (!uniqueRecords.has(key)) {
        uniqueRecords.set(key, record);
      }
    }

    const recordsToInsert = Array.from(uniqueRecords.values());
    console.log(
      `\n📊 Total unique records to migrate: ${recordsToInsert.length}\n`
    );

    // Check if database already has data
    const existingCount = await prisma.historicalRecord.count();
    if (existingCount > 0) {
      console.log(`⚠️  Database already has ${existingCount} records`);
      console.log("Options:");
      console.log("  1. Skip migration (keep existing data)");
      console.log("  2. Clear and re-import all data");
      console.log("  3. Upsert (update existing, insert new)");
      console.log("\nFor now, using upsert strategy...\n");
    }

    // Insert records in batches
    const BATCH_SIZE = 100;
    let inserted = 0;
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < recordsToInsert.length; i += BATCH_SIZE) {
      const batch = recordsToInsert.slice(i, i + BATCH_SIZE);

      for (const record of batch) {
        try {
          const transformed = transformRecord(record);

          // Upsert: update if exists, insert if not
          await prisma.historicalRecord.upsert({
            where: { timestamp: transformed.timestamp },
            update: transformed,
            create: transformed,
          });

          // Check if it was an update or insert
          const existing = await prisma.historicalRecord.findUnique({
            where: { timestamp: transformed.timestamp },
            select: { createdAt: true, updatedAt: true },
          });

          if (
            existing &&
            existing.createdAt.getTime() !== existing.updatedAt.getTime()
          ) {
            updated++;
          } else {
            inserted++;
          }
        } catch (error) {
          failed++;
          console.error(
            `❌ Failed to insert record ${record.timestamp}:`,
            error
          );
        }
      }

      const progress = Math.min(i + BATCH_SIZE, recordsToInsert.length);
      process.stdout.write(
        `\r  Progress: ${progress}/${recordsToInsert.length} records processed`
      );
    }

    console.log("\n");
    console.log("════════════════════════════════════════");
    console.log("Migration Complete!");
    console.log("════════════════════════════════════════");
    console.log(`✓ Inserted: ${inserted} new records`);
    console.log(`✓ Updated: ${updated} existing records`);
    if (failed > 0) {
      console.log(`✗ Failed: ${failed} records`);
    }

    // Verify final count
    const finalCount = await prisma.historicalRecord.count();
    console.log(`\n📊 Total records in database: ${finalCount}`);

    // Show date range
    const oldest = await prisma.historicalRecord.findFirst({
      orderBy: { timestamp: "asc" },
      select: { timestamp: true },
    });
    const newest = await prisma.historicalRecord.findFirst({
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });

    if (oldest && newest) {
      console.log(
        `📅 Date range: ${oldest.timestamp.toISOString().split("T")[0]} to ${newest.timestamp.toISOString().split("T")[0]}`
      );
    }

    console.log("\n✓ Migration successful!");
  } catch (error) {
    console.error("\n❌ Migration failed:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

migrate();
