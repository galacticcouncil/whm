/**
 * Build the INITIAL-SWEEP whitelisted proposal — the SA does the first, atomic drain in one enactment.
 * approve and sweep happen in the SAME Moonbeam Transact (one EVM tx), so no scheduling / cross-chain
 * timing is needed: the allowance is granted and consumed atomically.
 *
 *   whitelist.dispatch_whitelisted_call_with_preimage(          ← enacts as Root
 *     PolkadotXcm.send(Moonbeam, Xcm[ …Transact{ SovereignAccount,
 *       Batch precompile([ token.approve(sweeper, MAX), sweeper.sweep(token) ] ×11) } ]))
 *
 * Draining full balances to the sweeper's HARDCODED destinations. The standing MAX approval survives
 * (MAX − swept), so the OWNER EOA can BACKSTOP stragglers/late-arrivals afterward via sweeper.sweep().
 * Disconnect + withdraw are NOT here — they live in the separate cutover proposal, gated on a verified
 * Moonbeam drain (never sever routes on a local "batch succeeded" event alone).
 *
 * Order:  1) deploy sweeper (CREATE2)  2) THIS proposal → enact → SA drains + arms the standing approval
 *         3) EOA backstop sweeps for stragglers up to sunset  4) cutover (disconnect+withdraw)  5) revoke approval
 *
 *   SWEEPER=0x… pnpm tsx probes/_buildInitialSweepProposal.ts     (SWEEPER REQUIRED — the approve spender)
 */
import { writeFileSync } from "node:fs";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from "viem";
import { Binary } from "polkadot-api";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";
import { ASSETS } from "./exitAssets";
import { wrapBatchInputInSend, wrapWhitelist } from "./_buildSweepProposal";

const MAX_UINT = (1n << 256n) - 1n;
const BATCH_ABI = parseAbi(["function batchAll(address[] to, uint256[] value, bytes[] callData, uint64[] gasLimit)"]);
const SWEEP_ABI = parseAbi(["function sweep(address token) returns (uint64)"]); // MrlSweeperHardcoded, hardcoded dest

export const SWEEPER = getAddress(process.env.SWEEPER ?? "0x00000000000000000000000000000000005A7EE9");
function requireSweeper(): Hex {
  const s = process.env.SWEEPER;
  if (!s) throw new Error("SWEEPER env REQUIRED — the deployed/CREATE2-predicted MrlSweeperHardcoded address. No placeholder default.");
  return getAddress(s);
}

// ── batchAll input = [ token.approve(sweeper, MAX), sweeper.sweep(token) ] ×11 (22 subcalls, atomic) ──
export function buildInitialSweepInput(sweeper: Hex): Hex {
  const to: Hex[] = [], value: bigint[] = [], callData: Hex[] = [];
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [sweeper, MAX_UINT] });
  for (const a of ASSETS) {
    const token = getAddress(a.token);
    const sweep = encodeFunctionData({ abi: SWEEP_ABI, functionName: "sweep", args: [token] });
    to.push(token, sweeper); value.push(0n, 0n); callData.push(approve, sweep);
  }
  return encodeFunctionData({ abi: BATCH_ABI, functionName: "batchAll", args: [to, value, callData, []] });
}

// ── the whitelisted call = PolkadotXcm.send envelope around the atomic approve+sweep batch ──
export function buildInitialSweepCall(sweeper: Hex): Hex {
  return wrapBatchInputInSend(buildInitialSweepInput(sweeper));
}

async function main() {
  const sweeper = requireSweeper();
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const call = buildInitialSweepCall(sweeper);
    const proposal = wrapWhitelist(call);

    const callBin = Binary.fromHex(call);
    const registry: any = await nets.hydration.chain.head.registry;
    const hash = registry.hash(callBin as any).toHex() as Hex;

    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(callBin)).decodedCall;
      const instrs = dc.value.value.message.value.map((i: any) => i.type).join("/");
      decodeInfo = `${dc.type}.${dc.value.type} | instrs=${instrs}`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    console.log(`\n════════ initial-sweep (SA, atomic approve+sweep) proposal ════════`);
    console.log(`sweeper           : ${sweeper}`);
    console.log(`subcalls          : ${ASSETS.length} × [approve(sweeper,MAX), sweeper.sweep(token)] = ${ASSETS.length * 2}`);
    console.log(`send call         : ${(call.length - 2) / 2} bytes`);
    console.log(`blake2-256        : ${hash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/initial-sweep-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "INITIAL-SWEEP whitelisted proposal — the SA's first atomic drain. PolkadotXcm.send(Moonbeam, Transact{SA, "
        + "batchAll([approve(sweeper,MAX), sweeper.sweep(token)]×11)}). approve+sweep are ONE Moonbeam EVM tx (allowance set and "
        + "consumed atomically — no scheduling/timing needed). Drains full balances to the sweeper's hardcoded dests; emits all 11 "
        + "Wormhole messages at once (Governor delays VAA signing for big ones, which release post-sunset since emitted pre-cutoff). "
        + "The standing MAX approval survives (MAX − swept) so the OWNER EOA can BACKSTOP stragglers afterward. Disconnect + withdraw "
        + "are SEPARATE (cutover-proposal.json), gated on a verified Moonbeam drain. SWEEPER = deployed MrlSweeperHardcoded (approve "
        + "spender). BEFORE SUBMIT: regenerate with the final sweeper address; confirm SA()/OWNER()/BRIDGE()/destOf on-chain; confirm "
        + "the 11 tokens are registered on the Moonbeam token bridge; size against the Governor if a single full-drain would breach the "
        + "daily cap in a way you don't want.",
      sweeper,
      sweeperIsCreate2Predicted: true,
      tokens: ASSETS.map((a) => ({ sym: a.sym, id: a.id, token: getAddress(a.token) })),
      initialSweepInput: buildInitialSweepInput(sweeper),
      initialSweepCall: call, blake2: hash,
      whitelistedProposal: proposal,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
}
