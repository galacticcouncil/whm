/**
 * ⚠️ SUPERSEDED (kept for reference / envelope helpers). This builder's SWEEP calls target the OLD
 * MrlSweeper ABI `sweep(address,uint16,bytes32)` (caller-supplied chain+recipient). The live design is
 * the EOA flow: MrlSweeperHardcoded (`sweep(address)` / `sweepAmount(address,uint256)`, hardcoded dests)
 * + the approve-only proposal in _buildApproveProposal.ts. DO NOT submit sweep-proposal.json against a
 * MrlSweeperHardcoded deployment — the Moonbeam sweep would revert (no such selector) while the Hydration
 * batch's disconnect/withdraw-limit calls still execute. Those disconnect+withdraw calls now live in the
 * standalone cutover proposal (_buildCutoverProposal.ts). Only wrapBatchInputInSend / buildLocationUpdate /
 * buildWithdrawLimit / batchAllCall / whOriginShape / WH_ORIGIN / wrapWhitelist are reused downstream.
 *
 * Build the two-sweep MRL-drain whitelisted governance proposal.
 *
 *   whitelist.dispatch_whitelisted_call_with_preimage(   ← enacts as Root
 *     Utility.batch_all([
 *       SWEEP1            = PolkadotXcm.send(Moonbeam, Xcm[ Transact{SovereignAccount,
 *                            Batch precompile([ token.approve(sweeper,MAX), sweeper.sweep(token,chain,recip) ] ×11) }]),
 *       SCHEDULE_SWEEP2   = Scheduler.schedule_named(id, when=BLOCK_N, None, prio, call = <same sweep XCM inlined>),
 *     ]))
 *
 * The scheduled call is the FULL sweep RuntimeCall inlined — this runtime's
 * pallet_scheduler.schedule_named takes `call: Box<RuntimeCall>` (not a Bounded),
 * so no preimage/Lookup is required. When SWEEP2 fires at BLOCK_N it re-dispatches
 * the identical sweep as Root, catching any stragglers (sweeper is bal==0-safe).
 *
 * The sweep envelope is byte-surgery on Palo's validated PRIME_TEST_EXIT (probes/payloads.ts):
 * keep the whole outer XCM (dest, WithdrawAsset/BuyExecution 1 GLMR/RefundSurplus/DepositAsset,
 * Transact requireWeightAtMost, EthereumXcm gas_limit=5,000,000, Batch precompile target) and only
 * swap the inner batchAll `input` for the 22-subcall (11×[approve,sweep]) drain, recomputing the two
 * dependent SCALE length prefixes. Selectors: batchAll 0x96e292b8, approve 0x095ea7b3, sweep 0x56096545.
 *
 *   pnpm tsx probes/_buildSweepProposal.ts            (BLOCK_N defaults to fork head + 20)
 *   BLOCK_N=1234567 pnpm tsx probes/_buildSweepProposal.ts
 */
import { writeFileSync } from "node:fs";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import { Binary } from "polkadot-api";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";
import { ASSETS, resolveRecipient, type ExitAsset } from "./exitAssets";
import { PRIME_TEST_EXIT } from "./payloads";

// deterministic deploy addr from _probeSweep (above the precompile range)
export const SWEEPER = getAddress("0x00000000000000000000000000000000005A7EE9");
const MAX_UINT = (1n << 256n) - 1n;

const BATCH_ABI = parseAbi(["function batchAll(address[] to, uint256[] value, bytes[] callData, uint64[] gasLimit)"]);
const SWEEP_ABI = parseAbi(["function sweep(address token, uint16 chain, bytes32 recipient) returns (uint64)"]);

// SWEEP2 named-task id: 32-byte ascii label "mrl-sweep2-drain" zero-padded.
export const SWEEP2_ID = ("0x" + Buffer.from("mrl-sweep2-drain".padEnd(32, "\0"), "latin1").toString("hex")) as Hex;

// ── SCALE compact codec (values < 2^30) ──────────────────────────────────────
function compactEncode(n: number): string {
  if (n < 64) return (n << 2).toString(16).padStart(2, "0");
  if (n < 16384) { const v = (n << 2) | 1; return (v & 0xff).toString(16).padStart(2, "0") + (v >> 8).toString(16).padStart(2, "0"); }
  if (n < 1073741824) { const v = (n << 2) | 2; let s = ""; for (let i = 0; i < 4; i++) s += ((v >> (8 * i)) & 0xff).toString(16).padStart(2, "0"); return s; }
  throw new Error("compact too big");
}
const compactByteLen = (n: number): number => (n < 64 ? 1 : n < 16384 ? 2 : 4);
const u32le = (n: number): string => n.toString(16).padStart(8, "0").match(/../g)!.reverse().join("");

