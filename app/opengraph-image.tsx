import { ImageResponse } from "next/og";

// Branded 1200x630 Open Graph / Twitter share card, generated at the edge (no
// binary asset, CSP-safe). Next serves this for both OG and twitter:image via
// the file-based metadata convention. Applies to the whole app (root); the
// tokenomics and treasury pages share this card.
export const runtime = "edge";
export const alt = "OSMOscope — Osmosis tokenomics and treasury";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
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
      <div style={{ fontSize: 88, fontWeight: 800, letterSpacing: "-2px" }}>
        OSMOscope
      </div>
      <div style={{ marginTop: 12, fontSize: 40, color: "#D7ADEB" }}>
        Osmosis tokenomics &amp; treasury, in focus
      </div>
      <div style={{ marginTop: 40, fontSize: 26, color: "#C384E1" }}>
        Supply · Inflation · Burn · Staking · Protocol revenue · DAO treasury
      </div>
    </div>,
    { ...size }
  );
}
