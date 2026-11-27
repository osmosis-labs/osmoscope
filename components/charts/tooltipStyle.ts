import type { CSSProperties } from "react";

// Shared look for every Recharts tooltip: pass as `contentStyle`, or spread
// into a custom tooltip's wrapper (add padding; contentStyle gets it from
// Recharts' default).
export const CHART_TOOLTIP_STYLE: CSSProperties = {
  backgroundColor: "rgba(31, 10, 41, 0.95)",
  backdropFilter: "blur(12px)",
  border: "1px solid rgba(255, 255, 255, 0.2)",
  borderRadius: "8px",
  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.25)",
};
