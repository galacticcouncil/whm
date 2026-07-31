/** Verify the ENACTED initial-sweep proposal against LIVE state (no fork):
 *   Moonbeam  — SA balance per token (drained to ≤8dp dust?) + allowance(SA→sweeper)=MAX (backstop live?)
 *   Hydration — each asset's XCM location severed to WH-origin (X3[wh, chain, tokenAddr])?
 *
 *   pnpm tsx probes/_verifySweepEnacted.ts
 */
import { createPublicClient, http, erc20Abi, getAddress, type Hex } from "viem";
import { getWsProvider } from "polkadot-api/ws";
import { createClient } from "polkadot-api";
import { acc } from "@galacticcouncil/common";
import { ASSETS } from "./exitAssets";

const SWEEPER = getAddress("0x7120402b1A9FEaa2b5139A2bF0c81832d5615505");
const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const MAX = (1n << 256n) - 1n;
const MOONBEAM_RPC = process.env.MOONBEAM_RPC ?? "https://rpc.api.moonbeam.network";
const HYD_WS = process.env.HYD_WS ?? "wss://rpc.hydradx.cloud";

const fmt = (v: bigint, d: number) => {
  const s = v.toString().padStart(d + 1, "0");
  return `${s.slice(0, -d) || "0"}.${s.slice(-d).replace(/0+$/, "") || "0"}`;
};

async function main() {
  console.log(`SA (Hydration sovereign on Moonbeam): ${SA}`);
  console.log(`sweeper: ${SWEEPER}\n`);

  // ── Moonbeam: balances + allowances ──
  const mb = createPublicClient({ transport: http(MOONBEAM_RPC) });
  const bn = await mb.getBlockNumber();
  console.log(`════ Moonbeam @ block ${bn} ════`);
  let drained = 0, backstop = 0;
  for (const a of ASSETS) {
    const token = getAddress(a.token);
    const [bal, allo] = await Promise.all([
      mb.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [SA] }),
      mb.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [SA, SWEEPER] }),
    ]);
    // dust = below 8dp floor the sweeper can't move (Wormhole trims to 8dp)
    const floor = 10n ** BigInt(Math.max(0, a.decimals - 8));
    const isDust = bal < floor;
    // approve(MAX) decrements on transferFrom for these tokens, so it won't stay ==MAX;
    // backstop is "live" as long as the remaining allowance still dwarfs any conceivable balance.
    const alloLive = allo > 10n ** BigInt(a.decimals + 18);
    if (isDust) drained++;
    if (alloLive) backstop++;
    console.log(`  ${a.sym.padEnd(8)} bal=${fmt(bal, a.decimals).padEnd(24)} ${isDust ? "drained✅" : "HELD ❌"}  allowance=${allo === MAX ? "MAX✅" : alloLive ? "~MAX✅" : allo === 0n ? "0 ❌" : fmt(allo, a.decimals)}`);
  }
  console.log(`  → drained ${drained}/11, backstop-allowance live ${backstop}/11\n`);

  // ── Hydration: severed from XCM? ──
  const client = createClient(getWsProvider([HYD_WS]));
  const api = client.getUnsafeApi();
  const finalized = await client.getFinalizedBlock();
  console.log(`════ Hydration @ block ${finalized.number} ════`);
  let severed = 0;
  for (const a of ASSETS) {
    const loc: any = await api.query.AssetRegistry.AssetLocations.getValue(a.id);
    const j = JSON.stringify(loc ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).toLowerCase();
    // WH-origin sever = X3 with a general_key "wh" (0x7768) + general_index(chain)
    const isSevered = j.includes("7768") || j.includes('"wh"');
    if (isSevered) severed++;
    console.log(`  ${a.sym.padEnd(8)} id=${String(a.id).padEnd(8)} ${isSevered ? "severed✅ (WH-origin)" : "still-XCM ❌"}  ${j.slice(0, 90)}`);
  }
  console.log(`  → severed ${severed}/11`);

  client.destroy();
  console.log(`\n${drained === 11 && severed === 11 ? "SWEEP ENACTED ✅ (drained + severed)" : "PARTIAL — see above"}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
