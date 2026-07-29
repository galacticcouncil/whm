/** Decode the OUTER whitelisted proposal (whitelist.dispatch_whitelisted_call_with_preimage wrapper).
 *  Shows it is just a 2-byte selector prepended to the inner batchAll, and names it via Hydration metadata. */
import { readFileSync } from "node:fs";
import { Binary } from "polkadot-api";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";

async function main() {
  const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
  const wl: string = (process.argv[2] ?? d.whitelistedProposal).toLowerCase();
  const inner: string = d.innerBatchAll.toLowerCase();

  // structural: whitelisted = <2-byte selector> ++ inner
  const prefix = wl.slice(2, 6); // strip 0x, take 2 bytes
  const strip = "0x" + wl.slice(6);
  console.log(`whitelisted proposal = 0x${prefix}  ++  innerBatchAll`);
  console.log(`  selector 0x${prefix}  = Whitelist.dispatch_whitelisted_call_with_preimage (Hydration pallet 0x${prefix.slice(0,2)}, call 0x${prefix.slice(2)})`);
  console.log(`  strip first 2 bytes ⇒ inner  matches innerBatchAll: ${strip === inner ? "✅" : "❌"}\n`);

  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const tx = await api.txFromCallData(Binary.fromHex(wl as `0x${string}`));
    const dc: any = tx.decodedCall;
    const innerCall = dc.value?.value?.call ?? dc.value?.value;
    console.log("decoded (against Hydration metadata):");
    console.log(`  ${dc.type}.${dc.value.type}`);
    console.log(`    └─ call: ${innerCall.type}.${innerCall.value.type}  ·  ${innerCall.value.value.calls?.length ?? "?"} inner calls`);
    const first = innerCall.value.value.calls?.[0];
    if (first) console.log(`         ├─ [0] ${first.type}.${first.value.type}   (× ${innerCall.value.value.calls.length})`);
    console.log(`\n  inner blake2-256 (what the TC whitelists): ${d.innerHash}`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
