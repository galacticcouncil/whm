/** Decode the initial-sweep proposal into a readable call tree + hex for Discord. pnpm tsx probes/_decodeSweepProp.ts */
import { readFileSync } from "node:fs";
import { getAddress } from "viem";
import { ASSETS } from "./exitAssets";
import { WH_ORIGIN } from "./_buildSweepProposal";

const d = JSON.parse(readFileSync(new URL("./initial-sweep-proposal.json", import.meta.url), "utf8"));
const sw = d.sweeper as string;
const delay = d.delay ?? 20;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;
const CH: Record<number, string> = { 1: "Solana", 2: "Ethereum", 21: "Sui", 30: "Base" };
const L: string[] = [];
const p = (s = "") => L.push(s);

p("════════════════════════════════════════════════════════════");
p("  MRL SUNSET — INITIAL-SWEEP PROPOSAL — DECODED");
p("════════════════════════════════════════════════════════════");
p(`sweeper (deployed + verified): ${sw}`);
p(`  https://moonbeam.moonscan.io/address/${sw.toLowerCase()}#code`);
p(`inner blake2 (TC whitelists): ${d.innerHash}`);
p("");
p("Whitelist.dispatch_whitelisted_call_with_preimage(  [pallet 39, call 3 — enacts as Root]");
p("  Utility.batch_all([                               [pallet 13, call 2]");
p("");
p("    ── 11× approve (fire immediately) ──");
ASSETS.forEach((a) => {
  p(`    PolkadotXcm.send( dest = Moonbeam(parachain 2004),`);
  p(`      Xcm[ WithdrawAsset, BuyExecution(1 GLMR), Transact{ SovereignAccount, EthereumXcm.transact gas=5,000,000,`);
  p(`           to=${getAddress(a.token)} (${a.sym}), input = approve(spender=${short(sw)}, MAX) }, RefundSurplus, DepositAsset(→SA) ] )`);
});
p("");
p(`    ── Scheduler.schedule_after( ${delay}, priority=0,   [pallet 5, call 4 — relative delay from enactment]`);
p("        Utility.batch_all([");
p("");
p("          ── 11× sweep (full balance → hardcoded dest) ──");
ASSETS.forEach((a) => {
  const [chain, addr] = WH_ORIGIN[a.id];
  p(`          PolkadotXcm.send( Moonbeam, Transact{ SA, to=${short(sw)} (sweeper),`);
  p(`            input = sweep(token=${getAddress(a.token)} (${a.sym})) }  → bridges to hardcoded ${CH[chain]} dest`);
});
p("");
p("          ── 11× sever from XCM (local Hydration) ──");
ASSETS.forEach((a) => {
  const [chain, addr] = WH_ORIGIN[a.id];
  p(`          AssetRegistry.update( asset_id=${a.id} (${a.sym}),   [pallet 51, call 1]`);
  p(`            location = { parents:0, X3[ GeneralKey("wh"), GeneralIndex(${chain}=${CH[chain]}), GeneralKey(${short(addr)}) ] } )`);
});
p("        ])");
p("    )");
p("  ])");
p(")");
p("");
p("Notes: each Moonbeam call is its own single Transact (msg.sender = SA) — NO batchAll precompile.");
p(`  +${delay}-block relative delay lets the approves land on Moonbeam before the scheduled sweeps.`);
p("  Verified 2-chain e2e: 11 approves land, 11 drained, 11 VAAs to correct dests, 11 severed, backstop approval survives.");
p("");
p(`════════ ENCODED HEX ════════`);
p(`inner batch_all (${(d.innerBatchAll.length - 2) / 2} bytes):`);
p(d.innerBatchAll);
p("");
p(`whitelisted proposal (${(d.whitelistedProposal.length - 2) / 2} bytes):`);
p(d.whitelistedProposal);

console.log(L.join("\n"));
