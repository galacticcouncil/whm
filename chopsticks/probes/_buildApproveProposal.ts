/**
 * Build the APPROVE-ONLY whitelisted governance proposal for the EOA-driven sweeper
 * (MrlSweeperHardcoded). This is the *only* on-chain governance step of the new flow:
 *
 *   whitelist.dispatch_whitelisted_call_with_preimage(          ← enacts as Root
 *     PolkadotXcm.send(Moonbeam, Xcm[ …Transact{ SovereignAccount,
 *       Batch precompile([ token.approve(sweeper, MAX) ] ×11) } ]))
 *
 * After enactment the SA holds a standing MAX approval to the sweeper for all 11 tokens, and the
 * SA (governance) or the sweeper's OWNER EOA can drain them token-by-token via sweeper.sweep().
 * No scheduler, no per-token sweep subcalls in governance — draining is off-chain EOA calls.
 *
 *   SWEEPER=0x… pnpm tsx probes/_buildApproveProposal.ts   (SWEEPER defaults to the deploy placeholder)
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

// address of the deployed MrlSweeperHardcoded — PLACEHOLDER until deploy; the approve spender MUST equal it.
export const SWEEPER = getAddress(process.env.SWEEPER ?? "0x00000000000000000000000000000000005A7EE9");

// ── batchAll input = [ token.approve(sweeper, MAX) ] for all 11 MRL tokens (11 subcalls, no sweeps) ──
export function buildApproveInput(sweeper: Hex = SWEEPER): Hex {
  const to: Hex[] = [], value: bigint[] = [], callData: Hex[] = [];
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [sweeper, MAX_UINT] });
  for (const a of ASSETS) { to.push(getAddress(a.token)); value.push(0n); callData.push(approve); }
  return encodeFunctionData({ abi: BATCH_ABI, functionName: "batchAll", args: [to, value, callData, []] });
}

// ── the whitelisted call = PolkadotXcm.send envelope around the approve batch ──
export function buildApproveCall(sweeper: Hex = SWEEPER): Hex {
  return wrapBatchInputInSend(buildApproveInput(sweeper));
}

async function main() {
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const approveCall = buildApproveCall();
    const proposal = wrapWhitelist(approveCall); // TC whitelists blake2(approveCall)

    const callBin = Binary.fromHex(approveCall);
    const registry: any = await nets.hydration.chain.head.registry;
    const approveHash = registry.hash(callBin as any).toHex() as Hex;

    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(callBin)).decodedCall;
      const instrs = dc.value.value.message.value.map((i: any) => i.type).join("/");
      decodeInfo = `${dc.type}.${dc.value.type} | dest=${JSON.stringify(dc.value.value.dest).slice(0, 60)} | instrs=${instrs}`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    console.log(`\n════════ approve-only sweeper proposal ════════`);
    console.log(`sweeper (spender) : ${SWEEPER}${process.env.SWEEPER ? "" : "  (PLACEHOLDER — set SWEEPER to the deployed addr)"}`);
    console.log(`tokens            : ${ASSETS.length} × approve(sweeper, MAX)`);
    console.log(`approve XCM call  : ${(approveCall.length - 2) / 2} bytes`);
    console.log(`blake2-256        : ${approveHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/approve-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "approve-only whitelisted proposal for the EOA-driven MrlSweeperHardcoded. Single call: "
        + "whitelist.dispatch_whitelisted_call_with_preimage(PolkadotXcm.send(Moonbeam, Transact{SA, batchAll([approve(sweeper,MAX)]×11)})). "
        + "Enacts as Root → SA emits the Moonbeam XCM → SA grants MAX approval to the sweeper for all 11 tokens. "
        + "Draining is then off-chain: the SA (governance) or the sweeper OWNER EOA calls sweeper.sweep(token)/sweepAmount(token,amount) "
        + "token-by-token, bal==0-safe, pacing amounts against the Wormhole Governor. Destinations are hardcoded in the sweeper (no redirect). "
        + "BEFORE SUBMIT: set SWEEPER to the deployed MrlSweeperHardcoded address (the approve spender must equal it), confirm the sweeper's "
        + "SA()/OWNER()/BRIDGE()/destOf immutables on-chain, and confirm ETH Safe (chain 2) + Sui msig (chain 21) recipients are final.",
      sweeper: SWEEPER,
      sweeperPlaceholder: !process.env.SWEEPER,
      tokens: ASSETS.map((a) => ({ sym: a.sym, id: a.id, token: getAddress(a.token) })),
      approveInput: buildApproveInput(),
      approveCall, approveHash,
      whitelistedProposal: proposal,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
}
