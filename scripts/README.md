# Historical Data Population Script

This directory contains scripts for populating historical data in the Osmosis dashboard.

## Populate Burn History

The `populate-burn-history.ts` script processes historical burn data (deltaBurn values) and generates complete historical records for the dashboard charts.

### How to Use

1. **Add burn history data to the CSV file**

   Edit `data/burn-history.csv` and add all your historical burn data in the following format:

   ```csv
   date,deltaBurn
   2024-06-21,1845594
   2024-06-22,0
   2024-06-23,0
   ...
   2024-11-12,43681
   ```

   - `date`: Date in YYYY-MM-DD format
   - `deltaBurn`: Amount of OSMO burned on that specific day

2. **Run the population script**

   ```bash
   yarn populate-history
   ```

   This will:
   - Read the burn data from `data/burn-history.csv`
   - Calculate cumulative burn amounts
   - Estimate historical total supply and circulating supply values
   - Generate historical records with timestamps at 17:20 UTC
   - Write the results to `data/history.json`

3. **Verify the results**

   The script will output:
   - Number of data points loaded
   - Number of historical records generated
   - Date range covered
   - Sample records (first and last)

   Example output:

   ```
   Reading burn history from C:\Github\osmometer\data\burn-history.csv...
   Loaded 507 burn data points
   Generating historical records from burn data...
   Generated 507 historical records
   Date range: 2024-06-21T17:20:00.000Z to 2024-11-12T17:20:00.000Z
   ✓ Historical data written to C:\Github\osmometer\data\history.json
   ```

### What the Script Does

1. **Reads deltaBurn data**: Parses the CSV file containing daily burn amounts
2. **Calculates cumulative burns**: Converts daily deltas into cumulative totals
3. **Estimates historical metrics**:
   - Total Supply: Estimated by subtracting the difference in burned amounts from current total supply
   - Circulating Supply: Estimated proportionally based on current ratio
   - Inflation Rate: Uses current rate (simplified - actual historical rates would be more accurate)
4. **Creates timestamps**: Sets all records to 17:20 UTC for consistency with daily snapshot time

### Notes

- The script uses simplified estimation for historical total supply and circulating supply values
- For more accurate historical data, you would need to fetch actual historical values from the blockchain
- The generated `history.json` file will be used by the dashboard charts to display historical trends
- Once populated, the daily snapshot system will continue to append new records automatically

### Data Format

**Input (burn-history.csv):**

```csv
date,deltaBurn
2024-06-21,1845594
2024-06-22,0
```

**Output (history.json):**

```json
[
  {
    "timestamp": "2024-06-21T17:20:00.000Z",
    "burnedSupply": 1845594,
    "mintedSupply": 739090057.445443,
    "totalSupply": 737244463.445443,
    "circulatingSupply": 489384623.1883527,
    "inflationRate": 1.951782853268271
  },
  {
    "timestamp": "2024-06-22T17:20:00.000Z",
    "burnedSupply": 1845594,
    "mintedSupply": 739090057.445443,
    "totalSupply": 737244463.445443,
    "circulatingSupply": 489384623.1883527,
    "inflationRate": 1.951782853268271
  }
]
```
