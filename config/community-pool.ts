// Curated configuration for the community-pool / DAO-treasury display.
//
// This is hand-maintained knowledge that cannot be derived from the chain:
//   - which addresses are community-pool-controlled (subDAOs, forwarders, the
//     Grants Program's Ethereum treasury, etc.)
//   - price / symbol / exponent overrides for denoms the price API gets wrong
//   - the Magma and Margined vault contracts whose balances must be unwound
//   - the Ethereum RPC + ERC20 allowlist for the EVM-held treasury
//
// Ported from the Osmosis community-pool Google Sheet's Apps Script so the
// dashboard's treasury numbers tie out to that tracker. Keep in sync with it.

// ---------------------------------------------------------------------------
// Associated addresses (the "DAO treasury across all addresses" view).
// osmo1... are queried for bank balances + CL positions (+ Magma for the BABY
// Liquidity vault holder); the 0x... entry is queried on Ethereum mainnet.
// ---------------------------------------------------------------------------
export interface AssociatedAddress {
  address: string;
  label: string;
  chain: "osmosis" | "ethereum";
  // Optional grouping key. Addresses sharing a `group` are merged into one holder
  // in the treasury breakdown (their values summed) under `groupLabel`, while each
  // underlying address is still surfaced (e.g. for explorer links). Used to fold
  // the Grants Program's Osmosis + Ethereum treasuries into a single "Grants" row.
  group?: string;
  groupLabel?: string;
  // Curated one-paragraph explainer shown as a `?` hover on the holder card:
  // what the address is, how it's funded, and what it does with the funds. On a
  // grouped holder the group's members share one description (set it on any
  // member; the first non-empty one wins).
  description?: string;
}