// ── batchAll input for ALL 11 MRL tokens: [ token.approve(sweeper,MAX), sweeper.sweep(token,chain,recip) ] ──
export function buildBatchInput(assets: ExitAsset[] = ASSETS): Hex {
  const to: Hex[] = [], value: bigint[] = [], callData: Hex[] = [];
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SWEEPER, MAX_UINT] });
  for (const a of assets) {
    const token = getAddress(a.token);
    const recipient = ("0x" + resolveRecipient(a)) as Hex; // bytes32 (evm left-pad / solana ATA / sui 32b)
    const sweep = encodeFunctionData({ abi: SWEEP_ABI, functionName: "sweep", args: [token, a.originChain, recipient] });
    to.push(token, SWEEPER); value.push(0n, 0n); callData.push(approve, sweep);
  }
  // empty gasLimit[] ⇒ batch precompile forwards all remaining gas to each subcall
  return encodeFunctionData({ abi: BATCH_ABI, functionName: "batchAll", args: [to, value, callData, []] });
}

// ── wrap ANY batch-precompile input in the validated PolkadotXcm.send → Moonbeam Transact(EthereumXcm) envelope ──
//    by swapping PRIME_TEST_EXIT's inner batchAll `input` and recomputing the two dependent SCALE length prefixes.
export function wrapBatchInputInSend(newInputHex: Hex): Hex {
  const full = PRIME_TEST_EXIT.slice(2).toLowerCase();
  const INNER_START = "6d0000404b4c";      // EthereumXcm(6d).transact(00) V1(00) gas_limit lo bytes (5,000,000)
  const TAIL_MARK = "140d01020400010300";  // RefundSurplus(14) + DepositAsset(0d…) beneficiary=SA
  const SEL = "96e292b8";                   // batchAll selector
  const iInner = full.indexOf(INNER_START), iTail = full.indexOf(TAIL_MARK), iSel = full.indexOf(SEL);
  if (iInner < 0 || iTail < 0 || iSel < 0) throw new Error("marker not found in PRIME template");
  const posInner = iInner / 2, posTail = iTail / 2, posSel = iSel / 2;
  const oldInnerLen = posTail - posInner;
  const bpreLen = compactByteLen(oldInnerLen);
  const oldInputLen = (posTail - 1) - posSel;
  const inCompactLen = compactByteLen(oldInputLen);
  const posInputCompact = posSel - inCompactLen;

  const HEAD = full.slice(0, (posInner - bpreLen) * 2);        // …up to & incl. requireWeightAtMost
  const IHEAD = full.slice(posInner * 2, posInputCompact * 2); // 6d0000 gaslimit fee action to value — unchanged
  const TAIL = full.slice(posTail * 2);

  const newInput = newInputHex.slice(2);
  const newInnerCall = IHEAD + compactEncode(newInput.length / 2) + newInput + "00"; // + access_list None
  const rebuilt = HEAD + compactEncode(newInnerCall.length / 2) + newInnerCall + TAIL;
  return ("0x" + rebuilt) as Hex;
}

