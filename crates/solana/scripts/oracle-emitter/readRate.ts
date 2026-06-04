// Standalone script to read stake pool rate
// Uses direct RPC calls without dependencies

import "dotenv/config";

// SPL Stake Pool byte layout offsets (from stake_pool.rs)
const TOTAL_LAMPORTS_OFFSET = 258;
const POOL_TOKEN_SUPPLY_OFFSET = 266;
const LAST_UPDATE_EPOCH_OFFSET = 274;

const JITO_STAKE_POOL = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";
  const stakePool = process.argv[2] || JITO_STAKE_POOL;

  console.log("Fetching stake pool rate...");
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Stake Pool: ${stakePool}`);
  console.log();

  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [
        stakePool,
        { encoding: "base64", commitment: "confirmed" },
      ],
    }),
  });

  const result = (await response.json()) as any;

  if (result.error) {
    throw new Error(`RPC error: ${result.error.message}`);
  }

  if (!result.result?.value?.data) {
    throw new Error("Stake pool account not found");
  }

  const data = Buffer.from(result.result.value.data[0], "base64");

  if (data.length < LAST_UPDATE_EPOCH_OFFSET + 8) {
    throw new Error(`Account data too short: ${data.length} bytes`);
  }

  const totalLamports = data.readBigUInt64LE(TOTAL_LAMPORTS_OFFSET);
  const poolTokenSupply = data.readBigUInt64LE(POOL_TOKEN_SUPPLY_OFFSET);
  const lastUpdateEpoch = data.readBigUInt64LE(LAST_UPDATE_EPOCH_OFFSET);

  // asset/SOL rate: total_lamports / pool_token_supply, normalized to 18 decimals
  const rate = totalLamports * 10n ** 18n / poolTokenSupply;
  const rateAsNumber = Number(rate) / 1e18;

  console.log("=== Stake Pool Rate ===");
  console.log(`Total lamports:     ${totalLamports}`);
  console.log(`Pool token supply:  ${poolTokenSupply}`);
  console.log(`Last update epoch:  ${lastUpdateEpoch}`);
  console.log(`Rate (18 dec):      ${rate}`);
  console.log(`Rate (asset/SOL):   ${rateAsNumber.toFixed(9)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
