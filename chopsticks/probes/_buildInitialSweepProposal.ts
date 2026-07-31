/**
 * Build the INITIAL-SWEEP proposal — the SA drains via governance, WITHOUT the Moonbeam batchAll
 * precompile. Each approve and each sweep is its own PolkadotXcm.send → single Moonbeam Transact →
 * single EVM call (msg.sender = SA), so no single over-stuffed Transact can revert them all and each
 * gets its own gas budget. Approves fire immediately; the sweeps are scheduled a few blocks later so
 * the allowances are live on Moonbeam first. Full balance per token, routed through the sweeper's
 * hardcoded dests. (The old single-Transact batchAll form reverted — one Transact couldn't fit 22 subcalls.)
 *
 *   whitelist.dispatch_whitelisted_call_with_preimage(          ← enacts as Root
 *     Utility.batch_all([
 *       PolkadotXcm.send(Transact{SA, token_i.approve(sweeper, MAX)})  ×11,   ← immediate
 *       Scheduler.schedule_named(when = now+N, Utility.batch_all([
 *         PolkadotXcm.send(Transact{SA, sweeper.sweep(token_i)}) ×11           ← scheduled, full balance
 *       ]))
 *     ]))
 *
 *   SWEEPER=0x… pnpm tsx probes/_buildInitialSweepProposal.ts     (BLOCK_N env optional; SWEEPER REQUIRED)
 */
import { writeFileSync } from "node:fs";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import { Binary } from "polkadot-api";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";
import { ASSETS } from "./exitAssets";
import { wrapSingleCallInSend, wrapWhitelist, batchAllCall, buildScheduleNamed, buildLocationUpdate } from "./_buildSweepProposal";

const MAX_UINT = (1n << 256n) - 1n;
const SWEEP_ABI = parseAbi(["function sweep(address token) returns (uint64)"]);
const SWEEPS_ID = ("0x" + Buffer.from("mrl-initial-sweeps".padEnd(32, "\0"), "latin1").toString("hex")) as Hex;

export const SWEEPER = getAddress(process.env.SWEEPER ?? "0x00000000000000000000000000000000005A7EE9");
function requireSweeper(): Hex {
  const s = process.env.SWEEPER;
  if (!s) throw new Error("SWEEPER env REQUIRED — the deployed/CREATE2 MrlSweeperHardcoded address. No placeholder default.");
  return getAddress(s);
}

// one approve as its own XCM send: Transact{SA, token.approve(sweeper, MAX)}
export function buildApproveSend(sweeper: Hex, token: Hex): Hex {
  const input = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [sweeper, MAX_UINT] });
  return wrapSingleCallInSend(token, input);
}
// one full-balance sweep as its own XCM send: Transact{SA, sweeper.sweep(token)}
export function buildSweepSend(sweeper: Hex, token: Hex): Hex {
  const input = encodeFunctionData({ abi: SWEEP_ABI, functionName: "sweep", args: [token] });
  return wrapSingleCallInSend(sweeper, input);
}

// inner = batch_all([ approveSend×11, schedule_named(now+N, batch_all([ sweepSend×11, disconnect×11 ])) ])
//   the scheduled batch drains (sweep sends → Moonbeam) AND severs each token from XCM (local AssetRegistry.update
//   → WH-origin location, no Moonbeam reserve) at BLOCK_N — the cutover moment.
export function buildInitialSweepInner(sweeper: Hex, blockN: number): Hex {
  const approveSends = ASSETS.map((a) => buildApproveSend(sweeper, getAddress(a.token)));
  const sweepSends = ASSETS.map((a) => buildSweepSend(sweeper, getAddress(a.token)));
  const disconnects = ASSETS.map((a) => buildLocationUpdate(a.id)); // sever from XCM (WH-origin location)
  const schedule = buildScheduleNamed(batchAllCall([...sweepSends, ...disconnects]), blockN, SWEEPS_ID);
  return batchAllCall([...approveSends, schedule]);
}

async function main() {
  const sweeper = requireSweeper();
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const blockN = process.env.BLOCK_N ? Number(process.env.BLOCK_N) : nets.hydration.chain.head.number + 10;
    const inner = buildInitialSweepInner(sweeper, blockN);
    const proposal = wrapWhitelist(inner);

    const innerBin = Binary.fromHex(inner);
    const registry: any = await nets.hydration.chain.head.registry;
    const innerHash = registry.hash(innerBin as any).toHex() as Hex;

    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(innerBin)).decodedCall;
      const calls = dc.value.value.calls;
      const c0 = calls[0];
      const instrs = c0.value.value.message.value.map((i: any) => i.type).join("/");
      const sched = calls[calls.length - 1];
      const schedInner = sched.value.value.call;
      decodeInfo = `${dc.type}.${dc.value.type}[${calls.length}: send×${calls.length - 1} + ${sched.value.type}]`
        + ` | send0 instrs=${instrs} | scheduled=${schedInner?.type}.${schedInner?.value?.type}[${schedInner?.value?.value?.calls?.length} sweep sends]@${sched.value.value.when}`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    console.log(`\n════════ initial-sweep proposal (no batchAll) ════════`);
    console.log(`sweeper           : ${sweeper}`);
    console.log(`BLOCK_N (sweeps)  : ${blockN}${process.env.BLOCK_N ? "" : "  (placeholder head+10)"}`);
    console.log(`structure         : 11 approve sends (now) + schedule_named(11 full-sweep sends @ BLOCK_N)`);
    console.log(`inner batch_all   : ${innerBin.length} bytes  (${ASSETS.length + 1} calls)`);
    console.log(`inner blake2-256  : ${innerHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/initial-sweep-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "INITIAL-SWEEP (no batchAll precompile). batch_all([ PolkadotXcm.send(Transact{SA, token.approve(sweeper,MAX)})×11, "
        + "Scheduler.schedule_named(@BLOCK_N, batch_all([ PolkadotXcm.send(Transact{SA, sweeper.sweep(token)})×11 ])) ]). Each "
        + "approve/sweep is its own single-call Moonbeam Transact (msg.sender=SA) — no batchAll precompile (the 22-subcall batchAll "
        + "reverted: one Transact couldn't fit it). Sweeps scheduled a few blocks after the approves so allowances are live first. "
        + "Full balance per token via the sweeper's hardcoded dests. The OWNER EOA backstops stragglers afterward. SWEEPER = deployed "
        + "MrlSweeperHardcoded. BEFORE SUBMIT: set real BLOCK_N + real SWEEPER; confirm the 11 tokens are registered on the Moonbeam bridge.",
      sweeper, blockN,
      tokens: ASSETS.map((a) => ({ sym: a.sym, id: a.id, token: getAddress(a.token) })),
      innerBatchAll: inner, innerHash, whitelistedProposal: proposal,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
}
