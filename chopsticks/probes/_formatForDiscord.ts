/**
 * Format the live sunset proposals (initial-sweep + cutover) into a Discord-ready text with full
 * decoded call trees + raw hex.  pnpm tsx probes/_formatForDiscord.ts > /tmp/sweeper-proposals.txt
 */
import { readFileSync } from "node:fs";
import { decodeFunctionData, erc20Abi, parseAbi, type Hex } from "viem";

const BATCH_ABI = parseAbi(["function batchAll(address[] to, uint256[] value, bytes[] callData, uint64[] gasLimit)"]);
const SWEEP_ABI = parseAbi(["function sweep(address token) returns (uint64)"]);
const SYM: Record<string, string> = {}; // token addr → sym, filled from json

const initial = JSON.parse(readFileSync(new URL("./initial-sweep-proposal.json", import.meta.url), "utf8"));
const cutover = JSON.parse(readFileSync(new URL("./cutover-proposal.json", import.meta.url), "utf8"));
for (const t of initial.tokens) SYM[t.token.toLowerCase()] = t.sym;

const short = (h: string) => h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
const out: string[] = [];
const p = (s = "") => out.push(s);

p("════════════════════════════════════════════════════════════");
p("  MRL SUNSET — SWEEPER PROPOSALS (hex + decoded)");
p("════════════════════════════════════════════════════════════");
p("Live flow: (1) deploy MrlSweeperHardcoded [CREATE2] → (2) INITIAL-SWEEP proposal (SA drains) →");
p("(3) EOA/OWNER backstops stragglers → (4) CUTOVER proposal (disconnect+withdraw) → (5) revoke approval.");
p("⚠️ sweeper below = CREATE2-predicted for a PLACEHOLDER owner (0x…bEEF) — TEMPLATE. Regenerate with the");
p("   final OWNER before submit; the cutover proposal has NO sweeper dependency (its hex is final).");
p("");

// ── 1. INITIAL-SWEEP ──
p("──────────────────────────────────────────────");
p("① INITIAL-SWEEP PROPOSAL  (SA atomic approve+sweep)");
p("──────────────────────────────────────────────");
p(`sweeper (spender): ${initial.sweeper}   [TEMPLATE]`);
p(`blake2 (TC whitelists): ${initial.blake2}`);
p("");
p("DECODED (substrate):");
p("  Whitelist.dispatch_whitelisted_call_with_preimage(   ← enacts as Root");
p("    PolkadotXcm.send( dest = Moonbeam (parachain 2004),");
p("      Xcm[ WithdrawAsset, BuyExecution(1 GLMR), Transact{ origin=SovereignAccount,");
p("           EthereumXcm.transact gas=5,000,000, input = Batch precompile(batchAll) },");
p("           RefundSurplus, DepositAsset(→ SA) ] ))");
p("");
p("DECODED (EVM batch executed by the SA on Moonbeam — 22 subcalls):");
{
  const [to, , callData] = decodeFunctionData({ abi: BATCH_ABI, data: initial.initialSweepInput as Hex }).args as any;
  for (let i = 0; i < callData.length; i++) {
    const cd = callData[i] as Hex;
    const target = (to[i] as string).toLowerCase();
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data: cd });
      if (d.functionName === "approve") { p(`  approve(spender=${short(String(d.args[0]))}, MAX)   on token ${short(target)} (${SYM[target] ?? "?"})`); continue; }
    } catch {}
    try {
      const d = decodeFunctionData({ abi: SWEEP_ABI, data: cd });
      if (d.functionName === "sweep") { const tk = String(d.args[0]).toLowerCase(); p(`  sweeper.sweep(token=${short(tk)} (${SYM[tk] ?? "?"}))   → hardcoded treasury dest`); continue; }
    } catch {}
    p(`  <unknown subcall> on ${short(target)}: ${cd.slice(0, 12)}…`);
  }
}
p("");
p(`HEX (whitelisted proposal, ${(initial.whitelistedProposal.length - 2) / 2} bytes):`);
p(initial.whitelistedProposal);
p("");

// ── 2. CUTOVER ──
p("──────────────────────────────────────────────");
p("② CUTOVER PROPOSAL  (LOCAL Hydration, atomic)");
p("──────────────────────────────────────────────");
p(`inner blake2 (TC whitelists): ${cutover.innerHash}`);
p("");
p("DECODED (substrate):");
p("  Whitelist.dispatch_whitelisted_call_with_preimage(   ← enacts as Root");
p("    Utility.batch_all([");
for (const u of cutover.locationUpdates)
  p(`      AssetRegistry.update(id=${u.id} (${u.sym}), location = WH-origin X3[GeneralKey('wh'), GeneralIndex(${u.tokenChain}), GeneralKey(${short(u.tokenAddress)})]),`);
p(`      CircuitBreaker.set_global_withdraw_limit_params(limit=${cutover.withdrawLimit.limitHDX}, window=${cutover.withdrawLimit.windowMs / 3_600_000}h)   // 1/5 of live`);
p("    ]))");
p("");
p(`HEX (whitelisted proposal, ${(cutover.whitelistedProposal.length - 2) / 2} bytes):`);
p(cutover.whitelistedProposal);
p("");
p("════════════════════════════════════════════════════════════");
p("Contracts attached: MrlSweeperHardcoded.sol, DeployMrlSweeperHardcoded.s.sol");
p("Verified: forge 13/13 (auth, hardcoded-dest, 8dp-floor, fee-forward, guards); approve + cutover");
p("chopsticks (2-chain / local) ALL PASS; initial-sweep self-decoded (full 2-chain e2e pending real deploy).");

console.log(out.join("\n"));