// ── wrap ONE EVM call (to, input) in the same PolkadotXcm.send → Moonbeam Transact envelope — a SINGLE
//    call (not the batchAll precompile): swap the action `to` (batch precompile → target) AND the input. ──
export function wrapSingleCallInSend(to: Hex, callInput: Hex): Hex {
  const full = PRIME_TEST_EXIT.slice(2).toLowerCase();
  const INNER_START = "6d0000404b4c";
  const TAIL_MARK = "140d01020400010300";
  const SEL = "96e292b8"; // batchAll selector marks the input start in the template
  const iInner = full.indexOf(INNER_START), iTail = full.indexOf(TAIL_MARK), iSel = full.indexOf(SEL);
  if (iInner < 0 || iTail < 0 || iSel < 0) throw new Error("marker not found in PRIME template");
  const posInner = iInner / 2, posTail = iTail / 2, posSel = iSel / 2;
  const oldInnerLen = posTail - posInner;
  const bpreLen = compactByteLen(oldInnerLen);
  const oldInputLen = (posTail - 1) - posSel;
  const inCompactLen = compactByteLen(oldInputLen);
  const posInputCompact = posSel - inCompactLen;

  const HEAD = full.slice(0, (posInner - bpreLen) * 2);
  let IHEAD = full.slice(posInner * 2, posInputCompact * 2); // 6d0000 gaslimit fee action to value
  const TAIL = full.slice(posTail * 2);

  const BATCH = "0000000000000000000000000000000000000808";
  const toHex = to.replace(/^0x/, "").toLowerCase().padStart(40, "0");
  if (!IHEAD.includes(BATCH)) throw new Error("batch precompile `to` not found in template IHEAD");
  IHEAD = IHEAD.replace(BATCH, toHex); // swap action target: batch precompile → the token/sweeper

  const newInput = callInput.slice(2);
  const newInnerCall = IHEAD + compactEncode(newInput.length / 2) + newInput + "00"; // + access_list None
  const rebuilt = HEAD + compactEncode(newInnerCall.length / 2) + newInnerCall + TAIL;
  return ("0x" + rebuilt) as Hex;
}

// ── SWEEP1: rebuild the PolkadotXcm.send envelope around the 22-subcall drain batch ──
export function buildSweepCall(assets: ExitAsset[] = ASSETS): Hex {
  return wrapBatchInputInSend(buildBatchInput(assets));
}

// ── SCHEDULE_SWEEP2: Scheduler(5).schedule_named(2)(id[32], when u32LE, None, priority u8, call=RuntimeCall inline) ──
export function buildScheduleNamed(sweepCall: Hex, blockN: number, id: Hex = SWEEP2_ID, priority = 0): Hex {
  return ("0x0502" + id.slice(2) + u32le(blockN) + "00" + priority.toString(16).padStart(2, "0") + sweepCall.slice(2)) as Hex;
}
// ── Scheduler(5).schedule_after(4)(after u32LE, None, priority u8, call inline) — RELATIVE delay from enactment ──
//    (no absolute block to guess: fires `after` blocks after the proposal enacts, so approves land on Moonbeam first).
export function buildScheduleAfter(call: Hex, after: number, priority = 0): Hex {
  return ("0x0504" + u32le(after) + "00" + priority.toString(16).padStart(2, "0") + call.slice(2)) as Hex;
}

// ── WH-origin disconnect: repoint each MRL asset at its CANONICAL Wormhole provenance location —
//    parents:0, X3[ GeneralKey("wh"), GeneralIndex(tokenChain), GeneralKey(tokenAddress) ] — where
//    (tokenChain, tokenAddress) is the wrapped token's origin identity read live off the Moonbeam
//    wrapper (chainId()/nativeContract()). This location has NO Moonbeam reserve, so after enactment
//    any stale-UI XTokens.transfer(id → Moonbeam) rejects atomically (XTokens::AssetHasNoReserve)
//    instead of proceeding-and-trapping. papi rejects the AssetNativeLocation codec ⇒ hand-SCALE'd.
export const WH_GENERALKEY_DATA = "7768" + "0".repeat(60); // b"wh" right-padded to 32 bytes
export const whGeneralKey = (): Hex => ("0x" + WH_GENERALKEY_DATA) as Hex;

/** Canonical Wormhole origin per MRL asset id: [tokenChain, tokenAddress32]. Sourced live from the
 *  Moonbeam wrapper — chainId()(uint16) + nativeContract()(bytes32) — cross-checked per token. */
export const WH_ORIGIN: Record<number, [number, string]> = {
  18:      [2,  "0x0000000000000000000000006b175474e89094c44da98b954eedeac495271d0f"], // DAI  → eth DAI
  19:      [2,  "0x0000000000000000000000002260fac5e5542a773aa44fbcfedf7c193bc2c599"], // WBTC → eth WBTC
  20:      [2,  "0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"], // WETH → eth WETH
  21:      [2,  "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"], // USDC → eth USDC
  23:      [2,  "0x000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7"], // USDT → eth USDT
  40:      [1,  "0xfcd141e9832caf10ad917495ca0f271b5b293cd47027ea737007ed40eb39a0bd"], // jitoSOL → sol
  43:      [1,  "0x26759f460ee5f743ed66d27c8f2a5623bf39d53ed575955320661e6e13e0e3da"], // PRIME → sol
  44:      [30, "0x00000000000000000000000060a3e35cc302bfa44cb288bc5a4f316fdb1adb42"], // EURC → base
  1000745: [2,  "0x000000000000000000000000a3931d71877c0e7a3148cb7eb4463524fec27fbd"], // sUSDS → eth
  1000752: [1,  "0x069b8857feab8184fb687f634618c035dac439dc1aeb3b5598a0f00000000001"], // SOL → sol
  1000753: [21, "0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3"], // SUI → sui
};

