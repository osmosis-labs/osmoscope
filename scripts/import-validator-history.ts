#!/usr/bin/env tsx
// One-off / re-runnable import of SmartStake CSV history into the DB, filling the
// decentralization columns on HistoricalRecord: nakamotoCoefficient,
// giniCoefficient, pendingUndelegations, blockRate.
//
// The CSVs live in data/ (gitignored, local-only). This matches each CSV row to
// an EXISTING HistoricalRecord by calendar day (UTC) and updates it — it never
// inserts rows, so it can't create phantom/duplicate days. CSV dates with no
// matching DB row are skipped (reported). Idempotent; dry-run by default, set
// APPLY=1 to write. Requires a DB connection (POSTGRES_PRISMA_URL / DATABASE_URL).
//
// The snapshot cron computes these same fields daily going forward; this backfills
// the history the cron can't reach.
import fs from "fs";
import path from "path";
import { prisma, isDatabaseEnabled } from "../lib/database";

const APPLY = process.env.APPLY === "1";
const DATA_DIR = path.join(process.cwd(), "data");

// Minimal CSV parse: strips a UTF-8 BOM, splits quoted fields. The SmartStake
// files are simple (no embedded commas in the columns we read), so a full CSV
// lib isn't needed — but we DO strip surrounding quotes.
function parseCsv(file: string): Record<string, string>[] {
  const raw = fs.readFileSync(file, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const unquote = (s: string) => s.replace(/^"|"$/g, "");
  const headers = lines[0].split(",").map(unquote);
  return lines.slice(1).map((line) => {
    const cells = line.split(",").map(unquote);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row;
  });
}

// Build a date(YYYY-MM-DD) -> number map from a CSV, given the date and value
// column names (SmartStake inconsistently uses "date" or "title" for the date).
function dateMap(
  file: string,
  dateCol: string,
  valueCol: string
): Map<string, number> {
  const m = new Map<string, number>();
  if (!fs.existsSync(file)) {
    console.warn(`  ! missing CSV: ${path.basename(file)}`);
    return m;
  }
  for (const row of parseCsv(file)) {
    const date = row[dateCol]?.slice(0, 10);
    const v = row[valueCol];
    if (!date || v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) m.set(date, n);
  }
  return m;
}

function dayOf(ts: Date): string {
  return ts.toISOString().slice(0, 10);
}

async function main() {
  if (!isDatabaseEnabled()) {
    console.error(
      "❌ No database configured (POSTGRES_PRISMA_URL / DATABASE_URL)."
    );
    process.exit(1);
  }
  console.log(
    APPLY
      ? "APPLY mode — will write.\n"
      : "DRY-RUN — no writes (APPLY=1 to write).\n"
  );

  const nakamoto = dateMap(
    path.join(DATA_DIR, "Nakamoto Coefficient.csv"),
    "date",
    "value"
  );
  const gini = dateMap(
    path.join(DATA_DIR, "Gini Coefficient.csv"),
    "title",
    "gini"
  );
  const undeleg = dateMap(
    path.join(DATA_DIR, "Undelegation History.csv"),
    "date",
    "value"
  );
  const blockRate = dateMap(
    path.join(DATA_DIR, "Block Rate (seconds) vs Network Sign Rate.csv"),
    "title",
    "blockRate"
  );
  console.log(
    `CSV rows — nakamoto:${nakamoto.size} gini:${gini.size} undeleg:${undeleg.size} blockRate:${blockRate.size}\n`
  );

  const rows = await prisma.historicalRecord.findMany({
    orderBy: { timestamp: "asc" },
    select: {
      timestamp: true,
      nakamotoCoefficient: true,
      giniCoefficient: true,
      pendingUndelegations: true,
      blockRate: true,
    },
  });
  console.log(`${rows.length} historical rows in DB.\n`);

  let updated = 0;
  let unchanged = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const day = dayOf(r.timestamp);
    const nk = nakamoto.get(day);
    const gi = gini.get(day);
    const un = undeleg.get(day);
    const br = blockRate.get(day);
    if (nk == null && gi == null && un == null && br == null) continue;

    // Round the two OSMO-scale / integer fields sensibly; keep Gini/blockRate as-is.
    const data: Record<string, number> = {};
    if (nk != null) data.nakamotoCoefficient = Math.round(nk);
    if (gi != null) data.giniCoefficient = gi;
    if (un != null) data.pendingUndelegations = un;
    if (br != null) data.blockRate = br;

    // Idempotent skip if every present field already matches.
    const same =
      (nk == null || Number(r.nakamotoCoefficient) === Math.round(nk)) &&
      (gi == null || Number(r.giniCoefficient) === gi) &&
      (un == null || Number(r.pendingUndelegations) === un) &&
      (br == null || Number(r.blockRate) === br);
    if (same) {
      unchanged++;
      continue;
    }

    if (i < 3 || i % 300 === 0) {
      console.log(
        `  ${day}: ${Object.entries(data)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`
      );
    }
    if (APPLY) {
      await prisma.historicalRecord.update({
        where: { timestamp: r.timestamp },
        data,
      });
    }
    updated++;
  }

  console.log(
    `\nDone. Updated: ${updated}, already-current: ${unchanged}. ${
      APPLY ? "WRITTEN." : "(dry-run — nothing written)"
    }`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Validator-history import failed:", e);
  process.exit(1);
});
