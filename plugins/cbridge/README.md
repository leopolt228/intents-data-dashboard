# cBridge Data Provider Plugin

Data provider plugin for **Celer cBridge** (Celer Network's cross-chain bridge)
for the NEAR Intents data collection system. Implements the
`@data-provider/shared-contract` interface: volumes, listed assets, rates and
liquidity depth.

## Data sources

| Method | Source | Notes |
| --- | --- | --- |
| `getListedAssets` | cBridge API `GET /v2/getTransferConfigsForAll` on `https://cbridge-prod2.celer.app` | All chains/tokens from the live transfer configs; tokens with `xfer_disabled` are skipped; results are deduplicated by `chainId:address`. |
| `getRates` | cBridge API `GET /v2/estimateAmt` | Real quote for the route and amount; `effectiveRate` is computed from `estimated_receive_amt`. |
| `getLiquidityDepth` | cBridge API `GET /v2/estimateAmt` (probing) | Honest measurement, no constants: a baseline rate is taken from a small quote, increasing probe amounts are quoted in parallel, and a binary search finds the largest amount whose effective rate stays within 50 / 100 bps of the baseline. Past the pool cap the API itself returns error 1004 "insufficient liquidity", which the search treats as the boundary. |
| `getVolumes` | DefiLlama Bridge API `GET https://bridges.llama.fi/bridge/10` | Bridge id **10** is Celer cBridge in DefiLlama's registry (`bridgeDbName: "celer"`). `lastDailyVolume` / `weeklyVolume` / `monthlyVolume` map to the 24h / 7d / 30d windows. |

No authentication is required for either API.

### Implementation notes

- The estimate API rejects some placeholder user addresses with error 1015
  "blocked addr" (for example `0x000...001`). Quotes therefore use the default
  recipient for the source chain from `@data-provider/plugin-utils`
  (the zero address on EVM chains), which the API accepts.
- Asset transformations preserve `name` and `chainId` in addition to
  symbol/decimals, so canonical assets round-trip losslessly through the
  provider router.

## Known limitations

- **DefiLlama Bridges API paywall.** As of November 2026 DefiLlama lists the
  Bridges endpoints as Pro-only in its API documentation, and
  `bridges.llama.fi` answers HTTP 402 without a Pro key. In such an
  environment `getVolumes` falls back to `0` for each requested window (the
  same behaviour as the Across plugin in this repo) instead of inventing
  numbers. With DefiLlama access restored, the same code returns real
  volumes with no changes.
- **One unmapped chain.** The transfer configs currently list one chain
  (chainId `20080001`) that `@data-provider/plugin-utils` has no blockchain
  mapping for, so that single asset (1 of 104) is dropped by the router with
  a warning. This is a limitation of the shared chain mapping, not of the
  cBridge data.

## Configuration

Edit `plugin.dev.ts` to configure:

- Plugin variables (`baseUrl`, `timeout`)
- Test routes and notionals

The plugin is registered in the aggregator
(`plugins/aggregator/src/plugins.ts`) under the provider key `"cbridge"`.

## Running Tests

Integration tests run against the live cBridge and DefiLlama APIs:

```bash
bun install        # from the repository root, once
cd plugins/cbridge
bun run test
```

Current status: 8 of 11 tests pass. The 3 failing tests are pre-existing
upstream test/contract mismatches that fail identically for the reference
Across plugin: the snapshot tests call `client.getSnapshot`, which the
current shared contract client does not expose, and the route-transformation
test calls `getRates` with the legacy `{ routes, notionals }` input shape
instead of the current `{ route, amount }`.

## License

Part of the NEAR Intents data collection system.
