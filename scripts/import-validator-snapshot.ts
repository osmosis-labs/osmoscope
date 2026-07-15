#!/usr/bin/env tsx
// Import per-validator snapshot metrics from SmartStake's Validators.csv into the
// ValidatorSnapshot table: governance recency (votes in last 10 proposals),
// slashing history, and long-run signing uptime — none of which are readable live
// from the LCD. Keyed by operator address; upserted so re-imports refresh in place.
//
// ONE-SHOT: SmartStake's Osmosis pages are gone, so no fresh CSV will exist.
// Do NOT re-run against the original CSV either — it would re-import a
// timesSlashed baseline that may already include events the cron has since
// counted in cronSlashCount (the leaderboard sums the two), double-counting
// them. The cron's self-indexing supersedes this import going forward.
// Dry-run by default; APPLY=1 writes. Requires a DB connection. data/ is
// gitignored, so run locally against prod.
import fs from "fs";
import path from "path";
import { prisma, isDatabaseEnabled } from "../lib/database";

const APPLY = process.env.APPLY === "1";
const CSV = path.join(process.cwd(), "data", "Validators.csv");

// CSV parse tolerant of quoted fields with embedded commas (some monikers /
// descriptions contain commas), so we can't naive-split. Minimal state machine.
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseCsv(file: string): Record<string, string>[] {
  const raw = fs.readFileSync(file, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

const num = (s: string | undefined): number | null => {
  if (s == null || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

async function main() {
  if (!isDatabaseEnabled()) {
    console.error(
      "❌ No database configured (POSTGRES_PRISMA_URL / DATABASE_URL)."
    );
    process.exit(1);
  }
  if (!fs.existsSync(CSV)) {
    console.error(`❌ Missing ${CSV}`);
    process.exit(1);
  }
  console.log(
    APPLY
      ? "APPLY mode — will write.\n"
      : "DRY-RUN — no writes (APPLY=1 to write).\n"
  );

  const rows = parseCsv(CSV);
  console.log(`${rows.length} validators in CSV.\n`);

  let written = 0;
  let skipped = 0;
  for (const r of rows) {
    const operatorAddress = r.operatorAddress?.trim();
    if (!operatorAddress) {
      skipped++;
      continue;
    }
    const gov = num(r.voteParticipation); // votes in last 10 proposals
    const times = num(r.timesSlashed);
    const uptime = num(r.historicalPerSigned);
    const selfBond = num(r.selfBondPercentage);
    // latestSlashedTime is a UNIX timestamp in SECONDS (e.g. "1774829266"), not an
    // ISO string — parse as seconds → ms. (new Date("1774829266") would misparse.)
    const latestRaw = r.latestSlashedTime?.trim();
    const latestSecs = latestRaw ? Number(latestRaw) : NaN;
    const latestSlashedTime =
      Number.isFinite(latestSecs) && latestSecs > 0
        ? new Date(latestSecs * 1000)
        : null;

    if (written < 3) {
      console.log(
        `  ${r.name?.slice(0, 24)}: gov=${gov ?? "—"}/10 slashed=${times ?? "—"} uptime=${uptime ?? "—"}%`
      );
    }
    if (APPLY) {
      const data = {
        govVotesLast10: gov == null ? null : Math.round(gov),
        timesSlashed: times == null ? null : Math.round(times),
        latestSlashedTime:
          latestSlashedTime && !isNaN(latestSlashedTime.getTime())
            ? latestSlashedTime
            : null,
        longRunUptime: uptime,
        selfBondPercentage: selfBond,
      };
      await prisma.validatorSnapshot.upsert({
        where: { operatorAddress },
        create: { operatorAddress, ...data },
        update: data,
      });
    }
    written++;
  }

  console.log(
    `\nDone. ${APPLY ? "Upserted" : "Would upsert"}: ${written}, skipped: ${skipped}.${APPLY ? " WRITTEN." : " (dry-run)"}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Validator-snapshot import failed:", e);
  process.exit(1);
});