/** WH-origin v-Location SCALE: parents=0, X3[ GeneralKey(len2 "wh"), GeneralIndex(tokenChain), GeneralKey(len32 addr) ]. */
export function whLocationScale(tokenChain: number, tokenAddress: string): string {
  const addr32 = tokenAddress.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  //  00 parents=0 | 03 interior=X3 | 06 GeneralKey 02 len=2 <data32> | 05 GeneralIndex compact(chain) | 06 GeneralKey 20 len=32 <addr32>
  return "00" + "03" + "06" + "02" + WH_GENERALKEY_DATA + "05" + compactEncode(tokenChain) + "06" + "20" + addr32;
}
/** papi-shaped WH-origin location (for JSON / assertions) — mirrors AssetRegistry.AssetLocations(id) after update. */
export function whOriginShape(assetId: number) {
  const [chain, addr] = WH_ORIGIN[assetId];
  return {
    parents: 0,
    interior: { type: "X3", value: [
      { type: "GeneralKey", value: { length: 2, data: whGeneralKey() } },
      { type: "GeneralIndex", value: String(chain) },
      { type: "GeneralKey", value: { length: 32, data: addr } },
    ] },
  };
}
// ── one AssetRegistry(51/0x33).update(1): id u32LE, 7×None, location Some(WH origin), rest None ──
export function buildLocationUpdate(assetId: number): Hex {
  const [chain, addr] = WH_ORIGIN[assetId];
  //  33 01 | id u32LE | 7×00 (name/asset_type/existential_deposit/xcm_rate_limit/is_sufficient/symbol/decimals None)
  //        | 01 (location Some) | WH-origin location SCALE
  return ("0x3301" + u32le(assetId) + "00000000000000" + "01" + whLocationScale(chain, addr)) as Hex;
}

// ── EVMAccounts(93/0x5d).set_ntt_minter(7)(asset_id u32 LE, minter H160) — binds the NTT spoke manager as minter ──
export function buildSetNttMinter(assetId: number, manager: Hex): Hex {
  return ("0x5d07" + u32le(assetId) + manager.replace(/^0x/, "").toLowerCase()) as Hex;
}

// ── AssetRegistry(51/0x33).update(1)(id, …, xcm_rate_limit=Some(raw), …) — set only the per-asset xcm_rate_limit ──
//    33 01 | id u32LE | 3×00 (name/asset_type/existential None) | 01 + u128 LE | 4×00 (is_sufficient/symbol/decimals/location None)
export function buildRateLimitUpdate(assetId: number, raw: bigint): Hex {
  const u128le = (n: bigint): string => n.toString(16).padStart(32, "0").match(/../g)!.reverse().join("");
  return ("0x3301" + u32le(assetId) + "000000" + "01" + u128le(raw) + "00000000") as Hex;
}

// ── CircuitBreaker(65/0x41).set_global_withdraw_limit_params(6)({ limit u128, window Moment(u64) }) ──
//    tightens the GLOBAL withdraw limit to 1/5 of live (1B → 200M HDX / 6h). Applies to every asset
//    counted toward the global limit (DAI et al. via GlobalAssetOverrides=External), not just MRL.
export const WITHDRAW_LIMIT_RAW = 200_000_000n * 10n ** 12n; // 200M HDX (HDX = 12 decimals)
export const WITHDRAW_WINDOW_MS = 21_600_000;                // 6h
const u128le = (n: bigint): string => n.toString(16).padStart(32, "0").match(/../g)!.reverse().join("");
const u64le = (n: number): string => BigInt(n).toString(16).padStart(16, "0").match(/../g)!.reverse().join("");
export function buildWithdrawLimit(limit: bigint = WITHDRAW_LIMIT_RAW, windowMs: number = WITHDRAW_WINDOW_MS): Hex {
  return ("0x4106" + u128le(limit) + u64le(windowMs)) as Hex;
}

