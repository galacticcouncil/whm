import type { FeedEntry } from "./feeds.js";

// Scope oracle byte layout (mirrors oracle.rs)
const DISCRIMINATOR_LEN = 8;
const HEADER_LEN = 32;
const PRICES_OFFSET = DISCRIMINATOR_LEN + HEADER_LEN;
const DATED_PRICE_LEN = 56;

// SPL Stake Pool byte layout (mirrors stake_pool.rs)
const TOTAL_LAMPORTS_OFFSET = 258;
const POOL_TOKEN_SUPPLY_OFFSET = 266;

function readScopePrice(data: Buffer, index: number): bigint {
  const offset = PRICES_OFFSET + index * DATED_PRICE_LEN;
  if (data.length < offset + 32) {
    throw new Error(`Price index ${index} out of bounds`);
  }
  return data.readBigUInt64LE(offset);
}

function readStakePoolRate(data: Buffer): bigint {
  if (data.length < POOL_TOKEN_SUPPLY_OFFSET + 8) {
    throw new Error("Stake pool account data too short");
  }
  const totalLamports = data.readBigUInt64LE(TOTAL_LAMPORTS_OFFSET);
  const poolTokenSupply = data.readBigUInt64LE(POOL_TOKEN_SUPPLY_OFFSET);
  return (totalLamports * 10n ** 9n) / poolTokenSupply;
}

async function fetchAccountData(rpcUrl: string, address: string): Promise<Buffer> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [address, { encoding: "base64", commitment: "confirmed" }],
    }),
  });

  const result = (await response.json()) as any;

  if (result.error) {
    throw new Error(`RPC error: ${result.error.message}`);
  }

  if (!result.result?.value?.data) {
    throw new Error(`Account not found: ${address}`);
  }

  return Buffer.from(result.result.value.data[0], "base64");
}

export async function readCurrentValue(rpcUrl: string, feed: FeedEntry): Promise<bigint> {
  switch (feed.kind) {
    case "price": {
      const data = await fetchAccountData(rpcUrl, feed.scopePrices.toBase58());
      return readScopePrice(data, feed.priceIndex);
    }
    case "rate": {
      const data = await fetchAccountData(rpcUrl, feed.stakePool.toBase58());
      return readStakePoolRate(data);
    }
    default:
      throw new Error(`Unknown feed kind: ${(feed as any).kind}`);
  }
}