export const ASSOCIATED_ADDRESSES: AssociatedAddress[] = [
  {
    address: "osmo15dwvndrzndzy7nls57rvq379xeta3dlt467dxerxc4pvkul0thvq6umm9z",
    label: "Osmosis Grants Program",
    chain: "osmosis",
    group: "grants",
    groupLabel: "Osmosis Grants Program",
    description:
      "The community-funded grants treasury. Funded by community-pool spend proposals, it disburses grants to teams building on Osmosis. More information at grants.osmosis.zone",
  },
  {
    address: "osmo1fq3wmetv8xme6v0fn53ujdmtazgz5f04vz3ta9d7qdz8gmrxwpwsy9kelc",
    label: "Osmosis Support Lab",
    chain: "osmosis",
    description:
      "Deprecated, included for completeness. Its functionality has been taken over by the Osmosis Grants Program.",
  },
  {
    address: "osmo1rvq5cq2j35k7sqqz49e5e8zezl45fcywcawazh46qnc0g96d0d6sasqsgc",
    label: "Osmosis Liquidity subDAO",
    chain: "osmosis",
    description:
      "A subDAO funded by the community pool that executes on proposals requiring time-sensitive, multistep, or cross-chain transactions that governance itself cannot perform.",
  },
  {
    address: "osmo128laly00yvpr69usz6s9n7j8f8sx6780npyauyt9ku46mpwx2n5qsxapq6",
    label: "Neutron Multisig: Proposal 700",
    chain: "osmosis",
    description:
      "A multisig funded by community-pool Proposal 700 to hold and deploy the allocation tied to that proposal. Manages those funds on behalf of the DAO.",
  },
  {
    address: "osmo1qzm2kyesqqpu4d7uaskkf023t4husm6vaan2gkc2xru0xcvzx23qq5f5c7",
    label: "Levana Multisig: Proposal 655",
    chain: "osmosis",
    description:
      "A multisig funded by community-pool Proposal 655 to hold and deploy the allocation tied to that proposal.",
  },
  {
    address: "osmo1y9fy0l9e9f3j2hqc30wpr6u3u6s6wwdzw2pnrlswr696v4n805xqe7kndr",
    label: "USDN Yield: USDN Forwarder",
    chain: "osmosis",
    description:
      "Yield earned by the protocol for USDN usage on Osmosis, awaiting forward to the community pool.",
  },
  {
    address: "osmo1jayxmrajq8nzw2knatgsjdkdhnkw8flkgqs84pvphs3ut2hts5xq9hacch",
    label: "Top of Block Auction: USDC Forwarder",
    chain: "osmosis",
    description:
      "Collects the USDC proceeds of the top-of-block (block-space) auction and forwards them to the community pool. Balances here are auction revenue awaiting forwarding.",
  },
  {
    address: "osmo1f3xhl0gqmyhnu49c8k3j7fkdv75ug0xjtaqu09",
    label: "Taker Fees to Community Pool (Staging)",
    chain: "osmosis",
    description:
      "A txfees staging account holding taker fees paid in non-OSMO tokens. Each epoch the balance is swapped to the community-pool revenue token (BTC, set by Prop 952) and sent to the community pool. Balances here are fees awaiting that swap.",
  },
  {
    address: "osmo1yche2ydjamy8uwtg7tssm362467ku7rr7kwy2x",
    label: "Taker Fees to Stakers (Staging)",
    chain: "osmosis",
    description:
      "A txfees staging account holding the stakers' share of taker fees in non-OSMO tokens. Each epoch the balance is swapped to OSMO and distributed to stakers. Balances here are fees awaiting that swap.",
  },
  {
    address: "osmo1g7ajkk295vactngp74shkfrprvjrdwn662dg26",
    label: "Gas Fees to Stakers (Staging)",
    chain: "osmosis",
    description:
      "A txfees staging account holding transaction (gas) fees paid in non-OSMO tokens. Each epoch the balance is swapped to OSMO and distributed to stakers. Balances here are fees awaiting that swap.",
  },
  {
    address: "osmo144drulmhd98y4cc2p9uper5ev2n2dzr5ms6xsz",
    label: "Taker Fees to Burn (Staging)",
    chain: "osmosis",
    description:
      "A txfees staging account holding the burn share of taker fees in non-OSMO tokens. Each epoch the balance is swapped to OSMO and burned. Balances here are fees awaiting that swap.",
  },
  {
    address: "osmo1r9jc2234fljy93z80cevqjt3nmjycec8aj4cc6",
    label: "Taker Fees (Epoch Staging)",
    chain: "osmosis",
    description:
      "An intermediate txfees account that accumulates taker fees within an epoch before they are split to their destinations (community pool, stakers, burn) at epoch end.",
  },
  {
    address: "osmo1wd8rxw3j07jcj40en6q5dhcxlsr7c8ulrn29a3",
    label: "Staking Rewards Buffer (Staging)",
    chain: "osmosis",
    description:
      "The taker-fee staking-rewards buffer module account. Holds taker-fee revenue that has been converted to the staking-rewards denom, awaiting distribution to stakers. Balances here are revenue in transit.",
  },
  {
    address: "osmo17qdmjdumw4xawam4g46gtwzle5rd4zwyfqvvza",
    label: "ProtoRev Module",
    chain: "osmosis",
    description:
      "The x/protorev module account. It captures arbitrage (MEV) profit from cyclic trades against Osmosis pools. OSMO profit is burned; non-OSMO profit is sent to the community pool. Balances here are protorev profit awaiting that allocation.",
  },
  {
    address: "osmo1dqjqgxunr92wxhgq8twxjkyp0evrs9grst5q3dg59m4p3hmqr0gquguuzd",
    label: "BABY Liquidity: Proposal 919",
    chain: "osmosis",
    description:
      "Holds Bitcoin and Babylon-ecosystem liquidity under Proposal 919, which committed Osmosis to become a Bitcoin Secured Network via Babylon. Deploys BTC/BABY assets into Osmosis pools to make Osmosis the trading venue for Babylon assets.",
  },
  {
    address: "0xECbB8491952D77f54098876f3C937589A4B1c946",
    label: "Osmosis Grants Program (Ethereum)",
    chain: "ethereum",
    group: "grants",
    groupLabel: "Osmosis Grants Program",
  },
];

