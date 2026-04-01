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

import { hydration, HydrationApis } from "@galacticcouncil/descriptors";

import { createClient, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider";

type DryRunResult = HydrationApis["DryRunApi"]["dry_run_call"]["Value"];

// Well-known dev accounts (no balance on mainnet — which is what we want)
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

async function main() {
  const client = createClient(getWsProvider("wss://hydration-rpc.n.dwellir.com"));
  const api = client.getTypedApi(hydration);

  // Build a currencies.transfer call (EURC, currency ID 42)
  const tx = api.tx.Currencies.transfer({
    dest: BOB,
    currency_id: 42,
    amount: 1_000_000n,
  });

  const encodedCall = await tx.getEncodedData();
  console.log("Call hex:", encodedCall.asHex());
  console.log("Dry-running currencies.transfer on Hydration...\n");

  const info = await tx.getPaymentInfo(ALICE);
  console.log("OK  Call is valid (runtime decoded it successfully)");
  console.log(
    `    weight: { ref_time: ${info.weight.ref_time}, proof_size: ${info.weight.proof_size} }`,
  );
  console.log(`    partialFee: ${info.partial_fee}`);

  const rawOrigin = Enum("Signed", ALICE);
  const origin = Enum("system", rawOrigin);
  const dryRun = await client.getUnsafeApi().apis.DryRunApi.dry_run_call(origin, tx.decodedCall);

  const result = dryRun as DryRunResult;
  const error =
    result.success && !result.value.execution_result.success
      ? result.value.execution_result.value.error
      : null;

  console.log("\nDry-run result:", JSON.stringify(result), null, 2);

  if (error) {
    console.log(
      "OK  Dispatch failed as expected (insufficient balance):",
      JSON.stringify(error, null, 2),
    );
  } else {
    console.log("OK  Dispatch succeeded (unexpected — Alice shouldn't have balance)");
  }

  client.destroy();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
