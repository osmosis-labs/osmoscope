# OSMO Tokenomics Dashboard 🔬

> A comprehensive, real-time dashboard for visualizing Osmosis (OSMO) token economics

A modern Next.js application that displays live tokenomics metrics for the Osmosis blockchain, including inflation rates, burn mechanisms, supply distribution, protocol revenue, and staking data. Built with real-time data from the Osmosis LCD API, Osmosis Archive Node, and Numia Data.

![OSMO Tokenomics Dashboard](https://img.shields.io/badge/Next.js-15-black?style=flat-square&logo=next.js) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?style=flat-square&logo=typescript) ![Tailwind CSS](https://img.shields.io/badge/Tailwind-3-38bdf8?style=flat-square&logo=tailwind-css)

## 📊 What This Dashboard Shows

The dashboard provides comprehensive visualization of OSMO token economics:

- **OSMO Inflation**: Real-time inflation rate, burn rate, and net inflation with historical trends showing raw daily values
- **OSMO Burned**: Total burned supply with percentage of circulating supply, displayed as both a doughnut chart and historical line chart
- **Supply Distribution**: Stacked area chart showing circulating supply, restricted supply, and community supply over time
- **Protocol Revenue**: Real daily protocol revenue from taker fees, ProtoRev, transaction fees, and Top of Block auctions (sourced from Numia/DataLenses), with detailed flow visualization showing distribution to stakers, community pool, and burn mechanisms
- **Staking APR**: Historical staking Annual Percentage Rate with daily values and breakdown showing inflation vs. revenue components, sourced from Numia Data

All charts display raw daily values with configurable time range filters (7D, 30D, 90D, 1Y, All). Headlines show averages for the selected time range. Data updates automatically and is displayed in both chart and headline formats.

### 🔮 Future Improvements

The following features are planned for future development:

- **Extended Historical Data**: Expand historical data from current ~17 months back to 4 years (June 2021)
- **Real Restricted/Community Supply Data**: Replace static modeled values with actual historical balances
- **Taker Fee Composition Chart**: Daily Column chart breakdown showing taker fees by asset (USDC, USDT, ETH, BTC, etc.)
- **ProtoRev Composition Chart**: Daily Column chart breakdown of ProtoRev profits by asset
- **Community Pool Holdings Chart**: Breakdown of all assets held in the community pool

## 🛠️ Tech Stack

### Core Framework

- **[Next.js 15](https://nextjs.org/)** - React framework with App Router
- **[TypeScript](https://www.typescriptlang.org/)** - Type-safe development
- **[React 18](https://react.dev/)** - UI library

### Styling & UI

- **[Tailwind CSS](https://tailwindcss.com/)** - Utility-first CSS framework
- **[Recharts](https://recharts.org/)** - Composable charting library
- **[Osmosis Brand Kit](https://drive.google.com/u/1/uc?id=1rKUX9X7EyJylDlrYT6wBIgziT53CQr7G)**

### Data Management

- **[TanStack Query v5](https://tanstack.com/query)** - Server state management with caching
- **[Vercel Postgres](https://vercel.com/storage/postgres)** - Primary database storage with Prisma ORM
- **[Osmosis Archive Node](https://lcd.archive.osmosis.zone)** - Historical blockchain data
- **[Osmosis LCD API](https://lcd.osmosis.zone/swagger/)** - Real-time blockchain data
- **[Numia Data API](https://www.numia.xyz/)** - Historical staking APR and revenue data

### Development Tools

- **[ESLint](https://eslint.org/)** - Code linting
- **[Prettier](https://prettier.io/)** - Code formatting
- **[Husky](https://typicode.github.io/husky/)** - Git hooks
- **[lint-staged](https://github.com/lint-staged/lint-staged)** - Pre-commit linting
- **Yarn 4** - Package management

### Deployment

- **[Vercel](https://vercel.com)** - Optimized for Next.js deployment

## 🚀 Getting Started

### Prerequisites

- **Node.js** 18.17 or later
- **Yarn** (latest version recommended)
- **Git**

### Clone and Run Locally

1. **Clone the repository:**

```bash
git clone https://github.com/osmosis-labs/osmometer.git
cd osmometer
```

2. **Install dependencies:**

```bash
yarn install
```

3. **Configure environment variables (Optional but recommended):**

Create a `.env.local` file in the root directory:

```bash
cp .env.example .env.local
```

Then edit `.env.local` and add your Numia API key:

```env
NUMIA_API_KEY=your_actual_api_key_here
```

> **Note**: Get your Numia API key from [numia.xyz](https://www.numia.xyz/). The dashboard works without an API key, but authenticated requests have higher rate limits and better reliability for historical staking APR data.

4. **Run the development server:**

```bash
yarn dev
```

5. **Open your browser:**

Navigate to [http://localhost:3000](http://localhost:3000)

The dashboard will load with real-time data from the Osmosis blockchain. Initial load may take 3-4 seconds as it fetches data from multiple sources.

### Available Commands

```bash
# Development
yarn dev                # Start development server (localhost:3000)
yarn dev --turbopack   # Start with Turbopack (faster)

# Production
yarn build             # Build for production
yarn start             # Start production server

# Code Quality
yarn lint              # Run ESLint
yarn format            # Format code with Prettier
yarn format:check      # Check if code is formatted
yarn type-check        # Run TypeScript type checking

# Data Population Scripts
yarn populate-from-archive       # Populate historical data from Osmosis Archive Node (primary)
yarn populate-staking-apr        # Populate historical staking APR data from Numia
yarn populate-revenue            # Populate protocol revenue data from DataLenses/Numia
yarn validate-history            # Validate historical data integrity

# Database Migration
yarn migrate-json-to-db          # Migrate JSON data to Vercel Postgres database
yarn db:generate                 # Generate Prisma client
yarn db:push                     # Push schema to database
yarn db:studio                   # Open Prisma Studio
```

## 📁 Project Structure

```
osmometer/
├── app/                                    # Next.js App Router
│   ├── api/                               # API Routes
│   │   ├── history/route.ts              # Historical data endpoint
│   │   └── osmosis-metrics/route.ts      # Main metrics endpoint
│   ├── layout.tsx                         # Root layout with metadata
│   ├── page.tsx                           # Home page with header
│   ├── providers.tsx                      # TanStack Query provider
│   └── globals.css                        # Global styles and Tailwind
│
├── components/                            # React Components
│   ├── charts/                           # Chart Components
│   │   ├── BurnChart.tsx                # OSMO burned line chart
│   │   ├── FeeFlowChart.tsx             # Protocol revenue flow chart
│   │   ├── InflationRatesChart.tsx      # Inflation rates line chart
│   │   ├── StakingAprChart.tsx          # Staking APR line chart
│   │   └── TokenBalancesChart.tsx       # Supply distribution area chart
│   ├── ui/                               # UI Primitives
│   │   └── Card.tsx                     # Card components
│   ├── MetricCard.tsx                    # Reusable metric display
│   ├── OsmosisDashboard.tsx             # Main dashboard container
│   └── TimeRangeSelector.tsx            # Time range filter component
│
├── lib/                                   # Utilities and Core Logic
│   ├── hooks/
│   │   └── useOsmosisMetrics.ts         # TanStack Query hook for metrics
│   ├── historical-file.ts                # File-based historical data storage
│   ├── osmosis-lcd.ts                    # Osmosis LCD API client
│   └── utils.ts                          # Formatting utilities
│
├── scripts/                                      # Data Population Scripts
│   ├── populate-from-archive.ts                 # Main script: Populate from Osmosis Archive Node
│   ├── populate-staking-apr-history.ts          # Populate staking APR history from Numia
│   ├── populate-revenue-history.ts              # Populate protocol revenue from DataLenses/Numia
│   ├── validate-history.ts                      # Validate historical data integrity
│   ├── migrate-json-to-db.ts                    # Migrate JSON data to Vercel Postgres
│   └── lib/
│       └── archive-node.ts                      # Archive node client with rate limiting
│
├── types/                                 # TypeScript Definitions
│   └── osmosis.ts                        # All type definitions
│
├── data/                                  # Data Storage
│   ├── history.json                      # Historical snapshots
│   └── README-historical-balances.md     # Historical data documentation
│
└── public/                                # Static Assets
    └── Osmosis_Icon.png                  # Osmosis logo
```

## 📈 Dashboard Contents & Data Sources

### 1. OSMO Inflation Chart

**Component:** `InflationRatesChart.tsx`

Displays three metrics on a combined chart with a reference line at 0%:

- **Inflation Rate** (green bars): Current OSMO inflation rate from the mint module, adjusted for historical parameter changes
- **Burn Rate** (red bars): Calculated from burned supply changes between daily snapshots
- **Net Inflation** (blue/orange line): Inflation Rate + Burn Rate (blue when positive, orange when negative or transitioning)

**Data Sources:**

- Inflation rate: `/osmosis/mint/v1beta1/inflation` (Osmosis LCD API)
- Burn rate: Calculated from historical burn address balance changes
- Historical data: `data/history.json` with raw daily values
- Historical adjustments: Applied via `scripts/apply-historical-params.ts` to account for distribution proportion changes over time

**Logic:**

```typescript
// Raw daily values (no rolling averages)
netInflation = inflationRate + burnRate;
// Burn rate is negative (deflationary), so net can be positive or negative
// Line color changes based on crossing zero threshold
```

### 2. OSMO Burned Charts

**Components:** `OsmosisDashboard.tsx` (doughnut) + `BurnChart.tsx` (line)

**Doughnut Chart:**

- Shows burned OSMO as percentage of total minted supply
- Color: Red (#FF6B6B) for burned, Teal (#95E1D3) for remaining

**Line Chart:**

- Historical burned supply over time with configurable time ranges

**Data Source:**

- Burn address: `osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmcn030`
- Endpoint: `/cosmos/bank/v1beta1/balances/{address}` (Osmosis LCD API)
- Historical: Tracked in `data/history.json`

**Calculation:**

```typescript
burnedPercentage = (burned / mintedSupply) * 100;
```

### 3. Supply Distribution Chart

**Component:** `TokenBalancesChart.tsx`

Stacked area chart showing three supply categories:

- **Circulating Supply** (teal): Tokens in active circulation
- **Restricted Supply** (orange): Locked/vesting tokens
- **Community Supply** (blue): Community pool holdings

**Data Sources:**

- Total minted supply: `/cosmos/bank/v1beta1/supply/by_denom?denom=uosmo`
- Developer reward addresses: From `/osmosis/mint/v1beta1/params`
- Community pool: `/cosmos/distribution/v1beta1/community_pool`

**Calculation:**

```typescript
totalSupply = mintedSupply - burned;
circulatingSupply = totalSupply - (locked + community + devAddresses);
```

### 4. Protocol Revenue Flow Chart

**Component:** `FeeFlowChart.tsx`

Flow diagram showing real daily protocol revenue and its distribution:

**Revenue Sources (Real Data):**

- **Taker Fees**: Fees from token swaps (OSMO and non-OSMO denominated)
- **ProtoRev**: Arbitrage profits from protocol-owned trading
- **Transaction Fees**: Gas fees from blockchain transactions
- **Top of Block**: MEV capture from auction bids

**Distribution:**

- OSMO Taker Fees → Split between Stakers, Community Pool, and Burn (based on poolmanager params)
- Non-OSMO Taker Fees → Split between Stakers, Community Pool, and Burn (based on poolmanager params)
- ProtoRev → OSMO portion is burned, Non-OSMO portion goes to Community Pool
- Transaction Fees → 100% to Stakers
- Top of Block → 100% to Community Pool

**Data Sources:**

- Revenue data: DataLenses API (`https://www.datalenses.zone/numia/osmosis/lensesV2/business/revenue_share_by_source`)
- Distribution parameters: `/osmosis/poolmanager/v1beta1/Params` (Osmosis LCD API)
- Historical: Populated via `scripts/populate-revenue-history.ts` from 2021 onwards

**Interactive Features:**

- Hover over any bar to see detailed composition tooltip
- Click to lock tooltip in place
- Shows exact amounts and flow destinations
- Time range selector to view different periods

### 5. Staking APR Chart

**Component:** `StakingAprChart.tsx`

Stacked area chart showing historical staking Annual Percentage Rate with breakdown of inflation vs. revenue components.

**Data Sources:**

- Historical APR: Numia Data API
- Endpoint: `https://public-osmosis-api.numia.xyz/apr`
- Date range: Last 2+ years
- Populated via: `scripts/populate-staking-apr-history.ts`

**Components:**

- **Total APR** (line): Complete staking return rate
- **Inflation APR** (purple area): Rewards from token inflation
- **Revenue APR** (dark purple area): Rewards from protocol revenue (fees, MEV)

**Calculation:**

```typescript
// Raw daily values (no rolling averages)
inflationApr = (stakingProportion / circulatingProportion) × (inflationRate / 100) × (totalSupply / totalStaked) × 100
revenueApr = totalApr - inflationApr
```

**Population:**
Run `yarn populate-staking-apr` to fetch historical data from Numia API.

### Time Range Filtering

**Component:** `TimeRangeSelector.tsx`

All charts support filtering by time range:

- **All** - Complete historical data
- **1Y** - Last 365 days
- **90D** - Last 90 days (default)
- **30D** - Last 30 days
- **7D** - Last 7 days

## 📊 Populating Historical Data

The dashboard uses a combination of real-time API calls and historical data. Here's how to populate the historical database:

### Primary Method: Archive Node Population

The **recommended way** to populate historical data is using the Osmosis Archive Node:

```bash
# Populate all historical supply, burn, staking, and distribution data from 2021-present
yarn populate-from-archive
```

This script:

- Fetches comprehensive blockchain state for each historical date
- Processes ~120 records per hour at 1.5 QPS
- Saves progress every 10 records (resumable if interrupted)
- Handles missing data with intelligent fallback to nearby blocks

### Supplementary Data Scripts

After populating from the archive node, optionally add supplementary data:

```bash
# Populate historical staking APR from Numia API
yarn populate-staking-apr

# Populate protocol revenue data from DataLenses/Numia API
yarn populate-revenue

# Validate data integrity
yarn validate-history
```

### Database Migration

Once historical data is populated in JSON files, migrate to Vercel Postgres:

```bash
# Generate Prisma client
yarn db:generate

# Push schema to database
yarn db:push

# Migrate all JSON data to database
yarn migrate-json-to-db
```

### Automatic Daily Snapshots

The dashboard automatically saves daily snapshots at 17:20 UTC when metrics are fetched. The snapshot is only saved if there are meaningful changes in the data.

## 📋 Data Coverage & Storage

### Current Historical Data Coverage

The dashboard has **1,441 records** of historical data spanning from **June 2021** to **December 2025** (~4+ years).

| Data Field              | Coverage         | Source                 | Status  |
| ----------------------- | ---------------- | ---------------------- | ------- |
| **Burned Supply**       | 100% (1441/1441) | Osmosis Archive Node   | ✅ Real |
| **Minted Supply**       | 100% (1441/1441) | Osmosis Archive Node   | ✅ Real |
| **Total Supply**        | 100% (1441/1441) | Calculated             | ✅ Real |
| **Circulating Supply**  | 100% (1441/1441) | Osmosis Archive Node   | ✅ Real |
| **Inflation Rate**      | 100% (1441/1441) | Osmosis Archive Node   | ✅ Real |
| **Total Staked**        | 100% (1441/1441) | Osmosis Archive Node   | ✅ Real |
| **Staking APR**         | Partial          | Numia API              | ✅ Real |
| **Protocol Revenue**    | Partial          | DataLenses/Numia API   | ✅ Real |
| **Distribution Params** | 100% (1441/1441) | Osmosis Archive Node   | ✅ Real |
| **Restricted Supply**   | 100% (1441/1441) | Dev vesting addresses  | ✅ Real |
| **Community Supply**    | 100% (1441/1441) | Community pool balance | ✅ Real |

### Data Storage Strategy

The application uses a **two-tier fallback system**:

1. **Vercel Postgres** (Priority 1) - Primary production database with Prisma ORM
2. **Local JSON Files** (Priority 3) - Development fallback

This ensures high availability and allows the app to work in any environment.

### Archive Node Data Population

Historical data is populated from the Osmosis Archive Node using `yarn populate-from-archive`:

**Features:**

- Fetches data back to June 2021 (Osmosis genesis)
- Queries historical blockchain state at specific block heights
- Rate-limited to 1.5 requests/second to avoid node overload
- Automatic block height interpolation search for each date
- Fallback mechanism for missing data (tries nearby blocks)
- Progress saved every 10 records for resumability

**What it fetches:**

- Total supply and burned supply from chain state
- Developer vesting address balances (15 addresses)
- Community pool holdings
- Total bonded tokens from all validators
- Distribution parameters and fee configurations
- Inflation rate and epoch provisions

Run `yarn populate-from-archive` to fill historical gaps. The script processes ~120 records/hour and saves progress automatically.

### Data Freshness

| Data Type                             | Update Frequency   | Cache Duration |
| ------------------------------------- | ------------------ | -------------- |
| Real-time metrics (supply, inflation) | On API call        | 24 hours       |
| Staking APR                           | On API call        | 30 seconds     |
| Protocol Revenue                      | Daily snapshot     | 24 hours       |
| Historical snapshots                  | Daily at 17:20 UTC | Permanent      |

### Validating Data Integrity

Run the validation script to check for data inconsistencies:

```bash
yarn validate-history
```

This validates:

- Required fields are present
- Values are within expected ranges
- No duplicate timestamps
- Data consistency across fields

## 🌐 Deployment

### Deploy to Vercel (Recommended)

1. **Push to GitHub:**

```bash
git add .
git commit -m "Initial commit"
git push origin main
```

2. **Import on Vercel:**
   - Go to [vercel.com/new](https://vercel.com/new)
   - Import your repository
   - **Add environment variables:**
     - Go to Settings → Environment Variables
     - Add `NUMIA_API_KEY` with your API key
   - Click "Deploy"

3. **Automatic Deployments:**
   - Every push to `main` triggers a new deployment
   - Preview deployments for pull requests

### Using Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Deploy to production
vercel --prod
```

### Environment Variables

The dashboard uses the following environment variables:

| Variable                   | Required    | Description                                                           | Default                                |
| -------------------------- | ----------- | --------------------------------------------------------------------- | -------------------------------------- |
| `NUMIA_API_KEY`            | Recommended | API key for Numia Data (get from [numia.xyz](https://www.numia.xyz/)) | None                                   |
| `NUMIA_API_URL`            | Optional    | Custom Numia API endpoint                                             | `https://public-osmosis-api.numia.xyz` |
| `NEXT_PUBLIC_LCD_BASE_URL` | Optional    | Custom Osmosis LCD endpoint                                           | `https://lcd.osmosis.zone`             |

**For Local Development:**

1. Copy `.env.example` to `.env.local`
2. Add your `NUMIA_API_KEY`
3. Restart the dev server

**For Vercel/Production:**

1. Go to Project Settings → Environment Variables
2. Add `NUMIA_API_KEY` with your API key
3. Redeploy if already deployed

> **Note**: The dashboard works without a Numia API key, but authenticated requests provide higher rate limits and better reliability for historical staking APR data.

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

### Development Guidelines

1. **Code Style**: Run `yarn format` before committing
2. **Type Safety**: Ensure `yarn type-check` passes
3. **Linting**: Fix any `yarn lint` errors
4. **Testing**: Test your changes with `yarn dev`

### Pre-commit Hooks

Husky automatically runs linting and formatting checks before commits. If checks fail, fix the issues and commit again.

## 📄 License

Apache License 2.0 - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built for the [Osmosis](https://osmosis.zone/) community
- Data provided by [Osmosis LCD API](https://lcd.osmosis.zone/swagger/) and [Numia Data](https://www.numia.xyz/)
- Charts powered by [Recharts](https://recharts.org/)

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/osmosis-labs/osmometer/issues)
- **Next.js Docs**: [nextjs.org/docs](https://nextjs.org/docs)
- **Osmosis**: [osmosis.zone](https://osmosis.zone/)

---

**Made with 💜 for the Osmosis community**
