import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number, decimals: number = 2): string {
  if (num >= 1_000_000_000) {
    const value = num / 1_000_000_000;
    const precision = value < 10 ? 1 : 0;
    let formatted = value.toFixed(precision);
    // Remove ".0" suffix if present (e.g., 10.0 → 10)
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "B";
  }
  if (num >= 1_000_000) {
    const value = num / 1_000_000;
    const precision = value < 10 ? 1 : 0;
    let formatted = value.toFixed(precision);
    // Remove ".0" suffix if present (e.g., 10.0 → 10)
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "M";
  }
  if (num >= 1_000) {
    const value = num / 1_000;
    const precision = value < 10 ? 1 : 0;
    let formatted = value.toFixed(precision);
    // Remove ".0" suffix if present (e.g., 10.0 → 10)
    if (formatted.endsWith(".0")) {
      formatted = formatted.slice(0, -2);
    }
    return formatted + "K";
  }
  return num.toFixed(decimals);
}

export function formatCurrency(num: number, decimals: number = 2): string {
  return "$" + formatNumber(num, decimals);
}

export function formatPercentage(num: number, decimals: number = 2): string {
  return num.toFixed(decimals) + "%";
}

export function formatNumberWithCommas(
  num: number,
  decimals: number = 0
): string {
  return num.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

type ChartRange = "all" | "1y" | "90d" | "30d" | "7d";

// Per-point x-axis label (also used as the chart's date key and in tooltips).
// On the wide timeframes ("all"/"1y") use Month + full Year (e.g. "Apr 2026") so
// the year is always visible; on the shorter ones use day + month (e.g. "19 Nov")
// where the year is unambiguous and day-level detail matters.
export function formatChartDate(
  timestamp: string,
  timeRange: ChartRange
): string {
  const wide = timeRange === "all" || timeRange === "1y";
  return new Date(timestamp).toLocaleDateString(
    "en-GB",
    wide
      ? { month: "short", year: "numeric" }
      : { day: "2-digit", month: "short" }
  );
}

// One x-axis tick per MONTH on the wide timeframes ("all"/"1y"). Returns the
// `ticks` array of labels at the FIRST data point of each calendar month, so
// Recharts shows exactly one "MMM yyyy" tick per month instead of one per day
// (every day in a month shares the same label, which otherwise renders as many
// overlapping ticks). Returns undefined on short timeframes (default per-point
// ticks). `labels` and `timestamps` are the per-point values, same order.
export function makeMonthlyTicks(
  labels: string[],
  timestamps: string[],
  timeRange: ChartRange
): string[] | undefined {
  const wide = timeRange === "all" || timeRange === "1y";
  if (!wide) return undefined;

  const ticks: string[] = [];
  const seen = new Set<string>();
  let prevKey = "";
  timestamps.forEach((ts, i) => {
    const d = new Date(ts);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== prevKey) {
      const label = labels[i];
      if (label !== undefined && !seen.has(label)) {
        ticks.push(label);
        seen.add(label);
      }
      prevKey = key;
    }
  });
  return ticks;
}