// The main community-pool CL positions are held by this address (the
// distribution module can't hold CL positions directly).
export const COMMUNITY_POOL_CL_ADDRESS =
  "osmo1jv65s3grqf6v6jl3dp4t6c9t9rk99cd80yhvld";

// Address whose Magma vault holdings are added to the MAIN pool breakdown.
export const COMMUNITY_POOL_MAGMA_ADDRESS =
  "osmo10d07y265gmmuvt4z0w9aw880jnsr700jjeq4qp";

// Associated address that additionally holds Magma vault positions.
export const MAGMA_HOLDER_ADDRESS =
  "osmo1dqjqgxunr92wxhgq8twxjkyp0evrs9grst5q3dg59m4p3hmqr0gquguuzd";

// ---------------------------------------------------------------------------
// Magma (CosmWasm) vault contracts. Each is a share token; the holder's share
// of the vault's bal0/bal1 is their underlying exposure.
// ---------------------------------------------------------------------------
export const MAGMA_CONTRACTS = [
  "osmo1eh2735el04mkw724pefa0vmxhvm2z3vmhckz4hcngng876l3v4fsh3e8cl",
  "osmo15zuvcyd33mma74qrhf5u7q2jzmzvpxqfmwuqzfc96v47jxw3z36sknlw6l",
  "osmo13z2d90zp0k9p62ksl97ycddvn6leaqw7z2wgys57xnugw4xgxspsjdre8s",
  "osmo17rkk7t9vgn4erw0wlshpsmn37sepwfus352dwmq9w2px05ewucaq4zfdl5",
];

// Contracts whose bal0/bal1 are stored reversed relative to the symbol order.
export const MAGMA_BALANCES_ARE_REVERSED: Record<string, boolean> = {
  // USDC/BTC
  osmo1eh2735el04mkw724pefa0vmxhvm2z3vmhckz4hcngng876l3v4fsh3e8cl: true,
};

// ---------------------------------------------------------------------------
// EVM (Ethereum mainnet) config for the 0x... associated address.
// ---------------------------------------------------------------------------
export const EVM_RPC_ENDPOINTS: Record<string, string[]> = {
  "1": [
    "https://ethereum-rpc.publicnode.com",
    "https://eth.llamarpc.com",
    "https://1rpc.io/eth",
    "https://cloudflare-eth.com",
  ],
};

export const EVM_NATIVE_ASSETS: Record<
  string,
  { symbol: string; decimals: number; priceSymbol: string }
> = {
  "1": { symbol: "ETH", decimals: 18, priceSymbol: "ETH" },
};

export const EVM_TOKEN_ALLOWLIST: Record<
  string,
  Array<{ symbol: string; contract: string; decimals: number }>
> = {
  "1": [
    {
      symbol: "USDC",
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
    },
    {
      symbol: "USDT",
      contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
    },
    {
      symbol: "DAI",
      contract: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      decimals: 18,
    },
    {
      symbol: "WETH",
      contract: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      decimals: 18,
    },
    {
      symbol: "WBTC",
      contract: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      decimals: 8,
    },
  ],
};

// ---------------------------------------------------------------------------
// Price / symbol / exponent overrides. See the price engine for how they layer:
//   PRICE_OVERRIDES_BY_DENOM: absolute price for a denom (wins over all)
//   SYMBOL_PRICE_ALIASES: derivative denom borrows a base symbol's price
//   DENOM_SYMBOL_OVERRIDES: force the display symbol for a denom
//   EXPONENT_OVERRIDES: correct the decimals for a denom/symbol
//   COINGECKO_ID_BY_SYMBOL: manual CoinGecko id for the price fallback
// ---------------------------------------------------------------------------
export const PRICE_OVERRIDES_BY_DENOM: Record<
  string,
  { symbol: string; price: number; exponent: number }
> = {
  // USDN
  "ibc/0C39BD03B5C57A1753A9B73164705871A9B549F1A5226CFD7E39BE7BF73CF8CF": {
    symbol: "USDN",
    price: 1.0,
    exponent: 6,
  },
  "ibc/FBB3FEF80ED2344D821D4F95C31DBFD33E4E31D5324CAD94EF756E67B749F668": {
    symbol: "YieldETH",
    price: 4200,
    exponent: 18,
  },
};

