/**
 * Generate reference Currencies.transfer encodings from polkadot-api (papi)
 * for use in Solidity tests.
 *
 * Usage:
 *   npx tsx scripts/basejump/verifyEncoding.ts
 */

import { hydration } from "@galacticcouncil/descriptors";

import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";

async function main() {
  const client = createClient(getWsProvider("wss://hydration-rpc.n.dwellir.com"));
  const api = client.getTypedApi(hydration);

  const testCases = [
    {
      name: "1 EURC",
      currencyId: 42,
      // Alice
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      amount: 1_000_000n,
    },
    {
      name: "100k EURC (big compact)",
      currencyId: 42,
      // Bob
      recipient: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
      amount: 100_000_000_000n,
    },
    {
      name: "4 units (single-byte compact)",
      currencyId: 42,
      // Alice
      recipient: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      amount: 4n,
    },
  ];

  for (const tc of testCases) {
    const tx = api.tx.Currencies.transfer({
      dest: tc.recipient,
      currency_id: tc.currencyId,
      amount: tc.amount,
    });
    const encoded = await tx.getEncodedData();
    console.log(`${tc.name}: ${encoded.asHex()}`);
  }

  client.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
