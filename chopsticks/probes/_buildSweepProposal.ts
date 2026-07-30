/**
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

// ── SWEEP1: rebuild the PolkadotXcm.send envelope by swapping PRIME_TEST_EXIT's inner batchAll input ──
export function buildSweepCall(assets: ExitAsset[] = ASSETS): Hex {
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

  const newInput = buildBatchInput(assets).slice(2);
  const newInnerCall = IHEAD + compactEncode(newInput.length / 2) + newInput + "00"; // + access_list None
  const rebuilt = HEAD + compactEncode(newInnerCall.length / 2) + newInnerCall + TAIL;
  return ("0x" + rebuilt) as Hex;
}

// ── SCHEDULE_SWEEP2: Scheduler(5).schedule_named(2)(id[32], when u32LE, None, priority u8, call=RuntimeCall inline) ──
export function buildScheduleNamed(sweepCall: Hex, blockN: number, id: Hex = SWEEP2_ID, priority = 0): Hex {
  return ("0x0502" + id.slice(2) + u32le(blockN) + "00" + priority.toString(16).padStart(2, "0") + sweepCall.slice(2)) as Hex;
}

// ── inner Utility(13).batch_all(2)([ SWEEP1, SCHEDULE_SWEEP2 ]) ──
export function buildInner(sweepCall: Hex, scheduleNamed: Hex): Hex {
  return ("0x0d02" + compactEncode(2) + sweepCall.slice(2) + scheduleNamed.slice(2)) as Hex;
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
    const inner = buildInner(sweepCall, scheduleNamed);
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
      decodeInfo = `${dc.type}.${dc.value.type}[${calls.map((c: any) => c.type + "." + c.value.type).join(", ")}]`
        + ` | SWEEP1 instrs=${instrs} | SWEEP2.when=${c1.value.value.when} call=${schedInner.type}.${schedInner.value.type}`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    const tokens = ASSETS.map((a) => ({
      sym: a.sym, id: a.id, token: getAddress(a.token), decimals: a.decimals,
      recipientChain: a.originChain, recipient: "0x" + resolveRecipient(a),
    }));

    console.log(`\n════════ two-sweep MRL-drain proposal ════════`);
    console.log(`sweeper           : ${SWEEPER}`);
    console.log(`tokens            : ${ASSETS.length} (${ASSETS.map((a) => a.sym).join(", ")})`);
    console.log(`BLOCK_N           : ${blockN}${blockNIsPlaceholder ? "  (placeholder = forkHead+20; set BLOCK_N env for real)" : ""}`);
    console.log(`SWEEP1 send call  : ${(sweepCall.length - 2) / 2} bytes  (blake2: ${sweepHash})`);
    console.log(`schedule_named    : ${(scheduleNamed.length - 2) / 2} bytes`);
    console.log(`inner batch_all   : ${innerBin.length} bytes`);
    console.log(`inner blake2-256  : ${innerHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/sweep-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "two-sweep MRL-drain (dynamic full-balance drain of the para-2034 Moonbeam SA via MrlSweeper + Wormhole TokenBridge). "
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