export const SYMBOL_PRICE_ALIASES: Record<string, string> = {
  "ibc/FBB3FEF80ED2344D821D4F95C31DBFD33E4E31D5324CAD94EF756E67B749F668": "ETH",
};

export const DENOM_SYMBOL_OVERRIDES: Record<string, string> = {
  "factory/osmo1dv8wz09tckslr2wy5z86r46dxvegylhpt97r9yd6qc3kyc6tv42qa89dr9/ampOSMO":
    "ampOSMO",
  "factory/osmo1qw0seay47y8m96l774zm4x4k77v2ewr5rmgp86/wosmo": "WOSMO",
  "ibc/54B2D9DC9602A1CE2A0329D51C6A1C7C4ADE71477186AEAAA549318C4513A453":
    "OSMO-YIELD-LP",
  "ibc/04FAC73DFF7F1DD59395948F2F043B0BBF978AD4533EE37E811340F501A08FFB":
    "RSTK",
  "ibc/64D56DF9EC69BE554F49EBCE0199611062FF1137EF105E2F645C1997344F3834":
    "SHARK",
  "ibc/98BCD43F190C6960D0005BC46BB765C827403A361C9C03C2FF694150A30284B0":
    "ROAR",
  "ibc/EDD6F0D66BCD49C1084FB2C35353B4ACD7B9191117CE63671B61320548F7C89D":
    "WHALE",
  "factory/osmo1nufyzqlm8qhu2w7lm0l4rrax0ec8rsk69mga4tel8eare7c7ljaqpk2lyg/alloyed/allOP":
    "OP",
  "factory/osmo1f588gk9dazpsueevdl2w6wfkmfmhg5gdvg2uerdlzl0atkasqhsq59qc6a/alloyed/allSHIB":
    "SHIB",
  "ibc/6B2B19D874851F631FF0AF82C38A20D4B82F438C7A22F41EDA33568345397244":
    "DOT.pica",
};

export const EXPONENT_OVERRIDES: Record<string, number> = {
  "factory/osmo1dv8wz09tckslr2wy5z86r46dxvegylhpt97r9yd6qc3kyc6tv42qa89dr9/ampOSMO": 6,
  "factory/osmo1qw0seay47y8m96l774zm4x4k77v2ewr5rmgp86/wosmo": 6,
  "ibc/54B2D9DC9602A1CE2A0329D51C6A1C7C4ADE71477186AEAAA549318C4513A453": 6,
  "ibc/04FAC73DFF7F1DD59395948F2F043B0BBF978AD4533EE37E811340F501A08FFB": 6,
  "ibc/64D56DF9EC69BE554F49EBCE0199611062FF1137EF105E2F645C1997344F3834": 6,
  "ibc/98BCD43F190C6960D0005BC46BB765C827403A361C9C03C2FF694150A30284B0": 6,
  "ibc/EDD6F0D66BCD49C1084FB2C35353B4ACD7B9191117CE63671B61320548F7C89D": 6,
  "factory/osmo1nufyzqlm8qhu2w7lm0l4rrax0ec8rsk69mga4tel8eare7c7ljaqpk2lyg/alloyed/allOP": 12,
  "factory/osmo1f588gk9dazpsueevdl2w6wfkmfmhg5gdvg2uerdlzl0atkasqhsq59qc6a/alloyed/allSHIB": 12,
  "ibc/6B2B19D874851F631FF0AF82C38A20D4B82F438C7A22F41EDA33568345397244": 10,
};

export const COINGECKO_ID_BY_SYMBOL: Record<string, string> = {
  OP: "optimism",
  SHIB: "shiba-inu",
  ROAR: "lion-dao",
  ampOSMO: "eris-amplified-osmo",
  "DOT.pica": "polkadot",
  // Explicit fallbacks for the EVM (Grants Ethereum treasury) majors, so a future
  // change in Numia's symbol coverage can't silently value them at $0.
  WETH: "ethereum",
  ETH: "ethereum",
  WBTC: "wrapped-bitcoin",
  BTC: "bitcoin",
  USDC: "usd-coin",
  USDT: "tether",
  DAI: "dai",
};

