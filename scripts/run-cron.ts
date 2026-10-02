// Runs one /api/cron/* route in-process, outside the web host:
//
//   yarn cron <snapshot|treasury|revenue|rate-limits>
//
// The scheduled GitHub Actions workflow (.github/workflows/cron.yml) uses this
// so the crons need no CPU or subrequest budget from the web host. It calls
// the route's GET handler directly with a per-run CRON_SECRET, so the routes'
// existing auth check passes without a shared secret. Exits non-zero when the
// route answers with an error status, so a failed run fails the job.
import { randomBytes } from "node:crypto";

const CRONS = ["snapshot", "treasury", "revenue", "rate-limits"] as const;
type Cron = (typeof CRONS)[number];

async function main() {
  const name = process.argv[2] as Cron;
  if (!CRONS.includes(name)) {
    console.error(`usage: yarn cron <${CRONS.join("|")}>`);
    process.exit(2);
  }

  process.env.CRON_SECRET ||= randomBytes(32).toString("hex");
  const { GET } = await import(`../app/api/cron/${name}/route`);
  const request = new Request(`http://localhost/api/cron/${name}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
  });

  const started = Date.now();
  const response: Response = await GET(request);
  const body = await response.text();
  console.log(
    `${name}: ${response.status} in ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
  console.log(body);
  process.exit(response.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
