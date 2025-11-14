# Historical Balances CSV Format

This file explains the format for `historical-balances.csv` which contains historical balance data for calculating accurate Total Supply and Circulating Supply.

## CSV Column Definitions

| Column Name | Description | Address/Source |
|-------------|-------------|----------------|
| `date` | Date in YYYY-MM-DD format | N/A |
| `minted_supply` | Total minted supply from chain | Cosmos bank module total supply |
| `burn_address` | Balance of burn address | `osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqmcn030` |
| `locked_addr_1` | Balance of first locked address | `osmo1vqy8rqqlydj9wkcyvct9zxl3hc4eqgu3d7hd9k` |
| `locked_addr_2_liquid` | Liquid balance of second locked address | `osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00` |
| `locked_addr_2_staked` | Staked/delegated balance of second locked address | `osmo1ugku28hwyexpljrrmtet05nd6kjlrvr9jz6z00` (delegations) |
| `community_pool` | Community pool balance | Cosmos distribution module community pool |
| `dev_addresses_total` | Combined total balance of all dev reward addresses | Addresses from mint module params (dynamic list) |

## Calculations Performed

From this data, the script will calculate:

```
Total Supply = minted_supply - burn_address

Total Locked = locked_addr_1
             + locked_addr_2_liquid
             + locked_addr_2_staked
             + community_pool
             + dev_addresses_total

Circulating Supply = Total Supply - Total Locked
```

## Example Row

```csv
date,minted_supply,burn_address,locked_addr_1,locked_addr_2_liquid,locked_addr_2_staked,community_pool,dev_addresses_total
2024-06-21,750000000,1845594,50000000,25000000,75000000,10000000,5000000
```

This would result in:
- **Total Supply**: 750,000,000 - 1,845,594 = 748,154,406 OSMO
- **Total Locked**: 50M + 25M + 75M + 10M + 5M = 165,000,000 OSMO
- **Circulating Supply**: 748,154,406 - 165,000,000 = 583,154,406 OSMO

## Data Format

- All amounts should be in **OSMO** (not uosmo)
- Use whole numbers or decimals (e.g., 1845594.123)
- No commas in numbers
- Dates must be in YYYY-MM-DD format
- Match the same dates as your burn history (2024-06-21 to 2025-11-10)

## Notes

- The burn_address value should match the cumulative burn from your burn history for that date
- Dev addresses balance includes all addresses returned by the mint module's `weighted_developer_rewards_receivers` parameter
- If you don't have individual dev address balances, you can provide a combined total
- All balances are point-in-time snapshots for each date at 17:20 UTC (to match the burn history timing)
