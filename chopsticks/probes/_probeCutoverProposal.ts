/**
 * Cutover-proposal test (Hydration-only fork — the cutover is fully local, so no Moonbeam needed).
 * Root-dispatches batch_all([update×11, withdraw]) and verifies every AssetLocation is repointed to
 * its WH-origin (X3) and the global withdraw limit is cut to 200M HDX / 6h.
 *
 *   pnpm tsx probes/_probeCutoverProposal.ts
 */
import { type Hex } from "viem";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { ASSETS } from "./exitAssets";
import { buildCutoverInner } from "./_buildCutoverProposal";
import { WH_ORIGIN, WH_GENERALKEY_DATA } from "./_buildSweepProposal";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hx = (x: any): string => x == null ? "" : typeof x === "string" ? x.toLowerCase()
  : typeof x?.asHex === "function" ? x.asHex().toLowerCase()
  : x instanceof Uint8Array ? "0x" + Buffer.from(x).toString("hex") : String(x).toLowerCase();

async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}

// AssetLocations(id) == WH origin: parents0 X3[GeneralKey("wh"), GeneralIndex(tokenChain), GeneralKey(tokenAddress)]
function isWhOrigin(loc: any, id: number): boolean {
  try {
    const [chain, addr] = WH_ORIGIN[id];
    const iv = loc?.interior;
    if (loc?.parents !== 0 || iv?.type !== "X3") return false;
    const [gk1, gi, gk2] = iv.value;
    return gk1?.type === "GeneralKey" && gk1.value?.length === 2 && hx(gk1.value?.data) === ("0x" + WH_GENERALKEY_DATA)
      && gi?.type === "GeneralIndex" && String(gi.value) === String(chain)
      && gk2?.type === "GeneralKey" && gk2.value?.length === 32 && hx(gk2.value?.data).toLowerCase() === addr.toLowerCase();
  } catch { return false; }
}

async function main() {
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  const api = hydration.client.getUnsafeApi();
  const registry: any = await hydration.chain.head.registry;
  const results: { pass: boolean; label: string }[] = [];
  const rec = (label: string, pass: boolean) => { results.push({ pass, label }); return pass; };

  try {
    console.log(`\n════════ cutover proposal test (local) ════════`);
    const inner = buildCutoverInner();
    const bytes = Binary.fromHex(inner); const len = bytes.length;
    const hash = registry.hash(bytes as any).toHex() as Hex;
    const when = hydration.chain.head.number + 1;
    console.log(`inner ${len} bytes, blake2 ${hash}`);

    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
      Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    const hb = await hydration.chain.newBlock();
    const he: any[] = await evAt(hydration, hb.hash);
    const disp = he.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
    rec("cutover dispatched Ok as Root", JSON.stringify(disp?.event?.value?.value?.result ?? {}).includes("success"));
    console.log(`  Scheduler.Dispatched: ${JSON.stringify(disp?.event?.value?.value?.result)}`);

    console.log(`\n── AssetLocations → WH-origin (11) ──`);
    let locAll = true;
    for (const a of ASSETS) {
      const loc = await api.query.AssetRegistry.AssetLocations.getValue(a.id);
      const ok = isWhOrigin(loc, a.id);
      locAll &&= ok;
      console.log(`  ${a.sym.padEnd(8)} id=${String(a.id).padEnd(8)} X3 WH-origin ${ok ? "✅" : "❌"}`);
    }
    rec("all 11 AssetLocations repointed to WH-origin", locAll);

    const cfg: any = await api.query.CircuitBreaker.GlobalWithdrawLimitConfig.getValue();
    const limit = BigInt(String(cfg?.limit ?? cfg?.[0] ?? 0));
    const window = Number(cfg?.window ?? cfg?.[1] ?? 0);
    const limitOk = limit === 200_000_000n * 10n ** 12n && window === 21_600_000;
    rec("global withdraw limit == 200M HDX / 6h (1/5)", limitOk);
    console.log(`\n── withdraw limit ── limit=${limit} window=${window}ms  ${limitOk ? "✅ (200M HDX / 6h)" : "❌"}`);

    console.log(`\n════════ VERDICT ════════`);
    for (const r of results) console.log(`  ${r.pass ? "PASS ✅" : "FAIL ❌"}  ${r.label}`);
    const ok = results.every((r) => r.pass);
    console.log(`\n${ok ? "ALL PASS ✅" : "FAILURES ❌"}`);
    process.exitCode = ok ? 0 : 1;
  } finally { await teardownForks(nets); }
}

main().catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
