// CSV serialization + download helper, shared by the chart action cluster
// (ScreenshotButtons). No standalone button: the CSV control is rendered inside
// the same pill as the X-share and copy icons so it reads as one group.

// A single CSV cell value. null / undefined serialize to an empty field.
export type CsvValue = string | number | boolean | null | undefined;
// One row, keyed by column header. Every row should carry the same keys; the
// header order is taken from `columns` (or the first row's key order).
export type CsvRow = Record<string, CsvValue>;

// RFC 4180 field escaping: wrap in double quotes and double any embedded quotes
// when the value contains a comma, quote, or newline. Numbers/booleans stringify
// plainly; null/undefined become empty.
function escapeCsvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function toCsv(rows: CsvRow[], columns?: string[]): string {
  if (rows.length === 0) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const header = cols.map(escapeCsvField).join(",");
  const body = rows
    .map((row) => cols.map((c) => escapeCsvField(row[c])).join(","))
    .join("\r\n");
  return `${header}\r\n${body}`;
}

// Serialize rows to CSV and trigger a browser download. Returns false (no file)
// when there are no rows, so the caller can surface an "empty" hint. Client-side
// only (no dependency, no network).
export function downloadCsv(
  filename: string,
  rows: CsvRow[],
  columns?: string[]
): boolean {
  if (!rows || rows.length === 0) return false;
  // Prepend a UTF-8 BOM so Excel opens non-ASCII (denoms, ·) correctly.
  const csv = "﻿" + toCsv(rows, columns);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}-${new Date().toISOString().split("T")[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  return true;
}
