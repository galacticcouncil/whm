/** Build + verify the NTT go-live minter proposal for the 9 NON-DAI assets:
 *   whitelist.dispatch_whitelisted_call_with_preimage( batch_all[ EVMAccounts.set_ntt_minter(assetId, manager) ×9 ] )
 *
 * Mirrors _buildNttDai.ts (DAI canary), extended to the rest. MINTERS ONLY — no per-asset deposit
 * limits (xcm_rate_limit). DAI got a 10k/day issuance fuse; the 9 here are left unbounded at the
 * runtime layer until a limit is set (⚠️ see note — decide per-asset limits before/with go-live).
 * (assetId, manager) come from hydration-ntt/ops/tokens/<sym>/deployment.json (chains.Hydration).
 *
 *   pnpm tsx probes/_buildNttMintersRest.ts
 */
import { Binary } from "polkadot-api";
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { spawnForks, teardownForks } from "../lib/network";

// current-runtime RPC (must carry #1488 NTT machinery). tarn first per house pref, hydradx as fallback.
const HYD_SPEC = { key: "hydration", name: "Hydration", endpoint: ["wss://hdx.tarn.hydration.cloud", "wss://rpc.hydradx.cloud"], port: 8062, paraId: 2034 } as const;
const OUT = "/home/mrq/git/hydration-ntt/ops/ntt-minters-rest-proposal.json";

// 9 non-DAI NTT spoke managers (burning mode) — source: ops/tokens/<sym>/deployment.json chains.Hydration
const TOKENS: { sym: string; asset: number; manager: string }[] = [
  { sym: "WBTC",    asset: 19,      manager: "0x6BFca089916c045b0Ca4A09B655aF9F926189993" },
  { sym: "WETH",    asset: 20,      manager: "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7" },
  { sym: "USDC",    asset: 21,      manager: "0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC" },
  { sym: "USDT",    asset: 23,      manager: "0x5E6C488103b47F804824AE15861638af4C436795" },
  { sym: "jitoSOL", asset: 40,      manager: "0xcE73C15B9ED02413066DE5B904A36F8e8f9B5331" },
  { sym: "PRIME",   asset: 43,      manager: "0xFCaF4aA069C565d25539028970703F01e47D3E0B" },
  { sym: "EURC",    asset: 44,      manager: "0x8dd1286A29dF5a2785FB638d6fB1598144Cfbc4C" },
  { sym: "sUSDS",   asset: 1000745, manager: "0x1973E7044d9A7C7bB2d6ea1693A296a9e4B7E448" },
  { sym: "SOL",     asset: 1000752, manager: "0x9e200C0f28D92D296b201D96C8269d3CAFFfA9FF" },
];

const assetIdLe = (id: number) => Buffer.from(Uint32Array.of(id).buffer).toString("hex"); // little-endian u32
const compact = (n: number) => (n << 2).toString(16).padStart(2, "0"); // n < 64
const h160 = (a: string) => a.toLowerCase().replace(/^0x/, "");

async function main() {
  const nets = await spawnForks([HYD_SPEC as any]);
  const { hydration } = nets;
  try {
    const api = hydration.client.getUnsafeApi();

    // EVMAccounts(93=0x5d).set_ntt_minter(7=0x07)(asset_id u32 LE, minter H160) per token
    const calls = TOKENS.map((t) => "5d07" + assetIdLe(t.asset) + h160(t.manager));
    // inner = Utility(13=0x0d).batch_all(2=0x02) + compact(9) + calls
    const innerHex = ("0x0d02" + compact(calls.length) + calls.join("")) as Hex;
    const innerBin = Binary.fromHex(innerHex);
    const innerHash = (await hydration.chain.head.registry).hash(innerBin).toHex();
    const wlHex = ("0x2703" + innerHex.slice(2)) as Hex;

    console.log(`set_ntt_minter calls: ${calls.length} (compact 0x${compact(calls.length)})`);
    for (const t of TOKENS) console.log(`  ${String(t.asset).padEnd(8)} ${t.sym.padEnd(8)} -> ${t.manager}`);
    console.log(`inner batch_all   : ${innerBin.length} bytes`);
    console.log(`inner blake2-256 (TC whitelists): ${innerHash}`);
    console.log(`whitelisted call  : ${(wlHex.length - 2) / 2} bytes`);

    try { const dc: any = (await api.txFromCallData(innerBin)).decodedCall; console.log(`decodes as: ${dc.type}.${dc.value?.type} (${dc.value?.value?.calls?.length} calls)`); }
    catch (e: any) { console.log("decode check:", e?.message ?? e); }

    // BEFORE: minters should be unset
    console.log(`\n── minters BEFORE (should be None) ──`);
    for (const t of TOKENS) {
      const m: any = await api.query.EVMAccounts.NttMinters.getValue(t.asset);
      console.log(`  NttMinters(${String(t.asset).padEnd(8)}) = ${m ? (typeof m.asHex === "function" ? m.asHex() : String(m)) : "None"}`);
    }

    // Root-dispatch the inner (whitelist dispatches whitelisted calls as Root)
    const len = innerBin.length; const hash = innerHash as Hex;
    const when = hydration.chain.head.number + 1;
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(innerBin as any)]] },
      Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    const b = await hydration.chain.newBlock();
    const ev: any[] = await api.query.System.Events.getValue({ at: b.hash });
    const disp = ev.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
    const dispOk = JSON.stringify(disp?.event?.value?.value?.result ?? {}).includes("success");

    console.log(`\n── AFTER (inner dispatched as Root: ${JSON.stringify(disp?.event?.value?.value?.result)}) ──`);
    let allOk = dispOk;
    for (const t of TOKENS) {
      const m: any = await api.query.EVMAccounts.NttMinters.getValue(t.asset);
      const got = m ? (typeof m.asHex === "function" ? m.asHex() : String(m)) : "None";
      const ok = got.toLowerCase().includes(h160(t.manager));
      allOk &&= ok;
      console.log(`  NttMinters(${String(t.asset).padEnd(8)} ${t.sym.padEnd(8)}) = ${got}  ${ok ? "✅" : "❌"}`);
    }
    console.log(`\n${allOk ? "ALL 9 MINTERS BOUND ✅" : "FAILURES ❌"}`);

    writeFileSync(OUT, JSON.stringify({
      note: "NTT go-live for the 9 NON-DAI assets — whitelist.dispatch_whitelisted_call_with_preimage(batch_all[EVMAccounts.set_ntt_minter(assetId, manager) x9]). MINTERS ONLY (no per-asset deposit limit / xcm_rate_limit — unlike the DAI canary's 10k/day fuse; decide per-asset limits before/with go-live). Chopsticks-verified (Root dispatch → NttMinters(id)==manager). Managers from ops/tokens/<sym>/deployment.json.",
      assets: TOKENS.map((t) => ({ sym: t.sym, asset: t.asset, minter: t.manager.toLowerCase() })),
      innerBatchAll: innerHex, innerHash, whitelistedProposal: wlHex,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
    process.exitCode = allOk ? 0 : 1;
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
