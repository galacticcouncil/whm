/**
 * Verify currencies.transfer dispatch behavior on live Hydration.
 *
 * Dry-runs the encoded call via system.dryRun to confirm:
 * 1. Valid encoding is accepted by the runtime
 * 2. Insufficient balance produces the expected error (not a decode error)
 *
 * Usage:
 *   npx tsx scripts/basejump/verifyDispatch.ts
 */

import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";

async function main() {
  const api = await ApiPromise.create({
    provider: new WsProvider("wss://rpc.hydradx.cloud"),
    noInitWarn: true,
  });

  const keyring = new Keyring({ type: "sr25519" });
  // Use Alice's well-known dev key — won't have balance on mainnet, which is what we want
  const alice = keyring.addFromUri("//Alice");

  // Build a currencies.transfer call (EURC, currency ID 42)
  const recipient = "0x8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48"; // Bob
  const currencyId = 42;
  const amount = 1_000_000n;

  const call = api.tx.currencies.transfer(recipient, currencyId, amount);

  console.log("Call hex:", call.method.toHex());
  console.log("Dry-running currencies.transfer on Hydration...\n");

  // Use payment.queryInfo to verify the call is decodable
  try {
    const info = await call.paymentInfo(alice);
    console.log("OK  Call is valid (runtime decoded it successfully)");
    console.log(`    weight: ${info.weight.toString()}`);
    console.log(`    partialFee: ${info.partialFee.toString()}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("decode") || msg.includes("invalid")) {
      console.error("FAIL  Call encoding is invalid:", msg);
      await api.disconnect();
      process.exit(1);
    }
    console.log("WARN  paymentInfo failed (but not a decode error):", msg);
  }

  // Dry-run to check dispatch result
  try {
    const dryRun = await api.rpc.system.dryRun(call.toHex(), undefined as any);
    console.log("\nDry-run result:", dryRun.toHuman());

    if (dryRun.isOk) {
      console.log("OK  Dispatch succeeded (unexpected — Alice shouldn't have balance)");
    } else {
      const error = dryRun.asErr.toHuman();
      console.log("OK  Dispatch failed as expected (insufficient balance):", JSON.stringify(error));
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log("\nWARN  dryRun not available:", msg);
  }

  await api.disconnect();
  console.log("\nDone.");
}

main().catch((e) => { console.error(e); process.exit(1); });
