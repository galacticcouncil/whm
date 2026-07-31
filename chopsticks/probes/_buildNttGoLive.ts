/** Build + verify the full NTT GO-LIVE proposal for all 11 NTT assets:
 *   whitelist.dispatch_whitelisted_call_with_preimage( batch_all([
 *     EVMAccounts.set_ntt_minter(id, manager) ×11,          // enable NTT minting
 *     AssetRegistry.update(id, xcm_rate_limit = raw) ×11     // per-asset deposit/issuance fuse (operator table)
 *   ]))
 * Managers from hydration-ntt/ops/tokens/<sym>/deployment.json. Decimals read from-chain so the raw
 * xcm_rate_limit is exact. Verified by Root-dispatching on a current-runtime (tarn) fork.
 *
 *   pnpm tsx probes/_buildNttGoLive.ts
 */
import { Binary } from "polkadot-api";
import { writeFileSync } from "node:fs";
import type { Hex } from "viem";
import { spawnForks, teardownForks } from "../lib/network";
import { buildSetNttMinter, buildRateLimitUpdate, wrapWhitelist } from "./_buildSweepProposal";

const HYD_SPEC = { key: "hydration", name: "Hydration", endpoint: ["wss://hdx.tarn.hydration.cloud", "wss://rpc.hydradx.cloud"], port: 8062, paraId: 2034 } as const;
const OUT = "/home/mrq/git/hydration-ntt/ops/ntt-go-live-proposal.json";
const compact = (n: number) => (n << 2).toString(16).padStart(2, "0"); // n < 64

// 11 NTT assets: assetId, sym, Hydration spoke manager, and the operator-set xcm_rate_limit (human units).
const NTT: { id: number; sym: string; manager: Hex; limit: string }[] = [
  { id: 18,      sym: "DAI",     manager: "0xcFd576F88C90844AEBF45378Fd09931281D8b14d", limit: "10000" },
  { id: 19,      sym: "WBTC",    manager: "0x6BFca089916c045b0Ca4A09B655aF9F926189993", limit: "0.5" },
  { id: 20,      sym: "WETH",    manager: "0xB5cEf790D52A57fa619eD96eDd64c5328F3DCFb7", limit: "17" },
  { id: 21,      sym: "USDC",    manager: "0xEcEab64542A875C4472671D9Ed1E690cdD4e28fC", limit: "55000" },
  { id: 23,      sym: "USDT",    manager: "0x5E6C488103b47F804824AE15861638af4C436795", limit: "55000" },
  { id: 40,      sym: "jitoSOL", manager: "0xcE73C15B9ED02413066DE5B904A36F8e8f9B5331", limit: "300" },
  { id: 43,      sym: "PRIME",   manager: "0xFCaF4aA069C565d25539028970703F01e47D3E0B", limit: "55000" },
  { id: 44,      sym: "EURC",    manager: "0x8dd1286A29dF5a2785FB638d6fB1598144Cfbc4C", limit: "55000" },
  { id: 1000745, sym: "sUSDS",   manager: "0x1973E7044d9A7C7bB2d6ea1693A296a9e4B7E448", limit: "30000" },
  { id: 1000752, sym: "SOL",     manager: "0x9e200C0f28D92D296b201D96C8269d3CAFFfA9FF", limit: "1100" },
  { id: 1000753, sym: "SUI",     manager: "0x978443f00cAB6b09445140321EC73a221ebFF5F8", limit: "40000" },
];

// decimal-string × 10^dec → bigint raw (handles fractions like WBTC "0.5")
function scale(s: string, dec: number): bigint {
  const [i, f = ""] = s.split(".");
  const frac = (f + "0".repeat(dec)).slice(0, dec);
  return BigInt(i) * 10n ** BigInt(dec) + BigInt(frac || "0");
}

