import { assetToCanonicalIdentity, DataProviderService as BaseDataProviderService, calculateEffectiveRate, canonicalToAsset, getBlockchainFromChainId, getChainIdFromBlockchain, getDefaultRecipient } from '@data-provider/plugin-utils';
import { CBridgeApiClient, CBridgeAssetType, CBridgeTransferConfigs } from './client';

import type { CBridgeEstimateResponse } from './client';
import type {
  AssetType,
  LiquidityDepthType,
  RateType,
  RouteType,
  TimeWindow,
  VolumeWindowType
} from '@data-provider/shared-contract';

/**
 * Data Provider Service for cBridge
 *
 * cBridge is Celer Network's cross-chain bridge.
 *
 * Key features:
 * - Multi-chain support
 * - Volume metrics from DefiLlama Bridge API (bridge id 10, "Celer cBridge")
 * - Rates from the cBridge estimate API
 * - Liquidity depth measured honestly by probing the estimate API with
 *   increasing amounts and binary-searching the largest amount whose
 *   effective rate stays within 50 / 100 bps of the baseline rate
 *   (the API itself reports error 1004 "insufficient liquidity" past the cap)
 */
export class CBridgeService extends BaseDataProviderService<CBridgeAssetType> {
  private readonly CBRIDGE_BRIDGE_ID = "10";

  private transferConfigs: CBridgeTransferConfigs | null = null;

  constructor(
    private readonly client: CBridgeApiClient,
  ) {
    super();
  }

  /**
   * Transform canonical AssetType to provider-specific format.
   */
  async transformAssetToProvider(asset: AssetType): Promise<CBridgeAssetType> {
    const identity = await assetToCanonicalIdentity(asset);
    const chainId = getChainIdFromBlockchain(identity.blockchain);

    if (!chainId) {
      throw new Error(`Unable to resolve chain for asset: ${identity.assetId}`);
    }

    return {
      chainId: chainId.toString(),
      address: identity.reference,
      symbol: asset.symbol,
      decimals: asset.decimals,
      name: asset.name
    };
  }

  /**
   * Transform provider-specific asset to canonical AssetType format.
   */
  async transformAssetFromProvider(asset: CBridgeAssetType): Promise<AssetType> {
    const identity = await assetToCanonicalIdentity({
      chainId: parseInt(asset.chainId, 10),
      address: asset.address
    });

    const canonical = canonicalToAsset(identity, {
      symbol: asset.symbol,
      decimals: asset.decimals,
      chainId: parseInt(asset.chainId, 10)
    });

    return {
      ...canonical,
      name: asset.name
    };
  }

  /**
   * Fetch volume metrics from DefiLlama Bridge API.
   * DefiLlama aggregates bridge volume data across all chains.
   *
   * @param windows - Time windows to fetch (24h, 7d, 30d)
   * @returns Array of volume windows with USD amounts
   */
  async getVolumes(windows: TimeWindow[]): Promise<VolumeWindowType[]> {
    try {
      const bridgeData = await this.client.fetchDefiLlamaVolumes(this.CBRIDGE_BRIDGE_ID);

      if (!bridgeData || typeof bridgeData.lastDailyVolume !== 'number') {
        console.warn("[cBridge] No volume data available from DefiLlama");
        return [];
      }

      const volumes: VolumeWindowType[] = [];
      const now = new Date().toISOString();

      for (const window of windows) {
        let volumeUsd: number;

        switch (window) {
          case "24h":
            // Use lastDailyVolume which represents the last complete 24h period
            volumeUsd = bridgeData.lastDailyVolume || 0;
            break;
          case "7d":
            // Use weeklyVolume which represents the last 7 days
            volumeUsd = bridgeData.weeklyVolume || 0;
            break;
          case "30d":
            // Use monthlyVolume which represents the last 30 days
            volumeUsd = bridgeData.monthlyVolume || 0;
            break;
          default:
            // Skip unsupported windows (e.g., cumulative)
            console.log(`[cBridge] Skipping unsupported volume window: ${window}`);
            continue;
        }

        volumes.push({
          window,
          volumeUsd,
          measuredAt: now,
        });

        console.log(`[cBridge] Volume ${window}: $${volumeUsd.toLocaleString()}`);
      }

      return volumes;
    } catch (error) {
      console.error("[cBridge] Failed to fetch volumes from DefiLlama:", error);
      // Return zero volumes for each requested window
      return windows.map(window => ({
        window,
        volumeUsd: 0,
        measuredAt: new Date().toISOString()
      }));
    }
  }

