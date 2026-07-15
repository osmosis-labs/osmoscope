#!/usr/bin/env tsx
// Reconcile the cumulative OSMO-burn series on HistoricalRecord.burnedSupply with
// SmartStake's authoritative Burn Trend export (data/Burn Trend.csv, gitignored).
//
// Why: our daily snapshot occasionally lags — it captures two days' burn on one
// day and none the next — so the DERIVED daily-burn view shows a spike-then-zero
// artifact even though the cumulative total is right. SmartStake's cumulativeBurn
// is the same series without that lag, and the two already agree exactly on every
// unaffected day (verified). Overwriting burnedSupply with SmartStake's cumulative
// therefore only corrects the lagged days (and brings the latest day current); it
// never shifts the total off the authoritative figure.
//
// Matches each CSV row to an EXISTING HistoricalRecord by calendar day (UTC) and
// updates it — never inserts, so it can't create phantom days. Idempotent; dry-run
// by default, set APPLY=1 to write. Requires a DB connection.
//
// ONE-SHOT in practice: SmartStake's Osmosis pages are gone, so no fresh CSV will
// exist. Re-running with the original CSV is safe (idempotent) but pointless.
import fs from "fs";
import path from "path";
import { prisma, isDatabaseEnabled } from "../lib/database";

const APPLY = process.env.APPLY === "1";
const CSV = path.join(process.cwd(), "data", "Burn Trend.csv");
// Only report/rewrite when the cumulative differs by more than this (OSMO), so
// float noise in the CSV vs stored Decimal doesn't churn every row.
const EPSILON = 0.5;

// Minimal CSV parse: strips a UTF-8 BOM and surrounding quotes. The SmartStake
// export has no embedded commas in the columns we read.
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
  if (!fs.existsSync(CSV)) {
    console.error(`❌ Missing ${CSV}`);
    process.exit(1);
  }
  console.log(
    APPLY
      ? "APPLY mode — will write.\n"
      : "DRY-RUN — no writes (APPLY=1 to write).\n"
  );

  // date(YYYY-MM-DD) -> authoritative cumulative burn.
  const ssCum = new Map<string, number>();
  for (const r of parseCsv(CSV)) {
    const date = r.title?.slice(0, 10);
    const cum = Number(r.cumulativeBurn);
    if (date && Number.isFinite(cum)) ssCum.set(date, cum);
  }
  const ssDays = [...ssCum.keys()].sort();
  console.log(
    `SmartStake CSV: ${ssCum.size} rows, ${ssDays[0]} → ${ssDays[ssDays.length - 1]}\n`
  );

  const rows = await prisma.historicalRecord.findMany({
    orderBy: { timestamp: "asc" },
    select: { timestamp: true, burnedSupply: true, mintedSupply: true },
  });

  let updated = 0;
  let unchanged = 0;
  let unmatched = 0; // DB days with no SmartStake row (pre-2024-06, left as-is)
  const changes: { day: string; from: number; to: number }[] = [];

  for (const r of rows) {
    const day = dayOf(r.timestamp);
    const target = ssCum.get(day);
    if (target == null) {
      unmatched++;
      continue;
    }
    const current = r.burnedSupply == null ? null : Number(r.burnedSupply);
    if (current != null && Math.abs(current - target) <= EPSILON) {
      unchanged++;
      continue;
    }
    changes.push({ day, from: current ?? 0, to: target });
    if (APPLY) {
      // Keep the stored identity totalSupply = mintedSupply − burnedSupply
      // intact: correcting burnedSupply alone would leave the row internally
      // inconsistent by the lag delta.
      const minted = r.mintedSupply == null ? null : Number(r.mintedSupply);
      await prisma.historicalRecord.update({
        where: { timestamp: r.timestamp },
        data: {
          burnedSupply: target,
          ...(minted != null ? { totalSupply: minted - target } : {}),
        },
      });
    }
    updated++;
  }

  // Show the corrected days (there should only be a handful — the lagged ones).
  if (changes.length) {
    console.log(`Days corrected (${changes.length}):`);
    for (const c of changes)
      console.log(
        `  ${c.day}: ${Math.round(c.from)} → ${Math.round(c.to)}  (Δ ${Math.round(c.to - c.from)})`
      );
    console.log("");
  }

  console.log(
    `Done. ${APPLY ? "Updated" : "Would update"}: ${updated}, already-current: ${unchanged}, ` +
      `pre-CSV days left as-is: ${unmatched}. ${APPLY ? "WRITTEN." : "(dry-run)"}`
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Burn-history import failed:", e);
  process.exit(1);
});
