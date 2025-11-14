/* eslint-disable @typescript-eslint/no-require-imports, no-console */
const fs = require("fs");

const history = JSON.parse(fs.readFileSync("data/history.json", "utf8"));

console.log("Total records:", history.length);
console.log(
  "Date range:",
  history[0].timestamp,
  "to",
  history[history.length - 1].timestamp
);
console.log("\n=== Field Coverage Analysis ===\n");

// Check which fields exist across all records
const fieldCoverage = {};
const fields = [
  "restrictedSupply",
  "communitySupply",
  "totalStaked",
  "stakingApr",
  "totalRevenue",
  "takerFeesRevenue",
  "protorevRevenue",
  "txnFeesRevenue",
  "mevRevenue",
];

fields.forEach((field) => {
  const count = history.filter(
    (r) => r[field] !== undefined && r[field] !== null
  ).length;
  fieldCoverage[field] = {
    count,
    percentage: ((count / history.length) * 100).toFixed(1) + "%",
    missing: history.length - count,
  };
});

console.log("Field Coverage:");
Object.entries(fieldCoverage).forEach(([field, stats]) => {
  console.log(
    `  ${field}: ${stats.count}/${history.length} (${stats.percentage}) - ${stats.missing} missing`
  );
});

// Check for modeled vs real data
console.log("\n=== Modeled Data Check ===\n");
const restrictedValues = new Set(
  history.filter((r) => r.restrictedSupply).map((r) => r.restrictedSupply)
);
const communityValues = new Set(
  history.filter((r) => r.communitySupply).map((r) => r.communitySupply)
);

console.log("Unique restrictedSupply values:", Array.from(restrictedValues));
console.log("Unique communitySupply values:", Array.from(communityValues));

console.log("\n=== Sample Records ===\n");
console.log("First record:", history[0].timestamp);
console.log("  Keys:", Object.keys(history[0]).sort().join(", "));

console.log(
  "\nMiddle record:",
  history[Math.floor(history.length / 2)].timestamp
);
console.log(
  "  Keys:",
  Object.keys(history[Math.floor(history.length / 2)])
    .sort()
    .join(", ")
);

console.log("\nLast record:", history[history.length - 1].timestamp);
console.log(
  "  Keys:",
  Object.keys(history[history.length - 1])
    .sort()
    .join(", ")
);
