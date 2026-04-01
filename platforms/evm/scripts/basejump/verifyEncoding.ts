/**
 * Generate reference Currencies.transfer encodings from @polkadot/api
 * for use in Solidity tests.
 *
 * Usage:
 *   npx tsx scripts/basejump/verifyEncoding.ts
 */

import { ApiPromise, WsProvider } from "@polkadot/api";

async function main() {
  const api = await ApiPromise.create({
    provider: new WsProvider("wss://rpc.hydradx.cloud"),
    noInitWarn: true,
  });

  const testCases = [
    { name: "1 EURC", currencyId: 42, recipient: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d", amount: 1_000_000n },
    { name: "100k EURC (big compact)", currencyId: 42, recipient: "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48", amount: 100_000_000_000n },
    { name: "4 units (single-byte compact)", currencyId: 42, recipient: "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d", amount: 4n },
  ];

  for (const tc of testCases) {
    const hex = api.tx.currencies.transfer(tc.recipient, tc.currencyId, tc.amount).method.toHex();
    console.log(`${tc.name}: ${hex}`);
  }

  await api.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
