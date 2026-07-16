// Locks the precedence semantics of the symbol -> logo join, which are
// otherwise only observable against live data: assetlist-first on duplicate
// symbols, Numia vocabulary joined through the shared denom, curated overrides
// winning unconditionally, and the host allowlist.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSymbolLogoMapFrom } from "./asset-logos";

const gh = (path: string) => `https://raw.githubusercontent.com/${path}`;

const NO_OVERRIDES = { denomSymbol: {}, priceByDenom: {} };

test("assetlist symbol maps to its own logo", () => {
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "OSMO",
        coinMinimalDenom: "uosmo",
        logoURIs: { svg: gh("osmo.svg") },
      },
    ],
    [],
    NO_OVERRIDES
  );
  assert.equal(map.OSMO, gh("osmo.svg"));
});

test("drifted Numia symbol resolves via the shared denom", () => {
  // Assetlist: STARS.og; Numia calls the same denom STARS.legacy — both must
  // land on the same logo (the real-world case that motivated the join).
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "STARS.og",
        coinMinimalDenom: "ibc/987C17",
        logoURIs: { png: gh("stars.png") },
      },
    ],
    [{ symbol: "STARS.legacy", denom: "ibc/987C17" }],
    NO_OVERRIDES
  );
  assert.equal(map["STARS.og"], gh("stars.png"));
  assert.equal(map["STARS.legacy"], gh("stars.png"));
});

test("duplicate assetlist symbol: first entry wins", () => {
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "WBTC",
        coinMinimalDenom: "factory/alloyed/wbtc",
        logoURIs: { svg: gh("wbtc-alloy.svg") },
      },
      {
        symbol: "WBTC",
        coinMinimalDenom: "ibc/variant",
        logoURIs: { svg: gh("wbtc-variant.svg") },
      },
    ],
    [],
    NO_OVERRIDES
  );
  assert.equal(map.WBTC, gh("wbtc-alloy.svg"));
});

test("Numia symbol never overwrites an existing assetlist symbol", () => {
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "APT",
        coinMinimalDenom: "ibc/meme-apt",
        logoURIs: { svg: gh("apt-meme.svg") },
      },
      {
        symbol: "APT.real",
        coinMinimalDenom: "ibc/aptos",
        logoURIs: { svg: gh("aptos.svg") },
      },
    ],
    [{ symbol: "APT", denom: "ibc/aptos" }],
    NO_OVERRIDES
  );
  // Assetlist-first: Numia's APT (a different denom) does not repaint it.
  assert.equal(map.APT, gh("apt-meme.svg"));
});

test("curated overrides win unconditionally over assetlist symbols", () => {
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "SHARK",
        coinMinimalDenom: "ibc/imposter",
        logoURIs: { svg: gh("imposter.svg") },
      },
      {
        // No symbol collision needed: override targets this denom's logo.
        symbol: "SHARK.real",
        coinMinimalDenom: "ibc/real-shark",
        logoURIs: { svg: gh("shark.svg") },
      },
    ],
    [],
    {
      denomSymbol: { "ibc/real-shark": "SHARK" },
      priceByDenom: {},
    }
  );
  // The override forces SHARK to the curated denom's logo despite the
  // assetlist listing a different asset under the same ticker.
  assert.equal(map.SHARK, gh("shark.svg"));
});

test("price-override symbols resolve via their denom", () => {
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "TOKEN.raw",
        coinMinimalDenom: "ibc/token",
        logoURIs: { svg: gh("token.svg") },
      },
    ],
    [],
    { denomSymbol: {}, priceByDenom: { "ibc/token": { symbol: "TOKEN" } } }
  );
  assert.equal(map.TOKEN, gh("token.svg"));
});

test("non-allowlisted logo hosts are rejected", () => {
  const map = buildSymbolLogoMapFrom(
    [
      {
        symbol: "EVIL",
        coinMinimalDenom: "ibc/evil",
        logoURIs: { svg: "https://evil.example.com/logo.svg" },
      },
    ],
    [],
    NO_OVERRIDES
  );
  assert.equal(map.EVIL, undefined);
});

test("assets without logos or symbols are skipped without error", () => {
  const map = buildSymbolLogoMapFrom(
    [
      { symbol: "NOLOGO", coinMinimalDenom: "ibc/nologo" },
      { coinMinimalDenom: "ibc/nosymbol", logoURIs: { svg: gh("x.svg") } },
    ],
    [{ symbol: "GHOST", denom: "ibc/unknown" }],
    NO_OVERRIDES
  );
  assert.deepEqual(map, {});
});
