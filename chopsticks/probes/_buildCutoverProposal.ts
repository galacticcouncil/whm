/**
 * Build the CUTOVER whitelisted governance proposal — the LOCAL Hydration sunset step, split from the
 * (async, cross-chain) approve proposal so it can be gated on post-enactment allowance verification.
 *
 *   whitelist.dispatch_whitelisted_call_with_preimage(          ← enacts as Root
 *     Utility.batch_all([
 *       AssetRegistry.update(id, location = WH-origin) ×11,      ← XCM-disconnect (parents:0 X3 WH provenance)
 *       CircuitBreaker.set_global_withdraw_limit_params(200M HDX / 6h),  ← withdraw-limit cut to 1/5
 *     ]))
 *
 * Every call here is LOCAL to Hydration ⇒ batch_all is genuinely atomic (no fire-and-forget XCM).
 * Deterministic (no sweeper address, no BLOCK_N) ⇒ safe to commit.
 *
 * RUN ONLY AFTER: the approve proposal enacted AND allowance(SA,sweeper)==MAX verified on Moonbeam
 * (ideally after draining). This severs stale-UI XCM routes and tightens withdraw limits — do not run
 * it until the drain path is confirmed working, or you can lock yourself out near the sunset.
 *
 *   pnpm tsx probes/_buildCutoverProposal.ts
 */
import { writeFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { Binary } from "polkadot-api";
import { spawnForks, teardownForks } from "../lib/network";
import { configs } from "../lib/configs";
import { ASSETS } from "./exitAssets";
import { batchAllCall, buildLocationUpdate, buildWithdrawLimit, wrapWhitelist, whOriginShape, WH_ORIGIN } from "./_buildSweepProposal";

export function buildCutoverInner(): Hex {
  const updates = ASSETS.map((a) => buildLocationUpdate(a.id));
  return batchAllCall([...updates, buildWithdrawLimit()]);
}

async function main() {
  const nets = await spawnForks([configs.hydration]);
  try {
    const api = nets.hydration.client.getUnsafeApi();
    const inner = buildCutoverInner();
    const proposal = wrapWhitelist(inner);

    const innerBin = Binary.fromHex(inner);
    const registry: any = await nets.hydration.chain.head.registry;
    const innerHash = registry.hash(innerBin as any).toHex() as Hex;
    const withdraw = buildWithdrawLimit();

    let decodeInfo = "";
    try {
      const dc: any = (await api.txFromCallData(innerBin)).decodedCall;
      const calls = dc.value.value.calls;
      const updCount = calls.filter((c: any) => c.type === "AssetRegistry" && c.value.type === "update").length;
      const updIds = calls.filter((c: any) => c.type === "AssetRegistry").map((c: any) => c.value?.value?.asset_id).join(",");
      const cb = calls.find((c: any) => c.type === "CircuitBreaker");
      decodeInfo = `${dc.type}.${dc.value.type}[${calls.length} calls: update×${updCount}, ${cb?.value?.type ?? "—"}] | asset_ids=[${updIds}]`;
    } catch (e: any) { decodeInfo = "DECODE FAILED: " + (e?.message ?? e); }

    console.log(`\n════════ cutover proposal (LOCAL, atomic) ════════`);
    console.log(`inner batch_all   : ${innerBin.length} bytes  (11 updates + 1 withdraw = 12 calls)`);
    console.log(`inner blake2-256  : ${innerHash}   ← TC whitelists this`);
    console.log(`whitelisted call  : ${(proposal.length - 2) / 2} bytes`);
    console.log(`self-decode       : ${decodeInfo}`);

    const OUT = "probes/cutover-proposal.json";
    writeFileSync(OUT, JSON.stringify({
      note: "CUTOVER whitelisted proposal (LOCAL Hydration, genuinely atomic). batch_all([ AssetRegistry.update(id, WH-origin)×11, "
        + "CircuitBreaker.set_global_withdraw_limit_params(200M HDX / 6h = 1/5 of live) ]). Repoints each MRL asset to its canonical "
        + "parents:0 X3[GeneralKey('wh'), GeneralIndex(tokenChain), GeneralKey(tokenAddress)] provenance (no Moonbeam reserve ⇒ stale-UI "
        + "XTokens.transfer rejects atomically with AssetHasNoReserve) and cuts the global withdraw limit to 1/5. Split from the (async) "
        + "approve proposal on purpose. RUN ONLY AFTER the approve enacted AND allowance(SA,sweeper)==MAX verified on Moonbeam (ideally "
        + "after draining) — this severs routes and must not precede a confirmed drain path.",
      withdrawLimit: {
        call: withdraw, limitRaw: (200_000_000n * 10n ** 12n).toString(), limitHDX: "200,000,000 HDX", windowMs: 21_600_000,
        note: "1/5 of live 1,000,000,000 HDX / 6h",
      },
      locationUpdates: ASSETS.map((a) => ({
        id: a.id, sym: a.sym, tokenChain: WH_ORIGIN[a.id][0], tokenAddress: WH_ORIGIN[a.id][1],
        whOrigin: whOriginShape(a.id), updateCall: buildLocationUpdate(a.id),
      })),
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