// ── generic Utility(13).batch_all(2)(calls) ──
export function batchAllCall(calls: Hex[]): Hex {
  return ("0x0d02" + compactEncode(calls.length) + calls.map((c) => c.slice(2)).join("")) as Hex;
}
// ── inner Utility(13).batch_all([ SWEEP1, SCHEDULE_SWEEP2, update(id)×N, set_global_withdraw_limit ]) ──
//    N=11 + withdraw ⇒ 14 calls ⇒ compact(14)=0x38. updates=[]/withdraw=undefined reproduces the original 2-call batch.
export function buildInner(sweepCall: Hex, scheduleNamed: Hex, updates: Hex[] = [], withdraw?: Hex): Hex {
  return batchAllCall([sweepCall, scheduleNamed, ...updates, ...(withdraw ? [withdraw] : [])]);
}
// ── whitelist wrapper: Whitelist(39).dispatch_whitelisted_call_with_preimage(3)(inner) ──
export const wrapWhitelist = (inner: Hex): Hex => ("0x2703" + inner.slice(2)) as Hex;

async function main() {
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const head = nets.hydration.chain.head.number;
    const blockN = process.env.BLOCK_N ? Number(process.env.BLOCK_N) : head + 20;
    const blockNIsPlaceholder = !process.env.BLOCK_N;

    const sweepCall = buildSweepCall();
    const scheduleNamed = buildScheduleNamed(sweepCall, blockN);
    const updates = ASSETS.map((a) => buildLocationUpdate(a.id)); // 11 WH-origin XCM-disconnect location swaps
    const withdraw = buildWithdrawLimit();                        // tighten global withdraw limit to 1/5
    const inner = buildInner(sweepCall, scheduleNamed, updates, withdraw);
    const proposal = wrapWhitelist(inner);

    const innerBin = Binary.fromHex(inner);
    const registry: any = await nets.hydration.chain.head.registry;
    const innerHash = registry.hash(innerBin as any).toHex() as Hex;
    const sweepHash = registry.hash(Binary.fromHex(sweepCall) as any).toHex() as Hex;

    // self-decode the whole inner
    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(innerBin)).decodedCall;
      const calls = dc.value.value.calls;
      const c0 = calls[0], c1 = calls[1];
      const sweepDc = c0.value.value; // PolkadotXcm.send
      const instrs = sweepDc.message.value.map((i: any) => i.type).join("/");
      const schedInner = c1.value.value.call; // scheduled RuntimeCall
      const updCount = calls.filter((c: any) => c.type === "AssetRegistry" && c.value.type === "update").length;
      const updIds = calls.filter((c: any) => c.type === "AssetRegistry").map((c: any) => c.value?.value?.asset_id).join(",");
      const cbCall = calls.find((c: any) => c.type === "CircuitBreaker");
      decodeInfo = `${dc.type}.${dc.value.type}[${calls.length} calls: send, schedule_named, update×${updCount}, ${cbCall ? cbCall.value.type : "—"}]`
        + ` | SWEEP1 instrs=${instrs} | SWEEP2.when=${c1.value.value.when} call=${schedInner.type}.${schedInner.value.type}`
        + ` | update.asset_ids=[${updIds}]`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    const tokens = ASSETS.map((a) => ({
      sym: a.sym, id: a.id, token: getAddress(a.token), decimals: a.decimals,
      recipientChain: a.originChain, recipient: "0x" + resolveRecipient(a),
      wormholeOrigin: { tokenChain: WH_ORIGIN[a.id][0], tokenAddress: WH_ORIGIN[a.id][1] },
      whOrigin: whOriginShape(a.id),          // AssetLocations(id) after enactment
      locationUpdate: buildLocationUpdate(a.id), // AssetRegistry.update SCALE (hand-encoded)
    }));

    console.log(`\n════════ two-sweep MRL-drain proposal ════════`);
    console.log(`sweeper           : ${SWEEPER}`);
    console.log(`tokens            : ${ASSETS.length} (${ASSETS.map((a) => a.sym).join(", ")})`);
    console.log(`BLOCK_N           : ${blockN}${blockNIsPlaceholder ? "  (placeholder = forkHead+20; set BLOCK_N env for real)" : ""}`);
    console.log(`SWEEP1 send call  : ${(sweepCall.length - 2) / 2} bytes  (blake2: ${sweepHash})`);
    console.log(`schedule_named    : ${(scheduleNamed.length - 2) / 2} bytes`);
    console.log(`location updates  : ${updates.length} × AssetRegistry.update WH-origin (${updates.map((u) => (u.length - 2) / 2).join("/")} bytes)`);
    console.log(`withdraw limit    : set_global_withdraw_limit_params(${WITHDRAW_LIMIT_RAW / 10n ** 12n} HDX / ${WITHDRAW_WINDOW_MS / 3_600_000}h)  ${(withdraw.length - 2) / 2} bytes`);
    console.log(`inner batch_all   : ${innerBin.length} bytes  (${2 + updates.length + 1} calls, compact prefix 0x${compactEncode(2 + updates.length + 1)})`);
    console.log(`inner blake2-256  : ${innerHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/sweep-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "⚠️ SUPERSEDED — targets the OLD MrlSweeper sweep(address,uint16,bytes32); DO NOT submit against a "
        + "MrlSweeperHardcoded deploy (Moonbeam sweep would revert while the Hydration disconnect/withdraw still runs). "
        + "Live design: EOA sweeper + SPLIT proposals — approve-proposal.json (enabling) then cutover-proposal.json "
        + "(disconnect+withdraw, gated on verified Moonbeam allowances). --- "
        + "two-sweep MRL-drain + XCM-disconnect + withdraw-limit cut (single enactment). Batch_all has 14 calls: SWEEP1, "
        + "Scheduler.schedule_named(SWEEP2@BLOCK_N), then 11× AssetRegistry.update(id, location=WH-origin), then "
        + "CircuitBreaker.set_global_withdraw_limit_params(200M HDX / 6h = 1/5 of live). "
        + "The 11 updates repoint each MRL asset at its CANONICAL Wormhole provenance parents:0 X3[GeneralKey('wh'), "
        + "GeneralIndex(tokenChain), GeneralKey(tokenAddress)] read live off the Moonbeam wrapper (chainId()/nativeContract()). "
        + "This location has NO Moonbeam reserve, so after enactment any stale-UI XTokens.transfer(id → Moonbeam) rejects "
        + "atomically with XTokens::AssetHasNoReserve (funds never leave the wallet), while the old Moonbeam reverse "
        + "LocationAssets key is dropped. Order after the two sweep calls is irrelevant. --- "
        + "SWEEP1 fires immediately; SWEEP2 re-dispatches the identical sweep at BLOCK_N to catch stragglers (sweeper is bal==0-safe). "
        + "The scheduled call is passed INLINE (this runtime's pallet_scheduler.schedule_named takes call: Box<RuntimeCall>, so the "
        + "proposal needs no manual note_preimage — batch_all has exactly two calls). pallet_scheduler then internally bounds the "
        + "5717-byte call as a preimage, so the stored Agenda entry is Bounded::Lookup{hash=sweepHash, len=5717} and the preimage is "
        + "auto-noted by the scheduler; it is available and realized when SWEEP2 fires at BLOCK_N. "
        + "gas_limit=5,000,000 per PRIME template (chopsticks-verified sufficient for all 11 sweeps in one Transact). "
        + "BEFORE SUBMIT: set real BLOCK_N, re-point provisional recipients (Sui multisig, Solana ATAs, ETH Safe deploy at COUNCIL[2]), "
        + "verify the deployed sweeper address + its SA()/BRIDGE() immutables on-chain per the audit operational checklist.",
      sweeper: SWEEPER,
      blockN, blockNIsPlaceholder,
      sweep2Id: SWEEP2_ID,
      tokens,
      sweepCall, sweepHash,
      scheduleNamed,
      whGeneralKeyData: whGeneralKey(),
      locationUpdates: ASSETS.map((a) => ({
        id: a.id, sym: a.sym, tokenChain: WH_ORIGIN[a.id][0], tokenAddress: WH_ORIGIN[a.id][1],
        whOrigin: whOriginShape(a.id), updateCall: buildLocationUpdate(a.id),
      })),
      withdrawLimit: {
        call: withdraw, limitRaw: WITHDRAW_LIMIT_RAW.toString(),
        limitHDX: (WITHDRAW_LIMIT_RAW / 10n ** 12n).toLocaleString("en-US") + " HDX",
        windowMs: WITHDRAW_WINDOW_MS, note: "1/5 of live 1,000,000,000 HDX / 6h",
      },
      innerBatchAll: inner,
      innerHash,
      whitelistedProposal: proposal,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}

// run as script (not when imported by the probe)
if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
}
