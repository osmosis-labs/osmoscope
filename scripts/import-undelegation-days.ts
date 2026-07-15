#!/usr/bin/env tsx
// Backfill the UndelegationDay table (per-completion-day OSMO amount) from
// SmartStake's Undelegation History export (data/Undelegation History.csv).
//
// Each CSV row is "amount completing on <date>" — the same FLOW definition the
// table holds and the cron writes going forward. Rows are upserted with
// source: "smartstake"; a later cron write (source: "cron") supersedes a day as
// it becomes current.
//
// ONE-SHOT: SmartStake's Osmosis pages are gone, so no fresh CSV will exist.
// Do NOT re-run — the upsert would overwrite days the cron has since written
// (source: "cron") with the older CSV figures. Dry-run by default, APPLY=1
// writes. Requires a DB connection. data/ is gitignored, so run locally
// against prod.
import fs from "fs";
import path from "path";
import { prisma, isDatabaseEnabled } from "../lib/database";

const APPLY = process.env.APPLY === "1";
const CSV = path.join(process.cwd(), "data", "Undelegation History.csv");

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

// A CSV date (YYYY-MM-DD) → the UTC midnight Date used as the row id.
function dayUtc(dateStr: string): Date {
  return new Date(`${dateStr.slice(0, 10)}T00:00:00.000Z`);
}

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

  const rows = parseCsv(CSV)
    .map((r) => ({ date: r.date?.slice(0, 10), value: Number(r.value) }))
    .filter((r) => r.date && Number.isFinite(r.value));
  console.log(
    `${rows.length} rows, ${rows[0]?.date} → ${rows[rows.length - 1]?.date}\n`
  );

  let written = 0;
  for (const r of rows) {
    if (written < 3 || written % 100 === 0) {
      console.log(`  ${r.date}: ${Math.round(r.value)}`);
    }
    if (APPLY) {
      const date = dayUtc(r.date);
      await prisma.undelegationDay.upsert({
        where: { date },
        create: { date, amountCompleting: r.value, source: "smartstake" },
        update: { amountCompleting: r.value, source: "smartstake" },
      });
    }
    written++;
  }

  console.log(
    `\nDone. ${APPLY ? "Upserted" : "Would upsert"}: ${written}. ${APPLY ? "WRITTEN." : "(dry-run)"}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Undelegation-days import failed:", e);
  process.exit(1);
});