  /**
   * Fetch list of assets supported by cBridge.
   */
  async getListedAssets(): Promise<CBridgeAssetType[]> {
    try {
      await this.ensureConfigsLoaded();

      if (!this.transferConfigs) {
        console.error("[cBridge] Transfer configs not available");
        return [];
      }

      const assets: CBridgeAssetType[] = [];

      for (const [chainId, chainData] of Object.entries(this.transferConfigs.chain_token)) {
        if (!chainData?.token || !Array.isArray(chainData.token)) {
          continue;
        }

        for (const tokenData of chainData.token) {
          if (!tokenData?.token || tokenData.token.xfer_disabled) {
            continue;
          }

          assets.push({
            chainId,
            address: tokenData.token.address,
            symbol: tokenData.token.symbol,
            decimals: tokenData.token.decimal,
            name: tokenData.name
          });
        }
      }

      const uniqueAssets = Array.from(
        new Map(
          assets.map(asset => [`${asset.chainId}:${asset.address}`, asset])
        ).values()
      );

      console.log(`[cBridge] Loaded ${assets.length} assets from API, deduplicated to ${uniqueAssets.length} unique assets`);
      return uniqueAssets;
    } catch (error) {
      console.error("[cBridge] Failed to fetch assets from API:", error);
      return [];
    }
  }

