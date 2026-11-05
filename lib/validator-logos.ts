import { prisma, isDatabaseEnabled } from "./database";
import { logger } from "./logger";
import type { ValidatorInfo } from "./validators";

// Validator logos for the voting-power treemap, stored in our own database so the
// page never loads a third-party image URL. Source: each validator's onchain
// Keybase identity (description.identity) -> the Keybase user lookup API -> the
// avatar image, downloaded and stored as bytes in ValidatorLogo.

// Re-fetch a stored logo (or re-check a "Keybase has no picture" row) this often.
const REFRESH_MS = 7 * 86_400_000;
// Keybase avatars are ~20-40 KB; refuse anything bigger rather than store it.
const MAX_BYTES = 200_000;
// Raster types only: an SVG served from our origin could carry script.
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FETCH_TIMEOUT_MS = 10_000;
const CONCURRENCY = 4;

interface KeybaseLookup {
  status?: { code?: number };
  them?: Array<{ pictures?: { primary?: { url?: string } } } | null>;
}

type LogoFetch =
  | { kind: "image"; contentType: string; data: Uint8Array<ArrayBuffer> }
  | { kind: "none" } // Keybase answered: no user or no picture for this identity
  | { kind: "error"; reason: string }; // transient: write nothing, retry next run

async function fetchKeybaseLogo(identity: string): Promise<LogoFetch> {
  try {
    const lookup = await fetch(
      `https://keybase.io/_/api/1.0/user/lookup.json?key_suffix=${encodeURIComponent(identity)}&fields=pictures`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!lookup.ok) return { kind: "error", reason: `lookup ${lookup.status}` };
    const body = (await lookup.json()) as KeybaseLookup;
    if (body.status?.code !== 0)
      return { kind: "error", reason: `lookup code ${body.status?.code}` };
    const url = body.them?.[0]?.pictures?.primary?.url;
    if (!url || !url.startsWith("https://")) return { kind: "none" };

    const img = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!img.ok) return { kind: "error", reason: `image ${img.status}` };
    const contentType = (img.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_TYPES.has(contentType)) return { kind: "none" };
    const data = new Uint8Array(await img.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > MAX_BYTES)
      return { kind: "none" };
    return { kind: "image", contentType, data };
  } catch (e) {
    return {
      kind: "error",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface LogoRefreshResult {
  due: number;
  stored: number;
  noPicture: number;
  failed: number;
  removed: number;
}

// Bring ValidatorLogo in line with the bonded set: fetch logos that are missing,
// older than REFRESH_MS or whose identity changed, and drop rows for validators
// that left the set or cleared their identity. A failed fetch writes nothing, so
// the previous logo (if any) keeps serving until the next run. Never throws.
export async function refreshValidatorLogos(
  validators: ValidatorInfo[]
): Promise<LogoRefreshResult | { skipped: string }> {
  if (!isDatabaseEnabled()) return { skipped: "database-disabled" };
  try {
    const withIdentity = validators.filter(
      (v): v is ValidatorInfo & { identity: string } => !!v.identity
    );
    const rows = await prisma.validatorLogo.findMany({
      select: { operatorAddress: true, identity: true, fetchedAt: true },
    });
    const rowByOperator = new Map(rows.map((r) => [r.operatorAddress, r]));
    const now = Date.now();
    const due = withIdentity.filter((v) => {
      const row = rowByOperator.get(v.operatorAddress);
      return (
        !row ||
        row.identity !== v.identity ||
        now - row.fetchedAt.getTime() > REFRESH_MS
      );
    });

    const keep = new Set(withIdentity.map((v) => v.operatorAddress));
    const gone = rows
      .map((r) => r.operatorAddress)
      .filter((op) => !keep.has(op));
    if (gone.length > 0)
      await prisma.validatorLogo.deleteMany({
        where: { operatorAddress: { in: gone } },
      });

    const result: LogoRefreshResult = {
      due: due.length,
      stored: 0,
      noPicture: 0,
      failed: 0,
      removed: gone.length,
    };
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      await Promise.all(
        due.slice(i, i + CONCURRENCY).map(async (v) => {
          const logo = await fetchKeybaseLogo(v.identity);
          if (logo.kind === "error") {
            result.failed++;
            logger.warn(
              `Validator logo fetch failed for ${v.moniker}: ${logo.reason}`
            );
            return;
          }
          const fields =
            logo.kind === "image"
              ? { contentType: logo.contentType, data: logo.data }
              : { contentType: null, data: null };
          await prisma.validatorLogo.upsert({
            where: { operatorAddress: v.operatorAddress },
            create: {
              operatorAddress: v.operatorAddress,
              identity: v.identity,
              fetchedAt: new Date(),
              ...fields,
            },
            update: { identity: v.identity, fetchedAt: new Date(), ...fields },
          });
          if (logo.kind === "image") result.stored++;
          else result.noPicture++;
        })
      );
    }
    return result;
  } catch (e) {
    logger.warn(
      `Validator logo refresh failed (non-critical): ${e instanceof Error ? e.message : String(e)}`
    );
    return { skipped: e instanceof Error ? e.message : "Unknown error" };
  }
}
