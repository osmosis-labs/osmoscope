"use client";

import { cn } from "@/lib/utils";

export type TimeRange = "all" | "1y" | "90d" | "30d" | "7d";

interface TimeRangeSelectorProps {
  selectedRange: TimeRange;
  onRangeChange: (range: TimeRange) => void;
}

export function TimeRangeSelector({
  selectedRange,
  onRangeChange,
}: TimeRangeSelectorProps) {
  const ranges: { value: TimeRange; label: string }[] = [
    { value: "all", label: "All" },
    { value: "1y", label: "1Y" },
    { value: "90d", label: "90D" },
    { value: "30d", label: "30D" },
    { value: "7d", label: "7D" },
  ];

  return (
    <div
      className="flex gap-1 rounded-lg bg-white/5 p-1"
      data-screenshot-compact
      data-selected-range={selectedRange}
    >
      {ranges.map((range) => (
        <button
          key={range.value}
          onClick={() => onRangeChange(range.value)}
          className={cn(
            "rounded px-3 py-1 text-xs font-medium transition-colors",
            selectedRange === range.value
              ? "bg-osmo-purple text-white"
              : "text-osmo-200 hover:text-white"
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  );
}

// Human-readable label for a time range, e.g. "Last 90 days" / "All Time".
// Shared so chart headline subtexts read consistently across the dashboard.
export function timeRangeLabel(range: TimeRange): string {
  switch (range) {
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "90d":
      return "Last 90 days";
    case "1y":
      return "Last 1 year";
    case "all":
      return "All Time";
    default:
      return "All Time";
  }
}

// Helper function to filter data based on time range
export function filterDataByTimeRange<T extends { timestamp: string }>(
  data: T[],
  range: TimeRange
): T[] {
  if (range === "all" || data.length === 0) {
    return data;
  }

  const now = new Date();
  let cutoffDate: Date;

  switch (range) {
    case "1y":
      cutoffDate = new Date(now);
      cutoffDate.setFullYear(cutoffDate.getFullYear() - 1);
      break;
    case "90d":
      cutoffDate = new Date(now);
      cutoffDate.setDate(cutoffDate.getDate() - 90);
      break;
    case "30d":
      cutoffDate = new Date(now);
      cutoffDate.setDate(cutoffDate.getDate() - 30);
      break;
    case "7d":
      cutoffDate = new Date(now);
      cutoffDate.setDate(cutoffDate.getDate() - 7);
      break;
    default:
      return data;
  }

  return data.filter((record) => new Date(record.timestamp) >= cutoffDate);
}
