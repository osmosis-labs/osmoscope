import fs from "fs/promises";
import path from "path";
import { parse } from "csv-parse/sync";
import type { HistoricalRecord } from "../lib/historical-file";
import { logger } from "../lib/logger";

const HISTORY_FILE = path.join(process.cwd(), "data", "history.json");
const TOTAL_STAKE_CSV = path.join(process.cwd(), "data", "TotalStake.csv");

interface TotalStakeEntry {
  date: string; // YYYY-MM-DD
  value: string; // Total staked amount
}

async function populateTotalStakeHistory() {
  try {
    // Read the CSV file
    logger.info("Reading TotalStake.csv...");
    const csvContent = await fs.readFile(TOTAL_STAKE_CSV, "utf-8");

    // Parse CSV (skip BOM if present)
    const records: TotalStakeEntry[] = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      bom: true, // Handle UTF-8 BOM
    });

    logger.info(`Parsed ${records.length} total stake entries from CSV`);

    // Create a map of date -> total staked
    const stakeMap = new Map<string, number>();
    records.forEach((entry) => {
      stakeMap.set(entry.date, parseFloat(entry.value));
    });

    // Read existing history
    logger.info("Reading existing history.json...");
    const historyContent = await fs.readFile(HISTORY_FILE, "utf-8");
    const history: HistoricalRecord[] = JSON.parse(historyContent);

    logger.info(`Found ${history.length} existing records`);

    // Update each record with total staked if we have data for that date
    let updatedCount = 0;
    for (const record of history) {
      const recordDate = new Date(record.timestamp);
      const dateStr = recordDate.toISOString().split("T")[0]; // YYYY-MM-DD

      const totalStaked = stakeMap.get(dateStr);
      if (totalStaked !== undefined) {
        record.totalStaked = totalStaked;
        updatedCount++;
      }
    }

    logger.info(`Updated ${updatedCount} records with total stake data`);

    // Save updated history
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
    logger.info("Successfully saved updated history.json");

    // Log coverage stats
    const recordsWithStake = history.filter(
      (r) => r.totalStaked !== undefined
    ).length;
    logger.info(
      `Coverage: ${recordsWithStake}/${history.length} records have total stake data`
    );
  } catch (error) {
    logger.error("Failed to populate total stake history:", error);
    process.exit(1);
  }
}

populateTotalStakeHistory();
