import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyCronAuth } from "./cron-auth";

function withCronSecret(value: string | undefined, fn: () => void) {
  const prev = process.env.CRON_SECRET;
  if (value === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  }
}

test("verifyCronAuth: returns 500 uncached when CRON_SECRET is unset", () => {
  const origError = console.error;
  console.error = () => {};
  try {
    withCronSecret(undefined, () => {
      const res = verifyCronAuth(
        new Request("http://localhost/api/cron/test"),
        "test"
      );
      assert.ok(res);
      assert.equal(res.status, 500);
      assert.equal(res.headers.get("cache-control"), "no-store");
    });
  } finally {
    console.error = origError;
  }
});

test("verifyCronAuth: returns 401 uncached on missing or wrong bearer token", () => {
  withCronSecret("super-secret-value", () => {
    for (const auth of [
      null,
      "",
      "Bearer wrong",
      "Bearer super-secret-valuX", // same byte length
      "Basic super-secret-value",
    ]) {
      const headers = auth === null ? undefined : { authorization: auth };
      const res = verifyCronAuth(
        new Request("http://localhost/api/cron/test", { headers }),
        "test"
      );
      assert.ok(res, `expected rejection for ${String(auth)}`);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });
});

test("verifyCronAuth: returns null when bearer token matches", () => {
  withCronSecret("super-secret-value", () => {
    const res = verifyCronAuth(
      new Request("http://localhost/api/cron/test", {
        headers: { authorization: "Bearer super-secret-value" },
      }),
      "test"
    );
    assert.equal(res, null);
  });
});
