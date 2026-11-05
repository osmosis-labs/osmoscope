#!/usr/bin/env tsx
// Store a validator logo by hand, for bonded validators Keybase has no picture
// for (or no identity at all). The snapshot cron keeps a stored image when
// Keybase answers with nothing (lib/validator-logos.ts), so a logo set here
// stays until the validator publishes a Keybase picture of its own.
//
//   yarn tsx scripts/import-validator-logo.ts <osmovaloper1…> <image file>
//
// JPEG, PNG or WebP up to MAX_BYTES; the type is read from the file's bytes,
// not its name. Dry-run by default; APPLY=1 writes. Requires a DB connection.
import fs from "fs";
import { prisma, isDatabaseEnabled } from "../lib/database";
import { fetchBondedValidators } from "../lib/validators";
import { ALLOWED_TYPES, MAX_BYTES } from "../lib/validator-logos";

const APPLY = process.env.APPLY === "1";

function sniffType(data: Uint8Array): string | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    return "image/jpeg";
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  )
    return "image/png";
  if (
    Buffer.from(data.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(data.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp";
  return null;
}

async function main() {
  const [operator, file] = process.argv.slice(2);
  if (!operator || !file) {
    console.error(
      "usage: tsx scripts/import-validator-logo.ts <osmovaloper1…> <image file>"
    );
    process.exit(2);
  }
  const data = new Uint8Array(fs.readFileSync(file));
  const contentType = sniffType(data);
  if (!contentType || !ALLOWED_TYPES.has(contentType))
    throw new Error(`${file}: not a JPEG, PNG or WebP image`);
  if (data.byteLength > MAX_BYTES)
    throw new Error(`${file}: ${data.byteLength} bytes, over ${MAX_BYTES}`);

  // Only bonded validators: the cron drops rows for anyone outside the set.
  const validator = (await fetchBondedValidators()).find(
    (v) => v.operatorAddress === operator
  );
  if (!validator) throw new Error(`${operator} is not in the bonded set`);

  console.log(
    `${validator.moniker}: ${contentType}, ${data.byteLength} bytes, identity ${validator.identity ?? "(none)"}`
  );
  if (!APPLY) {
    console.log("Dry run; set APPLY=1 to write.");
    return;
  }
  if (!isDatabaseEnabled()) throw new Error("No database configured");
  // identity is recorded as the validator's current one, so the cron treats the
  // row as up to date rather than as an identity change.
  const fields = {
    identity: validator.identity ?? "",
    contentType,
    data,
    fetchedAt: new Date(),
  };
  await prisma.validatorLogo.upsert({
    where: { operatorAddress: operator },
    create: { operatorAddress: operator, ...fields },
    update: fields,
  });
  console.log("Stored.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