// Denoms to exclude from associated-address balances (spam / worthless).
export const IGNORE_DENOMS = new Set<string>([
  // DEEN
  "ibc/108604FDBE97DAEF128FD4ECFEB2A8AFC2D04A7162C97EAA2FD5BCB0869D0BBC",
]);

// ---------------------------------------------------------------------------
// Brand colors for the "Value by Asset" pie, keyed by symbol (matched
// case-insensitively). Hand-curated for the tokens the treasury actually holds;
// anything not listed falls back to the generic OSMOscope palette. Sourced from
// each project's brand/logo primary color.
// ---------------------------------------------------------------------------
export const TOKEN_COLORS: Record<string, string> = {
  OSMO: "#750BC2",
  ION: "#2E9BE6",
  USDC: "#2775CA",
  USDT: "#26A17B",
  DAI: "#F5AC37",
  BTC: "#F7931A",
  WBTC: "#F09242",
  ALLBTC: "#F7931A",
  ETH: "#627EEA",
  WETH: "#627EEA",
  ATOM: "#6F7390",
  TIA: "#7B2BF9",
  BABY: "#CE6533",
  SOL: "#14F195",
  LINK: "#2A5ADA",
  PEPE: "#4B9C3E",
  NTRN: "#000000",
  DYDX: "#6966FF",
  INJ: "#00A5CF",
  SAGA: "#8C4FF6",
  STOSMO: "#E33093",
  BOSMO: "#B45309",
  AKT: "#E4432E",
  SCRT: "#1B1B1B",
  STARS: "#7C4DFF",
  KAVA: "#FF433E",
};

// Case-insensitive lookup for a token's brand color (null -> use palette).
export function tokenColor(symbol: string): string | null {
  return TOKEN_COLORS[symbol.toUpperCase()] ?? null;
}

// ---------------------------------------------------------------------------
// "OSMO exposure" classification. The treasury banner reports a total value and
// a non-OSMO value; the pies can toggle OSMO in/out. OSMO exposure = OSMO and
// ANY OSMO derivative (liquid-staking, amplified, quasar/squared, etc. — bOSMO,
// stOSMO, ampOSMO, qOSMO, milkOSMO, sqOSMO, boneOSMO, and any future variant).
// Rather than maintain a symbol list that always lags new LSTs, we match any
// symbol whose name contains "OSMO" (case-insensitive). No non-derivative token
// symbol contains "OSMO", so there are no known false positives; if one ever
// appears, add it to OSMO_EXPOSURE_EXCLUDE below.
// ---------------------------------------------------------------------------
// Symbols that CONTAIN "OSMO" but are not OSMO or an OSMO derivative, so the
// substring match below must not treat them as OSMO exposure: WOSMO is an
// unrelated memecoin; OSMO-YIELD-LP is an LP token, not OSMO itself.
const OSMO_EXPOSURE_EXCLUDE = new Set<string>(
  ["WOSMO", "OSMO-YIELD-LP"].map((s) => s.toUpperCase())
);

export function isOsmoExposure(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (OSMO_EXPOSURE_EXCLUDE.has(s)) return false;
  return s.includes("OSMO");
}

// ---------------------------------------------------------------------------
// Block-explorer links surfaced next to each holder group on the treasury page.
// Osmosis addresses -> Mintscan; Ethereum addresses -> Etherscan.
// ---------------------------------------------------------------------------
export const EXPLORER_BASE: Record<
  "osmosis" | "ethereum",
  { name: string; addressUrl: (address: string) => string }
> = {
  osmosis: {
    name: "Mintscan",
    addressUrl: (a) => `https://www.mintscan.io/osmosis/address/${a}`,
  },
  ethereum: {
    name: "Etherscan",
    addressUrl: (a) => `https://etherscan.io/address/${a}`,
  },
};
