# Repair Missing Awards — Use Existing Sync on Single Block

Since block 133311165 contains only one Orec transaction (the execution that minted the 5 missing awards), the existing `ornode-sync` command can be used safely on just that block — no code changes required.

## Why It's Safe

- **`_onExec` (line 874)**: calls `updateLatestUnexecutedById` → fails because proposal is already "Executed" → **caught by try/catch** → logs error, continues
- **`_handleTokenEvents` (line 592)**: uses `getByIdAndExecHash(propId, txHash)` → **finds the proposal** (it already has executeTxHash set) → fetches receipt → parses 5 Transfer mint events → `createAwards` → inserts the 5 missing awards ✓
- **No other Orec events in the block** → no duplicate processing risk

## Steps

1. Run: `orfrapps ornode-sync 133311165 133311165 op-sepolia`
2. Expect one logged error from `_onExec` ("Failed to find latest unexecuted proposal...") — this is harmless
3. Verify with: `orfrapps check-awards -f 133311100 op-sepolia` — all 5 should now be in DB

## Future Consideration

The sync is **not idempotent** in general — re-running it on blocks with already-processed events (other proposals, votes, duplicate awards) causes errors and potential duplicates. Making it idempotent would be a separate, more invasive improvement.
