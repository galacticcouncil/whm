// Standalone script to read PRIME price from Kamino Scope oracle
// Uses direct RPC calls without dependencies

const SCOPE_ORACLE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH";

// PRIME price index in Scope oracle (from deploy.ts)
const PRIME_PRICE_INDEX = 190;

// Scope oracle byte layout constants (from oracle.rs)
const DISCRIMINATOR_LEN = 8;
const HEADER_LEN = 32;
const PRICES_OFFSET = DISCRIMINATOR_LEN + HEADER_LEN;
const DATED_PRICE_LEN = 56;

interface ScopeDatedPrice {
  value: bigint;
  exp: bigint;
  lastUpdatedSlot: bigint;
  unixTimestamp: bigint;
}

function readPrice(data: Buffer, index: number): ScopeDatedPrice {
  const offset = PRICES_OFFSET + index * DATED_PRICE_LEN;
  const end = offset + 32;

  if (data.length < end) {
    throw new Error("Price index out of bounds");
  }

  const value = data.readBigUInt64LE(offset);
  const exp = data.readBigUInt64LE(offset + 8);
  const lastUpdatedSlot = data.readBigUInt64LE(offset + 16);
  const unixTimestamp = data.readBigUInt64LE(offset + 24);

  return { value, exp, lastUpdatedSlot, unixTimestamp };
}

function normalizeTo18Dec(value: bigint, exp: bigint): bigint {
  if (exp <= 18n) {
    const scale = 10n ** (18n - exp);
    return value * scale;
  } else {
    const scale = 10n ** (exp - 18n);
    return value / scale;
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

  console.log("Fetching PRIME price from Kamino Scope Oracle...");
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Oracle: ${SCOPE_ORACLE_PRICES}`);
  console.log(`Price Index: ${PRIME_PRICE_INDEX}`);
  console.log();

  // Fetch account data via JSON-RPC
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [
        SCOPE_ORACLE_PRICES,
        { encoding: "base64", commitment: "confirmed" }
      ],
    }),
  });

  const result = await response.json() as any;

  if (result.error) {
    throw new Error(`RPC error: ${result.error.message}`);
  }

  if (!result.result?.value?.data) {
    throw new Error("Scope oracle account not found");
  }

  const base64Data = result.result.value.data[0];
  const data = Buffer.from(base64Data, "base64");

  // Read the price at PRIME index
  const price = readPrice(data, PRIME_PRICE_INDEX);
  const normalizedPrice = normalizeTo18Dec(price.value, price.exp);

  // Convert to human readable
  const priceAsNumber = Number(normalizedPrice) / 1e18;
  const timestamp = new Date(Number(price.unixTimestamp) * 1000);

  console.log("=== PRIME Price (from Kamino Scope Oracle) ===");
  console.log(`Raw value: ${price.value}`);
  console.log(`Exponent: ${price.exp}`);
  console.log(`Normalized (18 dec): ${normalizedPrice}`);
  console.log(`Price: $${priceAsNumber.toFixed(6)}`);
  console.log(`Last updated slot: ${price.lastUpdatedSlot}`);
  console.log(`Timestamp: ${timestamp.toISOString()}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
