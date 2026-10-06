import { test } from "node:test";
import assert from "node:assert/strict";
import { missingReadingHours, CATCH_UP_HOURS } from "./catch-up";

const H = 3_600_000;
const at = (iso: string) => new Date(iso).getTime();

test("lists complete hours without readings, newest first", () => {
  const now = at("2026-10-06T12:20:00Z");
  const present = new Set(
    Array.from(
      { length: CATCH_UP_HOURS },
      (_, i) => at("2026-10-06T11:00:00Z") - i * H
    )
  );
  present.delete(at("2026-10-06T09:00:00Z"));
  present.delete(at("2026-10-06T07:00:00Z"));
  assert.deepEqual(missingReadingHours(present, now), [
    at("2026-10-06T09:00:00Z"),
    at("2026-10-06T07:00:00Z"),
  ]);
});

test("never includes the current hour", () => {
  const now = at("2026-10-06T12:20:00Z");
  const missing = missingReadingHours(new Set(), now, 3);
  assert.deepEqual(missing, [
    at("2026-10-06T11:00:00Z"),
    at("2026-10-06T10:00:00Z"),
    at("2026-10-06T09:00:00Z"),
  ]);
});

test("nothing missing when every hour has readings", () => {
  const now = at("2026-10-06T12:20:00Z");
  const present = new Set(
    Array.from(
      { length: CATCH_UP_HOURS },
      (_, i) => at("2026-10-06T11:00:00Z") - i * H
    )
  );
  assert.deepEqual(missingReadingHours(present, now), []);
});
