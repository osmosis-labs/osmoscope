// CSV exports carry onchain strings (validator monikers, asset symbols), so a
// cell a spreadsheet would run as a formula must be neutralised, while plain
// numbers stay numbers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeCsvField, toCsv } from "./csv";

test("text that would start a formula is prefixed with a quote", () => {
  assert.equal(
    escapeCsvField('=HYPERLINK("http://x","y")'),
    `"'=HYPERLINK(""http://x"",""y"")"`
  );
  assert.equal(escapeCsvField("+1+cmd"), "'+1+cmd");
  assert.equal(escapeCsvField("-2+3"), "'-2+3");
  assert.equal(escapeCsvField("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(escapeCsvField("\tTab"), "'\tTab");
});

test("plain numbers and ordinary text are unchanged", () => {
  assert.equal(escapeCsvField(-5), "-5");
  assert.equal(escapeCsvField("-0.5%"), "-0.5%");
  assert.equal(escapeCsvField("+12.25"), "+12.25");
  assert.equal(escapeCsvField("Keplr"), "Keplr");
  assert.equal(escapeCsvField("a,b"), '"a,b"');
  assert.equal(escapeCsvField(null), "");
});

test("toCsv neutralises cells and headers alike", () => {
  const csv = toCsv([{ moniker: "=cmd", share: -1.5 }]);
  assert.equal(csv, "moniker,share\r\n'=cmd,-1.5");
});
