/**
 * Build the EOA-sweeper SUNSET whitelisted governance proposal. This is the only on-chain
 * governance step of the live (MrlSweeperHardcoded) flow. It enacts as Root and is a batch_all of:
 *
 *   1. PolkadotXcm.send(Moonbeam, Xcm[ …Transact{ SovereignAccount,
 *        Batch precompile([ token.approve(sweeper, MAX) ] ×11) } ])   ← standing SA→sweeper approval
 *   2. AssetRegistry.update(id, location = WH-origin) ×11              ← XCM-disconnect (see _buildSweepProposal)
 *   3. CircuitBreaker.set_global_withdraw_limit_params(200M HDX / 6h)  ← withdraw-limit cut to 1/5
 *
 * After enactment the SA holds a MAX approval to the sweeper for all 11 tokens; draining is then
 * off-chain — the SA (governance) or the sweeper OWNER EOA calls sweeper.sweep(token)/sweepAmount()
 * token-by-token (bal==0-safe, dust stays in the SA), pacing amounts against the Wormhole Governor.
 * Destinations are hardcoded in the sweeper (no redirect).
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
import { wrapBatchInputInSend, wrapWhitelist, batchAllCall, buildLocationUpdate, buildWithdrawLimit } from "./_buildSweepProposal";

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

// ── the approve XCM send (PolkadotXcm.send envelope around the approve batch) ──
export function buildApproveCall(sweeper: Hex): Hex {
  return wrapBatchInputInSend(buildApproveInput(sweeper));
}

// ── full sunset inner: batch_all([ approveSend, update×11, withdraw ]) ──
export function buildApproveInner(sweeper: Hex): Hex {
  const approveCall = buildApproveCall(sweeper);
  const updates = ASSETS.map((a) => buildLocationUpdate(a.id));
  const withdraw = buildWithdrawLimit();
  return batchAllCall([approveCall, ...updates, withdraw]);
}

async function main() {
  const sweeper = requireSweeper();
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const inner = buildApproveInner(sweeper);
    const proposal = wrapWhitelist(inner); // TC whitelists blake2(inner)

    const innerBin = Binary.fromHex(inner);
    const registry: any = await nets.hydration.chain.head.registry;
    const innerHash = registry.hash(innerBin as any).toHex() as Hex;

    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(innerBin)).decodedCall;
      const calls = dc.value.value.calls;
      const c0 = calls[0];
      const instrs = c0.value.value.message.value.map((i: any) => i.type).join("/");
      const updCount = calls.filter((c: any) => c.type === "AssetRegistry" && c.value.type === "update").length;
      const cb = calls.find((c: any) => c.type === "CircuitBreaker");
      decodeInfo = `${dc.type}.${dc.value.type}[${calls.length} calls: ${c0.value.type}, update×${updCount}, ${cb?.value?.type ?? "—"}] | approve XCM instrs=${instrs}`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    console.log(`\n════════ EOA-sweeper sunset proposal ════════`);
    console.log(`sweeper (spender) : ${sweeper}`);
    console.log(`inner batch_all   : ${innerBin.length} bytes  (1 approve-send + 11 updates + 1 withdraw = 13 calls)`);
    console.log(`inner blake2-256  : ${innerHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/approve-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "EOA-sweeper SUNSET whitelisted proposal (live design). batch_all([ PolkadotXcm.send(Moonbeam, Transact{SA, "
        + "batchAll([approve(sweeper,MAX)]×11)}), AssetRegistry.update(id, WH-origin)×11, CircuitBreaker.set_global_withdraw_limit_params(200M HDX/6h) ]). "
        + "Enacts as Root → SA grants MAX approval to the sweeper + XCM-disconnect + withdraw-limit cut, all atomically. Draining is then off-chain: "
        + "the SA or the sweeper OWNER EOA calls sweeper.sweep(token)/sweepAmount(token,amount), bal==0-safe, dust stays in the SA, pacing vs the Wormhole Governor. "
        + "SWEEPER here is the CREATE2-deterministic MrlSweeperHardcoded address; the approve spender MUST equal the deployed sweeper. "
        + "BEFORE SUBMIT: (1) regenerate with the FINAL sweeper address (SWEEPER=<CREATE2 predicted for final OWNER/salt/recipients>); "
        + "(2) confirm the deployed sweeper's SA()/OWNER()/BRIDGE()/destOf on-chain; (3) confirm ETH Safe (chain 2) live on Ethereum mainnet + Sui msig (chain 21) final; "
        + "(4) plan the post-drain approve-revoke (approve(sweeper,0)×11).",
      sweeper,
      sweeperIsCreate2Predicted: true,
      tokens: ASSETS.map((a) => ({ sym: a.sym, id: a.id, token: getAddress(a.token) })),
      approveInput: buildApproveInput(sweeper),
      approveCall: buildApproveCall(sweeper),
      innerBatchAll: inner,
      innerHash,
      whitelistedProposal: proposal,
    }, null, 2));
    console.log(`\nwrote ${OUT}`);
  } finally { await teardownForks(nets); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
}
