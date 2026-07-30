/** Build + verify the DAI NTT go-live whitelisted proposal:
 *   utility.batch_all([ EVMAccounts.set_ntt_minter(18, manager), AssetRegistry.update(18, xcm_rate_limit=10k DAI) ])
 * wrapped in whitelist.dispatch_whitelisted_call_with_preimage.
 * set_ntt_minter is hand-encoded (papi's tx builder rejects it as "incompatible"); update comes from
 * papi; batch + wrapper assembled from known pallet/call indices. Verified by Root-dispatching the
 * inner batch on a current-runtime Hydration fork (whitelist pallet dispatches whitelisted calls as Root). */
import { Binary } from "polkadot-api";
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { spawnForks, teardownForks } from "../lib/network";

// fork from current-runtime RPC (spec 433) — the default catfish snapshot mirror lags #1488.
const HYD_SPEC = { key: "hydration", name: "Hydration", endpoint: ["wss://rpc.hydradx.cloud"], port: 8062, paraId: 2034 } as const;

const ASSET = 18;
const MINTER = "cfd576f88c90844aebf45378fd09931281d8b14d"; // 20-byte H160, no 0x
const XCM_RATE_LIMIT = 10_000n * 10n ** 18n; // 10,000 DAI/day
const OUT = "/home/mrq/git/hydration-ntt/ops/tokens/dai/ntt-minter-proposal.json";

const u32le = (n: number) => n.toString(16).padStart(2, "0").match(/../g)!.reverse().join("").padEnd(8, "0");
// build asset_id LE properly:
const assetIdLe = (id: number) => Buffer.from(Uint32Array.of(id).buffer).toString("hex"); // little-endian u32

async function main() {
  const nets = await spawnForks([HYD_SPEC as any]);
  const { hydration } = nets;
  try {
    const api = hydration.client.getUnsafeApi();

    // c1: EVMAccounts(93=0x5d).set_ntt_minter(7=0x07)(asset_id u32 LE, minter H160)
    const c1 = "5d07" + assetIdLe(ASSET) + MINTER;
    // c2: AssetRegistry.update — papi builds this fine
    const c2call = api.tx.AssetRegistry.update({
      asset_id: ASSET, name: undefined, asset_type: undefined, existential_deposit: undefined,
      xcm_rate_limit: XCM_RATE_LIMIT, is_sufficient: undefined, symbol: undefined, decimals: undefined, location: undefined,
    });
    const c2 = Binary.toHex(await c2call.getEncodedData()).slice(2);

    // inner = Utility(13=0x0d).batch_all(2=0x02) + compact(2)=0x08 + c1 + c2
    const innerHex = ("0x0d0208" + c1 + c2) as Hex;
    const innerBin = Binary.fromHex(innerHex);
    const innerHash = (await hydration.chain.head.registry).hash(innerBin).toHex();
    // whitelisted proposal = Whitelist(39=0x27).dispatch_whitelisted_call_with_preimage(3=0x03) + inner
    const wlHex = ("0x2703" + innerHex.slice(2)) as Hex;

    console.log(`c1 set_ntt_minter : 0x${c1}`);
    console.log(`c2 update         : 0x${c2}`);
    console.log(`inner batch_all   : ${innerBin.length} bytes`);
    console.log(`inner blake2-256 (TC whitelists this): ${innerHash}`);
    console.log(`whitelisted proposal call: ${(wlHex.length - 2) / 2} bytes`);

    // sanity: papi can decode the assembled inner call
    try { const dc: any = (await api.txFromCallData(Binary.fromHex(innerHex))).decodedCall; console.log(`decodes as: ${dc.type}.${dc.value?.type} (${dc.value?.value?.calls?.length} calls)`); }
    catch (e: any) { console.log("decode check:", e?.message ?? e); }

    // verify: Root-dispatch inner, read effects
    const len = innerBin.length; const hash = innerHash as Hex;
    const when = hydration.chain.head.number + 1;
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(innerBin as any)]] },
      Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    const b = await hydration.chain.newBlock();
    const ev: any[] = await api.query.System.Events.getValue({ at: b.hash });
    const disp = ev.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
    const minter: any = await api.query.EVMAccounts.NttMinters.getValue(ASSET);
    const reg: any = await api.query.AssetRegistry.Assets.getValue(ASSET);
    const gotMinter = minter ? (typeof minter.asHex === "function" ? minter.asHex() : String(minter)) : "None";
    const gotLimit = reg?.xcm_rate_limit ?? reg?.value?.xcm_rate_limit;

    console.log(`\n── fork verification (inner dispatched as Root) ──`);
    console.log(`  Scheduler.Dispatched result: ${JSON.stringify(disp?.event?.value?.value?.result)}`);
    console.log(`  NttMinters(18)             : ${gotMinter}  ${gotMinter.toLowerCase().includes(MINTER) ? "✅" : "❌"}`);
    console.log(`  Assets(18).xcm_rate_limit  : ${gotLimit}  ${String(gotLimit) === String(XCM_RATE_LIMIT) ? "✅ (10,000 DAI/day)" : "❌"}`);

    writeFileSync(OUT, JSON.stringify({
      note: "DAI NTT go-live — whitelist.dispatch_whitelisted_call_with_preimage(batch_all[EVMAccounts.set_ntt_minter(18,manager), AssetRegistry.update(18, xcm_rate_limit=10k DAI/day)]). Chopsticks-verified (Root dispatch).",
      asset: ASSET, minter: "0x" + MINTER, xcmRateLimit: XCM_RATE_LIMIT.toString() + " (10,000 DAI/day)",
      innerBatchAll: innerHex, innerHash, whitelistedProposal: wlHex,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
