// Shared UTC calendar-day and hour bucketing helpers used by snapshot storage,
// cron deduping, and validator daily indexing.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const toDate = (value: Date | string): Date =>
  value instanceof Date ? value : new Date(value);

// UTC midnight (00:00:00.000Z) of the calendar day containing `ts`.
export function utcDayStart(ts: Date): Date {
  return new Date(
    Date.UTC(ts.getUTCFullYear(), ts.getUTCMonth(), ts.getUTCDate())
  );
}

// Half-open [dayStart, dayEnd) interval covering `ts`'s UTC calendar day.
export function utcDayBounds(ts: Date): { dayStart: Date; dayEnd: Date } {
  const dayStart = utcDayStart(ts);
  return { dayStart, dayEnd: new Date(dayStart.getTime() + DAY_MS) };
}

// Half-open [hourStart, hourEnd) interval covering `ts`'s UTC hour.
export function utcHourBounds(ts: Date): { hourStart: Date; hourEnd: Date } {
  const hourStart = new Date(
    Date.UTC(
      ts.getUTCFullYear(),
      ts.getUTCMonth(),
      ts.getUTCDate(),
      ts.getUTCHours()
    )
  );
  return { hourStart, hourEnd: new Date(hourStart.getTime() + HOUR_MS) };
}

// True when two timestamps fall on the same UTC calendar day.
export function isSameUtcDay(a: Date | string, b: Date | string): boolean {
  const da = toDate(a);
  const db = toDate(b);
  return (
    da.getUTCFullYear() === db.getUTCFullYear() &&
    da.getUTCMonth() === db.getUTCMonth() &&
    da.getUTCDate() === db.getUTCDate()
  );
}
