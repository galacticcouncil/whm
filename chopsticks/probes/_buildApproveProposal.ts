/**
 * Build the APPROVE-ONLY whitelisted governance proposal — the ENABLING step of the EOA-sweeper flow.
 * It grants the standing SA→sweeper approval and NOTHING else:
 *
 *   whitelist.dispatch_whitelisted_call_with_preimage(          ← enacts as Root
 *     PolkadotXcm.send(Moonbeam, Xcm[ …Transact{ SovereignAccount,
 *       Batch precompile([ token.approve(sweeper, MAX) ] ×11) } ]))
 *
 * ⚠️ ASYNC — NOT ATOMIC WITH THE REMOTE RESULT. Local enactment only means the XCM was *dispatched*
 * from Hydration; it does NOT prove Moonbeam executed the 11 approves. Therefore this is deliberately
 * SPLIT from the local cutover (XCM-disconnect + withdraw-limit): after enactment you MUST verify on
 * Moonbeam that allowance(SA, sweeper) == MAX for all 11 tokens BEFORE draining and BEFORE running the
 * cutover proposal (_buildCutoverProposal.ts). Never sever routes / tighten limits on the strength of a
 * "batch succeeded" event — if the remote approve silently failed you'd be locked out near the sunset.
 *
 * Order:  1) deploy sweeper (CREATE2)  2) THIS proposal → enact → verify allowances on Moonbeam
 *         3) drain via EOA sweep (paced)  4) cutover proposal (disconnect + withdraw)  5) revoke approval
 *
 *   SWEEPER=0x… pnpm tsx probes/_buildApproveProposal.ts
 *
 * SWEEPER is REQUIRED (no placeholder default) — it MUST equal the deployed sweeper (the approve
 * spender). Precompute the deterministic CREATE2 address first:
 *   OWNER=0x… forge script contracts/script/DeployMrlSweeperHardcoded.s.sol   (prints `predicted (CREATE2)`)
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

/// probe-only fallback spender (allowance mechanics don't care about the exact address). Artifact
/// generation (main) REQUIRES a real SWEEPER — see requireSweeper().
export const SWEEPER = getAddress(process.env.SWEEPER ?? "0x00000000000000000000000000000000005A7EE9");
function requireSweeper(): Hex {
  const s = process.env.SWEEPER;
  if (!s) throw new Error("SWEEPER env REQUIRED — the deployed/CREATE2-predicted MrlSweeperHardcoded address (the approve spender). No placeholder default for artifact generation.");
  return getAddress(s);
}

// ── batchAll input = [ token.approve(sweeper, MAX) ] for all 11 MRL tokens (11 subcalls, no sweeps) ──
export function buildApproveInput(sweeper: Hex): Hex {
  const to: Hex[] = [], value: bigint[] = [], callData: Hex[] = [];
  const approve = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [sweeper, MAX_UINT] });
  for (const a of ASSETS) { to.push(getAddress(a.token)); value.push(0n); callData.push(approve); }
  return encodeFunctionData({ abi: BATCH_ABI, functionName: "batchAll", args: [to, value, callData, []] });
}

// ── the whitelisted call = PolkadotXcm.send envelope around the approve batch (approve-only) ──
export function buildApproveCall(sweeper: Hex): Hex {
  return wrapBatchInputInSend(buildApproveInput(sweeper));
}

async function main() {
  const sweeper = requireSweeper();
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const approveCall = buildApproveCall(sweeper);
    const proposal = wrapWhitelist(approveCall); // TC whitelists blake2(approveCall)

    const callBin = Binary.fromHex(approveCall);
    const registry: any = await nets.hydration.chain.head.registry;
    const approveHash = registry.hash(callBin as any).toHex() as Hex;

    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(callBin)).decodedCall;
      const instrs = dc.value.value.message.value.map((i: any) => i.type).join("/");
      decodeInfo = `${dc.type}.${dc.value.type} | dest=${JSON.stringify(dc.value.value.dest).slice(0, 55)} | instrs=${instrs}`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    console.log(`\n════════ approve-only (enabling) proposal ════════`);
    console.log(`sweeper (spender) : ${sweeper}`);
    console.log(`tokens            : ${ASSETS.length} × approve(sweeper, MAX)`);
    console.log(`approve XCM call  : ${(approveCall.length - 2) / 2} bytes`);
    console.log(`blake2-256        : ${approveHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);
    console.log(`\n⚠️  async: enactment only DISPATCHES the XCM. Verify allowance(SA,sweeper)==MAX on Moonbeam`);
    console.log(`   before draining and before the cutover proposal (_buildCutoverProposal.ts).`);

    const OUT = "probes/approve-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "APPROVE-ONLY (enabling) whitelisted proposal for the EOA sweeper — grants the standing SA→sweeper MAX approval and "
        + "NOTHING else. ⚠️ ASYNC: enacting only DISPATCHES the Moonbeam XCM; it does NOT prove the 11 approves executed. "
        + "This is deliberately SPLIT from the local cutover (XCM-disconnect + withdraw-limit, see cutover-proposal.json) so the "
        + "cutover can be gated on POST-ENACTMENT VERIFICATION that allowance(SA,sweeper)==MAX for all 11 tokens on Moonbeam. "
        + "Never sever routes / tighten limits on a 'batch succeeded' event alone. Order: deploy → THIS → verify allowances → "
        + "drain via EOA sweep → cutover proposal → revoke approval. SWEEPER is the CREATE2-deterministic MrlSweeperHardcoded "
        + "address and MUST equal the deployed sweeper. BEFORE SUBMIT: regenerate with the FINAL sweeper address; confirm the "
        + "sweeper's SA()/OWNER()/BRIDGE()/destOf on-chain; confirm the 11 tokens are registered on the Moonbeam token bridge.",
      sweeper,
      sweeperIsCreate2Predicted: true,
      async: true,
      tokens: ASSETS.map((a) => ({ sym: a.sym, id: a.id, token: getAddress(a.token) })),
      approveInput: buildApproveInput(sweeper),
      approveCall, approveHash,
      whitelistedProposal: proposal,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
}
