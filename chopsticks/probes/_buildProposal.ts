/** Assemble the whitelisted governance proposal: utility.batchAll([11 $10 sends]) + whitelist wrapper. */
import { Binary } from "polkadot-api";
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";
import { ASSETS, tenDollarRaw, placeholderRecipient, buildExitPayload } from "./exitAssets";

const compact = (n: number): string => {
  if (n < 64) return (n << 2).toString(16).padStart(2, "0");
  if (n < 2 ** 14) { const v = (n << 2) | 1; return (v & 0xff).toString(16).padStart(2,"0") + ((v>>8)&0xff).toString(16).padStart(2,"0"); }
  throw new Error("compact >2^14 not needed");
};

async function main() {
  const sends = ASSETS.map((a) => buildExitPayload(a, tenDollarRaw(a), placeholderRecipient(a)).slice(2));
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    // 2-byte prefixes (pallet+call idx) by encoding dummies
    const batchEmpty = Binary.toHex(await api.tx.Utility.batch_all({ calls: [] }).getEncodedData()).slice(2);
    const batchPrefix = batchEmpty.slice(0, 4); // [utilityPallet, batchAll] — followed by compact(0)=00
    const remark = api.tx.System.remark({ remark: Binary.fromText("x") });
    const wlDummy = Binary.toHex(await api.tx.Whitelist.dispatch_whitelisted_call_with_preimage({ call: remark.decodedCall }).getEncodedData()).slice(2);
    const wlPrefix = wlDummy.slice(0, 4); // [whitelistPallet, dispatchWithPreimage]
    console.log("utility.batchAll prefix:", "0x" + batchPrefix, "| whitelist.dispatchWithPreimage prefix:", "0x" + wlPrefix);

    const inner = "0x" + batchPrefix + compact(sends.length) + sends.join(""); // utility.batchAll([...11])
    const innerBytes = Binary.fromHex(inner as Hex);
    const innerHash = (await nets.hydration.chain.head.registry).hash(innerBytes).toHex();
    const proposal = "0x" + wlPrefix + inner.slice(2); // whitelist.dispatchWhitelistedCallWithPreimage(inner)

    console.log(`\ninner utility.batchAll: ${innerBytes.length} bytes`);
    console.log(`inner blake2-256 (whitelist this on the TC): ${innerHash}`);
    console.log(`whitelisted proposal call: ${(proposal.length - 2) / 2} bytes`);
    writeFileSync("probes/moxit-proposal.json", JSON.stringify({
      note: "moxit test — $10 of each of 11 MRL assets, SA→origin via Wormhole TokenBridge. DRY-RUN recipients are placeholders.",
      assets: ASSETS.map((a) => ({ sym: a.sym, id: a.id, token: a.token, originChain: a.originChain, amountRaw: tenDollarRaw(a).toString(), recipient: placeholderRecipient(a) })),
      innerBatchAll: inner, innerHash, whitelistedProposal: proposal,
    }, null, 2));
    console.log("\nwrote probes/moxit-proposal.json");
    console.log("\ninnerBatchAll (first 80):", inner.slice(0, 80));
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
