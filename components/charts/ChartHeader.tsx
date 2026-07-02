"use client";

import { CardTitle } from "../ui/Card";
import { TimeRangeSelector, TimeRange } from "../TimeRangeSelector";
import { ScreenshotButtons } from "../ScreenshotButtons";
import type { CsvRow } from "@/lib/csv";
import type { RefObject, ReactNode } from "react";

interface ChartHeaderProps {
  title: string;
  timeRange: TimeRange;
  onRangeChange: (range: TimeRange) => void;
  /** Card ref for the screenshot capture. */
  cardRef: RefObject<HTMLDivElement | null>;
  /** Screenshot download filename (no extension). */
  screenshotFilename: string;
  /** Context-aware caption prefilled into the X composer for this chart. */
  shareText?: string;
  /**
   * Full-history rows for the CSV export (built lazily on click). Omit for
   * sections with a single data point (e.g. the burn doughnut), where a CSV
   * would be one row and isn't useful — the button is then hidden.
   */
  csvRows?: () => CsvRow[];
  /** CSV download filename (no extension). Defaults to screenshotFilename. */
  csvFilename?: string;
  /** Big headline figure shown at the right (e.g. a total / current value). */
  headlineValue?: ReactNode;
  /** Small label under the headline value. */
  headlineLabel?: ReactNode;
  /** Tailwind text-color class for the headline value. */
  headlineColor?: string;
  /** Extra controls (e.g. a standard/cumulative toggle) rendered with the selector. */
  extraControls?: ReactNode;
}

// Shared, responsive chart card header. Replaces the title + TimeRangeSelector +
// ScreenshotButtons + headline-stat row that was copy-pasted across every chart.
//
// Layout: the left column holds title, controls (time range + any extra toggle),
// and the screenshot button; the headline pins to the top-right. On mobile the
// left column stacks into three rows (title / controls / save) so nothing
// overflows a phone width. From `sm` up, title + controls + save all sit together
// on one wrapping row, dropping to additional lines only when there isn't room.
export function ChartHeader({
  title,
  timeRange,
  onRangeChange,
  cardRef,
  screenshotFilename,
  shareText,
  csvRows,
  csvFilename,
  headlineValue,
  headlineLabel,
  headlineColor = "text-white",
  extraControls,
}: ChartHeaderProps) {
  return (
    // The LEFT column's height drives the layout (so the taller two-line headline
    // on the right doesn't push the controls down); the headline sizes to its own
    // content, so it works for any width.
    <div className="flex items-start justify-between gap-3">
      {/* Title + controls + save: stacked on mobile, one wrapping row from `sm` up. */}
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
        <CardTitle>{title}</CardTitle>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <TimeRangeSelector
            selectedRange={timeRange}
            onRangeChange={onRangeChange}
          />
          {extraControls}
        </div>
        <ScreenshotButtons
          targetRef={cardRef}
          filename={screenshotFilename}
          shareText={shareText}
          csvRows={csvRows}
          csvFilename={csvFilename}
        />
      </div>
      {headlineValue != null && (
        <div className="shrink-0 text-right">
          <div className={`text-2xl font-bold sm:text-3xl ${headlineColor}`}>
            {headlineValue}
          </div>
          {headlineLabel != null && (
            <div className="text-xs text-osmo-200">{headlineLabel}</div>
          )}
        </div>
      )}
    </div>
  );
}