async function main() {
  const nets = await spawnForks([HYD_SPEC as any]);
  const { hydration } = nets;
  try {
    const api = hydration.client.getUnsafeApi();

    // read decimals from-chain, compute raw limits
    const rows = [];
    for (const t of NTT) {
      const a: any = await api.query.AssetRegistry.Assets.getValue(t.id);
      const dec = Number(a?.decimals ?? a?.value?.decimals);
      const raw = scale(t.limit, dec);
      rows.push({ ...t, dec, raw });
    }

    const minters = rows.map((r) => buildSetNttMinter(r.id, r.manager));
    const limits = rows.map((r) => buildRateLimitUpdate(r.id, r.raw));
    const calls = [...minters, ...limits];
    const innerHex = ("0x0d02" + compact(calls.length) + calls.map((c) => c.slice(2)).join("")) as Hex;
    const innerBin = Binary.fromHex(innerHex);
    const innerHash = (await hydration.chain.head.registry).hash(innerBin as any).toHex() as Hex;
    const wlHex = ("0x2703" + innerHex.slice(2)) as Hex;

    console.log(`\n════════ NTT go-live proposal (11 minters + 11 rate limits) ════════`);
    for (const r of rows) console.log(`  ${r.sym.padEnd(8)} id=${String(r.id).padEnd(8)} minter=${r.manager}  limit=${r.limit} (${r.dec}dp → raw ${r.raw})`);
    console.log(`inner batch_all   : ${innerBin.length} bytes (${calls.length} calls)`);
    console.log(`inner blake2-256  : ${innerHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(wlHex.length - 2) / 2} bytes`);
    try { const dc: any = (await api.txFromCallData(innerBin)).decodedCall; console.log(`decodes as: ${dc.type}.${dc.value?.type} (${dc.value?.value?.calls?.length} calls)`); }
    catch (e: any) { console.log("decode:", e?.message ?? e); }

    // BEFORE: minters unbound?
    console.log(`\n── minters BEFORE ──`);
    for (const r of rows) { const m: any = await api.query.EVMAccounts.NttMinters.getValue(r.id); console.log(`  ${r.sym.padEnd(8)} ${m ? "SET" : "None"}`); }

    // Root-dispatch verify
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
    console.log(`\n── AFTER (dispatched: ${JSON.stringify(disp?.event?.value?.value?.result)}) ──`);
    let allOk = dispOk;
    for (const r of rows) {
      const m: any = await api.query.EVMAccounts.NttMinters.getValue(r.id);
      const got = m ? (typeof m.asHex === "function" ? m.asHex() : String(m)) : "None";
      const minterOk = got.toLowerCase().includes(r.manager.toLowerCase().replace("0x", ""));
      const asset: any = await api.query.AssetRegistry.Assets.getValue(r.id);
      const gotLimit = BigInt(String(asset?.xcm_rate_limit ?? asset?.value?.xcm_rate_limit ?? 0));
      const limitOk = gotLimit === r.raw;
      allOk = allOk && minterOk && limitOk;
      console.log(`  ${r.sym.padEnd(8)} minter ${minterOk ? "✅" : "❌"}  xcm_rate_limit=${gotLimit} ${limitOk ? "✅" : "❌"} (want ${r.raw})`);
    }
    console.log(`\n${allOk ? "ALL 11 MINTERS BOUND + 11 LIMITS SET ✅" : "FAILURES ❌"}`);

    writeFileSync(OUT, JSON.stringify({
      note: "NTT go-live — whitelist.dispatch_whitelisted_call_with_preimage(batch_all[ EVMAccounts.set_ntt_minter(id,manager)×11, AssetRegistry.update(id, xcm_rate_limit)×11 ]). Enables NTT minting for all 11 assets + sets the per-asset deposit/issuance fuse (operator table). Chopsticks-verified (Root dispatch). NB: xcm_rate_limit is also settable by TC majority (AssetRegistry UpdateOrigin) without a referendum.",
      assets: rows.map((r) => ({ sym: r.sym, id: r.id, minter: r.manager.toLowerCase(), limit: r.limit, decimals: r.dec, xcmRateLimitRaw: r.raw.toString() })),
      innerBatchAll: innerHex, innerHash, whitelistedProposal: wlHex,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
    process.exitCode = allOk ? 0 : 1;
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(process.exitCode ?? 0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
