/**
 * Governance-half test for the EOA sweeper flow (Hydration + Moonbeam fork).
 * Root-dispatches the approve-only whitelisted call → SA emits the Moonbeam XCM →
 * verifies the SA granted MAX approval to the sweeper for all 11 MRL tokens.
 * (The sweep logic itself is covered by the forge suite MrlSweeperHardcoded.t.sol.)
 *
 *   pnpm tsx probes/_probeApproveProposal.ts
 */
import { createPublicClient, http, erc20Abi, getAddress, type Hex, type PublicClient } from "viem";
import { Binary } from "polkadot-api";
import { acc } from "@galacticcouncil/common";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";
import { ASSETS } from "./exitAssets";
import { buildApproveCall, SWEEPER } from "./_buildApproveProposal";

const SA = getAddress(acc.getSovereignAccounts(2034).moonbeam as Hex);
const MAX_UINT = (1n << 256n) - 1n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}

async function main() {
  const nets = await spawnForks([configs.hydration, configs.moonbeam]);
  const { hydration, moonbeam } = nets;
  const eth = createPublicClient({ transport: http(`http://127.0.0.1:${configs.moonbeam.port}`) }) as PublicClient;
  const registry: any = await hydration.chain.head.registry;
  const results: { pass: boolean; label: string }[] = [];
  const rec = (label: string, pass: boolean) => { results.push({ pass, label }); return pass; };
  const allowance = (tok: Hex) => eth.readContract({ address: tok, abi: erc20Abi, functionName: "allowance", args: [SA, SWEEPER] }) as Promise<bigint>;

  try {
    console.log(`\n════════ approve-only proposal test ════════`);
    console.log(`SA=${SA}  sweeper(spender)=${SWEEPER}`);

    // 1. seed SA GLMR (Transact gas)
    await moonbeam.setStorage({ System: { Account: [[[SA], { providers: 1, data: { free: 20000n * 10n ** 18n } }]] } });

    // 2. allowances BEFORE (expect ~0)
    const before: Record<string, bigint> = {};
    for (const a of ASSETS) before[a.sym] = await allowance(getAddress(a.token));

    // 3. Root-dispatch the approve XCM (Preimage + Scheduler.Agenda, Root origin)
    const call = buildApproveCall();
    const bytes = Binary.fromHex(call); const len = bytes.length;
    const hash = registry.hash(bytes as any).toHex() as Hex;
    const when = hydration.chain.head.number + 1;
    console.log(`\n── Root-dispatch approve XCM  (${len} bytes, blake2 ${hash}) ──`);
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
      Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    const hb = await hydration.chain.newBlock();
    const he: any[] = await evAt(hydration, hb.hash);
    const disp = he.find((e: any) => e.event?.type === "Scheduler" && e.event?.value?.type === "Dispatched");
    const dispOk = JSON.stringify(disp?.event?.value?.value?.result ?? {}).includes("success");
    console.log(`  Scheduler.Dispatched: ${JSON.stringify(disp?.event?.value?.value?.result)}`);
    rec("approve XCM dispatched Ok as Root", dispOk);
    await hydration.newBlock(); // flush HRMP out of Hydration

    // 4. process the incoming HRMP on Moonbeam (seal a few blocks)
    for (let i = 0; i < 6; i++) await moonbeam.chain.newBlock();
    await sleep(300);

    // 5. allowances AFTER (expect MAX for all 11)
    console.log(`\n── allowance(SA → sweeper) AFTER (11 MRL tokens) ──`);
    let allSet = true;
    for (const a of ASSETS) {
      const after = await allowance(getAddress(a.token));
      const ok = after === MAX_UINT;
      allSet &&= ok;
      console.log(`  ${a.sym.padEnd(8)} ${before[a.sym]} → ${after === MAX_UINT ? "MAX" : after}  ${ok ? "✅" : "❌"}`);
    }
    rec("all 11 tokens: SA→sweeper allowance == MAX", allSet);

    console.log(`\n════════ VERDICT ════════`);
    for (const r of results) console.log(`  ${r.pass ? "PASS ✅" : "FAIL ❌"}  ${r.label}`);
    const ok = results.every((r) => r.pass);
    console.log(`\n${ok ? "ALL PASS ✅" : "FAILURES ❌"}`);
    process.exitCode = ok ? 0 : 1;
  } finally { await teardownForks(nets); }
}

main().catch((e) => { console.error("ERR:", e?.stack ?? e); process.exit(1); });