  /**
   * Fetch rate quotes using cBridge estimate API.
   */
  async getRates(
    route: RouteType<CBridgeAssetType>,
    amount: string
  ): Promise<RateType<CBridgeAssetType>[]> {
    const rates: RateType<CBridgeAssetType>[] = [];

    try {
      const estimate = await this.fetchQuote(route, amount);

      if (!this.isSuccessfulQuote(estimate)) {
        console.error(`[cBridge] Estimate error: ${estimate.err?.msg ?? "empty response"}`);
        return rates;
      }

      const effectiveRate = calculateEffectiveRate(
        amount,
        estimate.estimated_receive_amt,
        route.source.decimals,
        route.destination.decimals
      );

      rates.push({
        source: route.source,
        destination: route.destination,
        amountIn: amount,
        amountOut: estimate.estimated_receive_amt,
        effectiveRate,
        quotedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`[cBridge] Failed to get rate for ${route.source.symbol} -> ${route.destination.symbol}:`, error);
    }

    return rates;
  }

  /**
   * Measure liquidity depth by probing the cBridge estimate API.
   *
   * A baseline rate is taken from a small quote. Increasing probe amounts are
   * then quoted in parallel; the slippage of each probe's effective rate
   * against the baseline decides whether it fits within the 50 / 100 bps
   * thresholds. Between the last fitting and first non-fitting probe, a
   * binary search finds the precise maximum amount for each threshold.
   * A failed quote (e.g. API error 1004 "insufficient liquidity") counts as
   * not fitting any threshold.
   */
  async getLiquidityDepth(
    route: RouteType<CBridgeAssetType>
  ): Promise<LiquidityDepthType<CBridgeAssetType>[]> {
    try {
      const unit = 10n ** BigInt(route.source.decimals);
      const baselineAmount = 100n * unit;

      const baselineQuote = await this.fetchQuote(route, baselineAmount.toString());

      if (!this.isSuccessfulQuote(baselineQuote)) {
        console.warn(`[cBridge] Baseline quote failed for ${route.source.symbol} -> ${route.destination.symbol}: ${baselineQuote.err?.msg ?? "empty response"}`);
        return [{
          route,
          thresholds: [],
          measuredAt: new Date().toISOString(),
        }];
      }

      const baselineRate = calculateEffectiveRate(
        baselineAmount.toString(),
        baselineQuote.estimated_receive_amt,
        route.source.decimals,
        route.destination.decimals
      );

      const probeAmounts = [
        1000n, 5000n, 10000n, 25000n, 50000n,
        100000n, 250000n, 500000n, 1000000n
      ].map(units => units * unit);

      console.log(`[cBridge] Testing ${probeAmounts.length} amounts in parallel for ${route.source.symbol} -> ${route.destination.symbol}`);

      const probeResults = await Promise.all(
        probeAmounts.map(async (amount) => {
          try {
            const quote = await this.fetchQuote(route, amount.toString());

            if (!this.isSuccessfulQuote(quote)) {
              return { amount, success: false as const };
            }

            const currentRate = calculateEffectiveRate(
              amount.toString(),
              quote.estimated_receive_amt,
              route.source.decimals,
              route.destination.decimals
            );

            const slippageBps = Math.abs(currentRate / baselineRate - 1) * 10000;

            return { amount, success: true as const, slippageBps };
          } catch {
            return { amount, success: false as const };
          }
        })
      );

      const successfulProbes = probeResults.filter(r => r.success);
      console.log(`[cBridge] Successfully probed ${successfulProbes.length}/${probeAmounts.length} amounts`);

      let lastSuccess50bps: bigint | undefined;
      let firstFailure50bps: bigint | undefined;
      let lastSuccess100bps: bigint | undefined;
      let firstFailure100bps: bigint | undefined;

      for (const result of probeResults) {
        if (result.success) {
          if (result.slippageBps <= 50) {
            lastSuccess50bps = result.amount;
          } else if (!firstFailure50bps) {
            firstFailure50bps = result.amount;
          }

          if (result.slippageBps <= 100) {
            lastSuccess100bps = result.amount;
          } else if (!firstFailure100bps) {
            firstFailure100bps = result.amount;
          }

          if (firstFailure50bps && firstFailure100bps) {
            break;
          }
        } else {
          if (!firstFailure50bps) firstFailure50bps = result.amount;
          if (!firstFailure100bps) firstFailure100bps = result.amount;
          break;
        }
      }

      let maxAmount50bps: string | undefined;
      let maxAmount100bps: string | undefined;

      const binarySearches: Promise<void>[] = [];

      if (lastSuccess50bps && firstFailure50bps && lastSuccess50bps < firstFailure50bps) {
        console.log(`[cBridge] Binary searching for 50bps limit between ${lastSuccess50bps} and ${firstFailure50bps}`);
        binarySearches.push(
          this.binarySearchMaxAmount(route, baselineRate, lastSuccess50bps, firstFailure50bps, 50)
            .then(result => { maxAmount50bps = result; })
            .catch(() => { /* keep undefined */ })
        );
      } else if (lastSuccess50bps) {
        maxAmount50bps = lastSuccess50bps.toString();
      }

      if (lastSuccess100bps && firstFailure100bps && lastSuccess100bps < firstFailure100bps) {
        console.log(`[cBridge] Binary searching for 100bps limit between ${lastSuccess100bps} and ${firstFailure100bps}`);
        binarySearches.push(
          this.binarySearchMaxAmount(route, baselineRate, lastSuccess100bps, firstFailure100bps, 100)
            .then(result => { maxAmount100bps = result; })
            .catch(() => { /* keep undefined */ })
        );
      } else if (lastSuccess100bps) {
        maxAmount100bps = lastSuccess100bps.toString();
      }

      await Promise.all(binarySearches);

      const thresholds = [];
      if (maxAmount50bps) {
        thresholds.push({
          maxAmountIn: maxAmount50bps,
          slippageBps: 50,
        });
      }
      if (maxAmount100bps) {
        thresholds.push({
          maxAmountIn: maxAmount100bps,
          slippageBps: 100,
        });
      }

      console.log(`[cBridge] Measured liquidity - 50bps: ${maxAmount50bps || 'N/A'}, 100bps: ${maxAmount100bps || 'N/A'}`);

      return [{
        route,
        thresholds,
        measuredAt: new Date().toISOString(),
      }];
    } catch (error) {
      console.error(`[cBridge] Failed to estimate liquidity depth for ${route.source.symbol} -> ${route.destination.symbol}:`, error);
      return [{
        route,
        thresholds: [],
        measuredAt: new Date().toISOString(),
      }];
    }
  }

  /**
   * Binary search for the largest amount whose quote still succeeds and
   * whose effective rate stays within the slippage threshold of the baseline.
   */
  private async binarySearchMaxAmount(
    route: RouteType<CBridgeAssetType>,
    baselineRate: number,
    minAmount: bigint,
    maxAmount: bigint,
    slippageThresholdBps: number
  ): Promise<string | undefined> {
    const maxIterations = 10;
    let iterations = 0;
    let low = minAmount;
    let high = maxAmount;
    let bestAmount: bigint | undefined;

    while (low <= high && iterations < maxIterations) {
      iterations++;
      const mid = (low + high) / BigInt(2);

      let fits = false;
      try {
        const quote = await this.fetchQuote(route, mid.toString());

        if (this.isSuccessfulQuote(quote)) {
          const currentRate = calculateEffectiveRate(
            mid.toString(),
            quote.estimated_receive_amt,
            route.source.decimals,
            route.destination.decimals
          );

          const slippageBps = Math.abs(currentRate / baselineRate - 1) * 10000;
          fits = slippageBps <= slippageThresholdBps;
        }
      } catch (error) {
        console.warn(`[cBridge] Binary search probe failed at ${mid}:`, error);
        fits = false;
      }

      if (fits) {
        bestAmount = mid;
        low = mid + BigInt(1);
      } else {
        high = mid - BigInt(1);
      }
    }

    console.log(`[cBridge] Binary search completed in ${iterations} iterations for ${slippageThresholdBps}bps`);
    return bestAmount?.toString();
  }

  /**
   * Fetch a single quote from the cBridge estimate API.
   *
   * The usr_addr is only used for quote simulation. We pass the default
   * recipient for the source chain (the zero address on EVM chains): the
   * estimate API rejects some placeholder addresses (error 1015
   * "blocked addr", e.g. for 0x000...001) but accepts the zero address.
   */
  private async fetchQuote(
    route: RouteType<CBridgeAssetType>,
    amount: string
  ): Promise<CBridgeEstimateResponse> {
    const blockchain = getBlockchainFromChainId(parseInt(route.source.chainId, 10));
    const usrAddr = blockchain
      ? getDefaultRecipient(blockchain)
      : '0x0000000000000000000000000000000000000000';

    return this.client.fetchEstimateAmount({
      src_chain_id: parseInt(route.source.chainId, 10),
      dst_chain_id: parseInt(route.destination.chainId, 10),
      token_symbol: route.source.symbol,
      amt: amount,
      usr_addr: usrAddr,
      slippage_tolerance: 500
    });
  }

  /**
   * A quote counts as successful when the API reports no error and returns
   * a receive amount. Error 1004 means "insufficient liquidity".
   */
  private isSuccessfulQuote(estimate: CBridgeEstimateResponse): boolean {
    return (!estimate.err || estimate.err.code === 0) && !!estimate.estimated_receive_amt;
  }

  /**
   * Ensure transfer configs are loaded.
   */
  private async ensureConfigsLoaded(): Promise<void> {
    if (!this.transferConfigs) {
      this.transferConfigs = await this.client.fetchTransferConfigs();
    }
  }
}
