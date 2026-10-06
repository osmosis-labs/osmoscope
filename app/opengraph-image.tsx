import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SITE_URL } from "@/lib/site";

// Branded 1200x630 Open Graph / Twitter share card. Next serves this for both
// OG and twitter:image via the file-based metadata convention. Applies to the
// whole app (root); the tokenomics and treasury pages share this card.
//
// Node runtime (not edge) so we can read the logo PNG off disk and inline it as
// a data URI. ImageResponse can't load a remote/relative asset without an
// absolute host, and inlining keeps it CSP-safe and self-contained. On
// Cloudflare Workers there is no filesystem holding public/ (it is served as
// static assets), so the logo is fetched from the site's own URL instead.
export const runtime = "nodejs";
export const alt = "OSMOscope: Osmosis tokenomics and treasury";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function loadIcon(): Promise<Buffer> {
  try {
    return await readFile(join(process.cwd(), "public", "Osmosis_Icon.png"));
  } catch {
    const response = await fetch(new URL("/Osmosis_Icon.png", SITE_URL));
    if (!response.ok) {
      throw new Error(`Osmosis_Icon.png: ${response.status} from ${SITE_URL}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

export default async function OpengraphImage() {
  const iconData = await loadIcon();
  const iconSrc = `data:image/png;base64,${iconData.toString("base64")}`;

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: "80px",
        // OSMOscope dark gradient (osmo-900 -> osmo-800 -> osmo-900).
        backgroundImage:
          "linear-gradient(135deg, #1F0A29 0%, #3E1452 50%, #1F0A29 100%)",
        color: "#ffffff",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 28 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse renders to a static PNG; next/image is not available here. */}
        <img src={iconSrc} width={104} height={104} alt="" />
        <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: "-2px" }}>
          OSMOscope
        </div>
      </div>
      <div style={{ marginTop: 40, fontSize: 26, color: "#C384E1" }}>
        Supply · Inflation · Burn · Staking · Protocol revenue · DAO treasury
      </div>
    </div>,
    { ...size }
  );
}
