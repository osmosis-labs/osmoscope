import fs from "fs/promises";
import path from "path";
import type { HistoricalRecord } from "../lib/historical-file";
import { logger } from "../lib/logger";

const HISTORY_FILE = path.join(process.cwd(), "data", "history.json");
const MODELED_RESTRICTED_SUPPLY = 97046470;
const MODELED_COMMUNITY_SUPPLY = 89137083;

// Current distribution proportions (assuming these going back)
const CURRENT_DISTRIBUTION_PROPORTIONS = {
  staking: "0.080000000000000000",
  poolIncentives: "0.000000000000000000",
  developerRewards: "0.250000000000000000",
  communityPool: "0.670000000000000000",
};

async function backfillModeledValues() {
  try {
    logger.info("Reading history.json...");
    const content = await fs.readFile(HISTORY_FILE, "utf-8");
    const history: HistoricalRecord[] = JSON.parse(content);

    logger.info(`Found ${history.length} historical records`);

    let updatedCount = 0;
    for (const record of history) {
      let updated = false;

      // Add restrictedSupply if missing
      if (record.restrictedSupply === undefined) {
        record.restrictedSupply = MODELED_RESTRICTED_SUPPLY;
        updated = true;
      }

      // Add communitySupply if missing
      if (record.communitySupply === undefined) {
        record.communitySupply = MODELED_COMMUNITY_SUPPLY;
        updated = true;
      }

      // Add distributionProportions if missing
      if (!record.distributionProportions) {
        record.distributionProportions = CURRENT_DISTRIBUTION_PROPORTIONS;
        updated = true;
      }

      if (updated) {
        updatedCount++;
      }
    }

    logger.info(`Updated ${updatedCount} records with modeled values`);

    // Save back to file
    await fs.writeFile(HISTORY_FILE, JSON.stringify(history, null, 2));
    logger.info("Successfully saved updated history.json");
  } catch (error) {
    logger.error("Failed to backfill modeled values:", error);
    process.exit(1);
  }
}

backfillModeledValues();
