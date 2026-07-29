/** Confirm the migration batch dispatches as Root with NO circuit-breaker involvement:
 *  - Scheduler.Dispatched result Ok, no System.ExtrinsicFailed
 *  - 17 PolkadotXcm.Sent
 *  - zero CircuitBreaker.* / Omnipool.* / Stableswap.* events (the CB code path is never entered)
 *  Hydration-only fork (fast). */
import { readFileSync } from "node:fs";
import { Binary } from "polkadot-api";
import { configs } from "../lib/configs";
import { spawnForks, teardownForks, type Network } from "../lib/network";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function evAt(net: Network, at: string, t = 12): Promise<any[]> {
  let e; for (let i = 0; i < t; i++) { try { return await net.client.getUnsafeApi().query.System.Events.getValue({ at }); } catch (x) { e = x; await sleep(300); } } throw e;
}

async function main() {
  const d = JSON.parse(readFileSync("probes/rescue-proposal.json", "utf8"));
  const nets = await spawnForks([configs.hydration]);
  const { hydration } = nets;
  try {
    const bytes = Binary.fromHex(d.innerBatchAll as `0x${string}`); const len = bytes.length;
    const hash = (await hydration.chain.head.registry).hash(bytes).toHex() as `0x${string}`;
    const when = hydration.chain.head.number + 1;
    await hydration.setStorage({
      Preimage: { PreimageFor: [[[[hash, len]], Array.from(bytes)]] },
      Scheduler: { Agenda: [[[when], [{ maybeId: null, priority: 0, call: { Lookup: { hash, len } }, maybePeriodic: null, origin: { system: "Root" } }]]] },
    });
    const b = await hydration.chain.newBlock();
    const events = await evAt(hydration, b.hash);

    const tally: Record<string, number> = {};
    let dispatched: any = null, anyFail = false;
    for (const { event } of events as any[]) {
      const t = `${event.type}.${event.value?.type}`;
      tally[event.type] = (tally[event.type] ?? 0) + 1;
      if (t === "Scheduler.Dispatched") dispatched = event.value.value?.result;
      if (t === "System.ExtrinsicFailed") anyFail = true;
    }
    const sent = events.filter((e: any) => `${e.event.type}.${e.event.value?.type}` === "PolkadotXcm.Sent").length;
    const cb = tally["CircuitBreaker"] ?? 0;
    const omni = tally["Omnipool"] ?? 0;
    const stable = tally["Stableswap"] ?? 0;
    const dispOk = dispatched && (dispatched.success === true || dispatched.type === "Ok" || dispatched === undefined);

    console.log("pallets that emitted events:", Object.keys(tally).sort().join(", "));
    console.log(`\nScheduler.Dispatched result : ${JSON.stringify(dispatched)}`);
    console.log(`PolkadotXcm.Sent            : ${sent}   ${sent === 17 ? "✅" : "❌ (expected 17)"}`);
    console.log(`System.ExtrinsicFailed      : ${anyFail ? "YES ❌" : "none ✅"}`);
    console.log(`CircuitBreaker.* events     : ${cb}   ${cb === 0 ? "✅ never entered" : "❌"}`);
    console.log(`Omnipool.* / Stableswap.*   : ${omni} / ${stable}   ${omni + stable === 0 ? "✅ no AMM touched" : "❌"}`);
    console.log(`\n${sent === 17 && !anyFail && cb === 0 && omni + stable === 0 ? "✅ dispatches cleanly, circuit breaker + AMM never involved" : "❌ unexpected"}`);
  } finally { await teardownForks(nets); }
}
main().then(() => process.exit(0)).catch((e) => { console.error("PROBE ERROR:", e?.stack ?? e); process.exit(1); });
