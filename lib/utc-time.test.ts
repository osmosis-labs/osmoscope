import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSameUtcDay,
  utcDayBounds,
  utcDayStart,
  utcHourBounds,
} from "./utc-time";

test("utcDayStart and utcDayBounds bracket the UTC calendar day", () => {
  const ts = new Date("2026-11-27T17:45:12.345Z");
  assert.equal(utcDayStart(ts).toISOString(), "2026-11-27T00:00:00.000Z");
  const { dayStart, dayEnd } = utcDayBounds(ts);
  assert.equal(dayStart.toISOString(), "2026-11-27T00:00:00.000Z");
  assert.equal(dayEnd.toISOString(), "2026-11-28T00:00:00.000Z");
});

test("utcHourBounds brackets the UTC hour across day/year rollovers", () => {
  const { hourStart, hourEnd } = utcHourBounds(
    new Date("2026-12-31T23:59:59.999Z")
  );
  assert.equal(hourStart.toISOString(), "2026-12-31T23:00:00.000Z");
  assert.equal(hourEnd.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("isSameUtcDay compares UTC dates across Date and ISO string inputs", () => {
  assert.equal(
    isSameUtcDay("2026-11-27T00:00:00.000Z", new Date("2026-11-27T23:59:59Z")),
    true
  );
  assert.equal(
    isSameUtcDay("2026-11-27T23:59:59.999Z", "2026-11-28T00:00:00.000Z"),
    false
  );
});
